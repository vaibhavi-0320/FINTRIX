import crypto from "crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { getConfig } from "../../config";
import { getDb } from "../../db";
import { HttpError } from "../../errors";
import { audit } from "../../audit";

export const SESSION_COOKIE = "fintrix_session";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface SessionUser {
  id: string;
  stellarAddress: string;
  displayName: string | null;
  role: "user" | "admin";
  sessionId: string;
}

export function sha256Hex(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Builds the human-readable SEP-53 message the wallet shows before signing. */
export function buildSignInMessage(input: { address: string; domain: string; nonce: string; issuedAt: Date; expiresAt: Date }) {
  const { passphrase } = getConfig().stellar;
  return [
    `${input.domain} wants you to sign in to Fintrix with your Stellar account:`,
    input.address,
    "",
    "Signing proves you control this account. It does not authorize any payment or transaction.",
    "",
    `Network: ${passphrase}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
  ].join("\n");
}

export async function createChallenge(address: string, domain: string) {
  if (!StrKey.isValidEd25519PublicKey(address)) throw new HttpError(400, "Invalid Stellar public key.");
  const db = await getDb();
  const nonce = crypto.randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const message = buildSignInMessage({ address, domain, nonce, issuedAt, expiresAt });
  await db.query(`INSERT INTO auth_challenges (address, nonce, message, expires_at) VALUES ($1, $2, $3, $4)`, [address, nonce, message, expiresAt]);
  return { nonce, message, expiresAt: expiresAt.toISOString() };
}

/**
 * Wallets return the signature in different encodings (Freighter v4+: base64 string,
 * v3: Buffer serialised as {type,data} or bytes, some tools: hex). Normalise to 64 raw bytes.
 */
export function decodeSignature(signature: unknown): Buffer | null {
  if (typeof signature === "string") {
    const trimmed = signature.trim();
    if (/^[0-9a-fA-F]{128}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
    const decoded = Buffer.from(trimmed, "base64");
    return decoded.length === 64 ? decoded : null;
  }
  if (signature && typeof signature === "object" && Array.isArray((signature as { data?: unknown }).data)) {
    const bytes = Buffer.from((signature as { data: number[] }).data);
    return bytes.length === 64 ? bytes : null;
  }
  if (Array.isArray(signature)) {
    const bytes = Buffer.from(signature as number[]);
    return bytes.length === 64 ? bytes : null;
  }
  return null;
}

/** SEP-53 (prefixed + SHA-256) is the standard; a raw-message signature over the exact challenge is also accepted. */
export function verifyMessageSignature(address: string, message: string, signature: Buffer) {
  const keypair = Keypair.fromPublicKey(address);
  try {
    if (keypair.verifyMessage(message, signature)) return true;
  } catch {
    // fall through to raw verification
  }
  try {
    return keypair.verify(Buffer.from(message, "utf8"), signature);
  } catch {
    return false;
  }
}

/**
 * Albedo's sign_message intent signs a message it derives from the public key and our
 * challenge, and returns those exact bytes (`signed_message`, hex). We accept it only if
 * the bytes contain both the challenge message and the address, and the signature verifies.
 */
export function verifyAlbedoSignature(address: string, challengeMessage: string, signedMessageHex: string, signature: Buffer) {
  if (!/^[0-9a-fA-F]+$/.test(signedMessageHex) || signedMessageHex.length % 2 !== 0) return false;
  const payload = Buffer.from(signedMessageHex, "hex");
  const text = payload.toString("utf8");
  if (!text.includes(challengeMessage) || !text.includes(address)) return false;
  const keypair = Keypair.fromPublicKey(address);
  try {
    if (keypair.verify(payload, signature)) return true;
    return keypair.verify(crypto.createHash("sha256").update(payload).digest(), signature);
  } catch {
    return false;
  }
}

export async function verifyChallengeAndCreateSession(input: { address: string; nonce: string; signature: unknown; signedMessage?: string; userAgent?: string }) {
  const db = await getDb();
  const signature = decodeSignature(input.signature);
  if (!signature) throw new HttpError(400, "Signature is not a valid ed25519 signature.");

  return db.transaction(async (tx) => {
    // Consume the challenge atomically so it can never be replayed.
    const { rows } = await tx.query<{ message: string }>(
      `UPDATE auth_challenges SET consumed_at = now()
        WHERE address = $1 AND nonce = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING message`,
      [input.address, input.nonce],
    );
    const challenge = rows[0];
    if (!challenge) throw new HttpError(401, "Sign-in challenge is invalid, expired or already used. Request a new one.");
    const valid = input.signedMessage
      ? verifyAlbedoSignature(input.address, challenge.message, input.signedMessage, signature)
      : verifyMessageSignature(input.address, challenge.message, signature);
    if (!valid) {
      throw new HttpError(401, "Signature does not match this wallet. Make sure you signed with the account you connected.");
    }

    const userResult = await tx.query<{ id: string; stellar_address: string; display_name: string | null; role: "user" | "admin" }>(
      `INSERT INTO users (stellar_address, last_login_at) VALUES ($1, now())
       ON CONFLICT (stellar_address) DO UPDATE SET last_login_at = now()
       RETURNING id, stellar_address, display_name, role`,
      [input.address],
    );
    const user = userResult.rows[0];

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + getConfig().SESSION_TTL_HOURS * 3600 * 1000);
    const session = await tx.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.id, sha256Hex(token), input.userAgent?.slice(0, 300) ?? null, expiresAt],
    );
    await audit(tx, user.id, "auth.sign_in", "session", session.rows[0].id);

    return {
      token,
      expiresAt,
      user: { id: user.id, stellarAddress: user.stellar_address, displayName: user.display_name, role: user.role, sessionId: session.rows[0].id } satisfies SessionUser,
    };
  });
}

export async function getSessionUser(token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const db = await getDb();
  const { rows } = await db.query<{ session_id: string; id: string; stellar_address: string; display_name: string | null; role: "user" | "admin" }>(
    `UPDATE sessions s SET last_seen_at = now()
       FROM users u
      WHERE s.token_hash = $1 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()
      RETURNING s.id AS session_id, u.id, u.stellar_address, u.display_name, u.role`,
    [sha256Hex(token)],
  );
  const row = rows[0];
  return row ? { id: row.id, stellarAddress: row.stellar_address, displayName: row.display_name, role: row.role, sessionId: row.session_id } : null;
}

export async function revokeSession(sessionId: string) {
  const db = await getDb();
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

export async function revokeAllSessions(userId: string) {
  const db = await getDb();
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

export async function listSessions(userId: string) {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; user_agent: string | null; created_at: Date; last_seen_at: Date; expires_at: Date }>(
    `SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    userAgent: row.user_agent,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  }));
}

export async function updateProfile(userId: string, displayName: string | null) {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; stellar_address: string; display_name: string | null; role: "user" | "admin"; created_at: Date }>(
    `UPDATE users SET display_name = $2 WHERE id = $1 RETURNING id, stellar_address, display_name, role, created_at`,
    [userId, displayName],
  );
  return rows[0];
}
