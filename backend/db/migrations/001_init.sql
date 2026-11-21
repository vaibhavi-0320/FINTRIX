-- Fintrix initial schema. Runs on PostgreSQL 15+ and PGlite (embedded Postgres).
-- Conventions: money in integer minor units (cents); on-chain amounts as decimal
-- strings (stroops can exceed int range); calendar dates as ISO text (YYYY-MM-DD).

CREATE EXTENSION IF NOT EXISTS vector;

-- ------------------------------------------------------------------ identity
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stellar_address TEXT NOT NULL UNIQUE CHECK (stellar_address ~ '^G[A-Z2-7]{55}$'),
  display_name    TEXT CHECK (char_length(display_name) <= 80),
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);

-- One-time sign-in challenges (SEP-53 signed messages).
CREATE TABLE auth_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address     TEXT NOT NULL CHECK (address ~ '^G[A-Z2-7]{55}$'),
  nonce       TEXT NOT NULL UNIQUE,
  message     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_challenges_address ON auth_challenges (address, created_at DESC);

-- Server-side sessions. Only a SHA-256 hash of the cookie token is stored.
CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- ------------------------------------------------------------------ documents
CREATE TABLE documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  filename      TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200),
  mime_type     TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256        TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content       BYTEA NOT NULL,
  extracted_text TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, sha256)
);
CREATE INDEX idx_documents_sha ON documents (sha256);

-- AI/OCR extraction results. Never treated as verified until a human reviews them.
CREATE TABLE extractions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  engine            TEXT NOT NULL,          -- e.g. 'claude:claude-opus-5-5', 'local:pdf-text', 'local:tesseract'
  status            TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  fields            JSONB,                  -- structured invoice fields as extracted
  confidence        JSONB,                  -- per-field confidence 0..1
  issues            JSONB NOT NULL DEFAULT '[]'::jsonb,
  error             TEXT,
  reviewed_fields   JSONB,                  -- fields after human correction
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_extractions_document ON extractions (document_id, created_at DESC);

-- ------------------------------------------------------------------ invoices
CREATE TABLE invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id          UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  document_id        UUID REFERENCES documents (id) ON DELETE SET NULL,
  extraction_id      UUID REFERENCES extractions (id) ON DELETE SET NULL,
  invoice_number     TEXT NOT NULL CHECK (char_length(invoice_number) BETWEEN 1 AND 64),
  issuer_name        TEXT NOT NULL CHECK (char_length(issuer_name) BETWEEN 1 AND 160),
  buyer_name         TEXT NOT NULL CHECK (char_length(buyer_name) BETWEEN 1 AND 160),
  buyer_country      TEXT CHECK (buyer_country IS NULL OR buyer_country ~ '^[A-Z]{2}$'),
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  issue_date         TEXT NOT NULL CHECK (issue_date ~ '^\d{4}-\d{2}-\d{2}$'),
  due_date           TEXT NOT NULL CHECK (due_date ~ '^\d{4}-\d{2}-\d{2}$'),
  subtotal_cents     INTEGER CHECK (subtotal_cents IS NULL OR subtotal_cents >= 0),
  tax_cents          INTEGER CHECK (tax_cents IS NULL OR tax_cents >= 0),
  total_cents        INTEGER NOT NULL CHECK (total_cents > 0),
  line_items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Financing terms
  advance_rate_bps   INTEGER NOT NULL DEFAULT 9000 CHECK (advance_rate_bps BETWEEN 5000 AND 10000),
  discount_bps       INTEGER NOT NULL CHECK (discount_bps BETWEEN 0 AND 3000),
  -- On-chain settlement terms (decimal strings in the settlement asset, e.g. XLM)
  settlement_asset   TEXT NOT NULL DEFAULT 'XLM',
  price_amount       TEXT,                  -- what the investor pays
  repayment_amount   TEXT,                  -- what the seller repays
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'listed', 'funded', 'repaid', 'settled', 'cancelled', 'defaulted')),
  contract_id        TEXT,
  chain_invoice_id   TEXT,                  -- u64 id assigned by the Soroban contract
  document_hash      TEXT CHECK (document_hash IS NULL OR document_hash ~ '^[0-9a-f]{64}$'),
  investor_id        UUID REFERENCES users (id) ON DELETE SET NULL,
  risk_score         REAL CHECK (risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 1)),
  risk_model         TEXT,
  risk_factors       JSONB,
  duplicate_flags    JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_demo            BOOLEAN NOT NULL DEFAULT false,
  notes              TEXT CHECK (notes IS NULL OR char_length(notes) <= 1000),
  listed_at          TIMESTAMPTZ,
  funded_at          TIMESTAMPTZ,
  repaid_at          TIMESTAMPTZ,
  settled_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (seller_id, invoice_number),
  UNIQUE (contract_id, chain_invoice_id),
  CHECK (due_date >= issue_date)
);
CREATE INDEX idx_invoices_status ON invoices (status, created_at DESC);
CREATE INDEX idx_invoices_seller ON invoices (seller_id, created_at DESC);
CREATE INDEX idx_invoices_investor ON invoices (investor_id);
CREATE INDEX idx_invoices_buyer ON invoices (lower(buyer_name));
CREATE INDEX idx_invoices_document_hash ON invoices (document_hash);

-- ------------------------------------------------------------------ blockchain
-- Transactions the server prepared for a user to sign. The submit endpoint only
-- accepts a signed envelope whose hash equals the prepared hash.
CREATE TABLE chain_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  invoice_id    UUID REFERENCES invoices (id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('create', 'fund', 'repay', 'claim', 'cancel', 'default')),
  network       TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  tx_hash       TEXT NOT NULL UNIQUE CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  status        TEXT NOT NULL DEFAULT 'prepared'
                CHECK (status IN ('prepared', 'submitted', 'success', 'failed', 'expired')),
  amount        TEXT,
  asset         TEXT,
  ledger        INTEGER,
  result        JSONB,
  error         TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at  TIMESTAMPTZ,
  confirmed_at  TIMESTAMPTZ
);
CREATE INDEX idx_chain_tx_user ON chain_transactions (user_id, created_at DESC);
CREATE INDEX idx_chain_tx_invoice ON chain_transactions (invoice_id, created_at DESC);

-- ------------------------------------------------------------------ assistant
CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'New conversation' CHECK (char_length(title) <= 120),
  audience    TEXT NOT NULL DEFAULT 'user' CHECK (audience IN ('user', 'beginner', 'developer', 'investor', 'judge')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_user ON conversations (user_id, updated_at DESC);

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL CHECK (char_length(content) <= 40000),
  sources          JSONB NOT NULL DEFAULT '[]'::jsonb,
  followups        JSONB NOT NULL DEFAULT '[]'::jsonb,
  model            TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  status           TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'error', 'interrupted')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);

-- Knowledge base for retrieval-augmented generation.
CREATE TABLE kb_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kb_chunks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      UUID NOT NULL REFERENCES kb_documents (id) ON DELETE CASCADE,
  chunk_index      INTEGER NOT NULL,
  heading          TEXT NOT NULL,
  content          TEXT NOT NULL,
  embedding        vector,
  embedding_model  TEXT,
  tsv              tsvector GENERATED ALWAYS AS (to_tsvector('english', heading || ' ' || content)) STORED,
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX idx_kb_chunks_tsv ON kb_chunks USING GIN (tsv);

-- ------------------------------------------------------------------ platform
-- Fixed-window rate-limit counters (shared across serverless instances).
CREATE TABLE rate_limits (
  key        TEXT PRIMARY KEY,
  hits       INTEGER NOT NULL,
  reset_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_user ON audit_log (user_id, created_at DESC);
