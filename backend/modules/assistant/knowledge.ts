import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "../../db";
import { logger } from "../../logger";
import { getEmbeddings, toVectorLiteral } from "./embeddings";

export interface KbSource {
  id: string;
  slug: string;
  title: string;
  category: string;
  heading: string;
  content: string;
  score: number;
}

export interface KbFile {
  slug: string;
  title: string;
  category: string;
  body: string;
  checksum: string;
}

export function knowledgeDir() {
  return path.resolve(process.cwd(), "knowledge");
}

/** Parses `---\ntitle: ...\ncategory: ...\n---` front matter. */
export function parseKbFile(slug: string, raw: string): KbFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  const meta: Record<string, string> = {};
  let body = raw;
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index > 0) meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    body = match[2];
  }
  const firstHeading = /^#\s+(.+)$/m.exec(body)?.[1];
  return {
    slug,
    title: meta.title || firstHeading || slug,
    category: meta.category || "general",
    body: body.replace(/\r\n/g, "\n").trim(),
    checksum: crypto.createHash("sha256").update(raw).digest("hex"),
  };
}

export function readKnowledgeFiles(dir = knowledgeDir()): KbFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => parseKbFile(file.replace(/\.md$/, ""), fs.readFileSync(path.join(dir, file), "utf8")));
}

/**
 * Splits markdown into retrieval chunks along headings (## / ###), keeping the heading
 * trail for context, and splitting long sections on paragraph boundaries (~1200 chars).
 */
export function chunkMarkdown(doc: Pick<KbFile, "title" | "body">, maxChars = 1200) {
  const chunks: { heading: string; content: string }[] = [];
  const trail: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    const heading = [doc.title, ...trail].filter(Boolean).join(" › ");
    if (text.length <= maxChars) {
      chunks.push({ heading, content: text });
      return;
    }
    let current = "";
    for (const paragraph of text.split(/\n{2,}/)) {
      if (current && current.length + paragraph.length + 2 > maxChars) {
        chunks.push({ heading, content: current.trim() });
        current = "";
      }
      current += `${paragraph}\n\n`;
    }
    if (current.trim()) chunks.push({ heading, content: current.trim() });
  };

  for (const line of doc.body.split("\n")) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      if (level === 1) trail.length = 0;
      else {
        trail.length = Math.max(0, level - 2);
        trail.push(heading[2].trim());
      }
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

let ingestPromise: Promise<{ changed: number; total: number }> | null = null;

/** Ingests knowledge/*.md into kb_documents/kb_chunks. Unchanged files are skipped by checksum. */
export async function ingestKnowledge(options: { force?: boolean; dir?: string } = {}) {
  const db = await getDb();
  const files = readKnowledgeFiles(options.dir);
  const embeddings = getEmbeddings();
  const existing = new Map(
    (await db.query<{ slug: string; checksum: string; model: string | null }>(
      `SELECT d.slug, d.checksum, (SELECT embedding_model FROM kb_chunks c WHERE c.document_id = d.id LIMIT 1) AS model FROM kb_documents d`,
    )).rows.map((row) => [row.slug, row]),
  );

  let changed = 0;
  for (const file of files) {
    const current = existing.get(file.slug);
    const modelMatches = (current?.model ?? null) === (embeddings?.model ?? null);
    if (!options.force && current && current.checksum === file.checksum && modelMatches) continue;

    const chunks = chunkMarkdown(file);
    let vectors: number[][] | null = null;
    if (embeddings) {
      try {
        vectors = await embeddings.embed(
          chunks.map((chunk) => `${chunk.heading}\n${chunk.content}`),
          "document",
        );
      } catch (error) {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, "embedding failed; storing chunks for full-text search only");
      }
    }

    await db.transaction(async (tx) => {
      await tx.query(`DELETE FROM kb_documents WHERE slug = $1`, [file.slug]);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO kb_documents (slug, title, category, checksum) VALUES ($1, $2, $3, $4) RETURNING id`,
        [file.slug, file.title, file.category, file.checksum],
      );
      for (let i = 0; i < chunks.length; i++) {
        await tx.query(
          `INSERT INTO kb_chunks (document_id, chunk_index, heading, content, embedding, embedding_model)
           VALUES ($1, $2, $3, $4, $5::vector, $6)`,
          [rows[0].id, i, chunks[i].heading, chunks[i].content, vectors ? toVectorLiteral(vectors[i]) : null, vectors ? embeddings!.model : null],
        );
      }
    });
    changed++;
  }

  // Remove documents whose source file was deleted.
  const slugs = files.map((file) => file.slug);
  if (slugs.length) await db.query(`DELETE FROM kb_documents WHERE NOT (slug = ANY($1::text[]))`, [slugs]);
  if (changed) logger.info({ changed, total: files.length }, "knowledge base ingested");
  return { changed, total: files.length };
}

/** Ensures the knowledge base is ingested once per process (cheap no-op when up to date). */
export function ensureKnowledge() {
  ingestPromise ??= ingestKnowledge().catch((error) => {
    ingestPromise = null;
    throw error;
  });
  return ingestPromise;
}

export function resetKnowledgeForTests() {
  ingestPromise = null;
}

/**
 * Hybrid retrieval: vector similarity (when embeddings are available) and Postgres
 * full-text search, merged with reciprocal-rank fusion.
 */
export async function retrieve(query: string, k = 6): Promise<KbSource[]> {
  await ensureKnowledge();
  const db = await getDb();
  type Row = { id: string; slug: string; title: string; category: string; heading: string; content: string; rank: number };
  const lists: Row[][] = [];

  const embeddings = getEmbeddings();
  if (embeddings) {
    try {
      const [vector] = await embeddings.embed([query], "query");
      const { rows } = await db.query<Row>(
        `SELECT c.id, d.slug, d.title, d.category, c.heading, c.content, (1 - (c.embedding <=> $1::vector))::float8 AS rank
           FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
          WHERE c.embedding IS NOT NULL AND c.embedding_model = $2
          ORDER BY c.embedding <=> $1::vector LIMIT 20`,
        [toVectorLiteral(vector), embeddings.model],
      );
      lists.push(rows);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "vector search unavailable; using full-text only");
    }
  }

  const { rows: textRows } = await db.query<Row>(
    `SELECT c.id, d.slug, d.title, d.category, c.heading, c.content, ts_rank_cd(c.tsv, q)::float8 AS rank
       FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id,
            -- OR together the query's stemmed terms so long questions still match partially.
            to_tsquery('english', coalesce(nullif(array_to_string(tsvector_to_array(to_tsvector('english', $1)), ' | '), ''), 'zzznomatch')) q
      WHERE c.tsv @@ q ORDER BY rank DESC LIMIT 20`,
    [query],
  );
  lists.push(textRows);

  const fused = new Map<string, { row: Row; score: number }>();
  for (const list of lists) {
    list.forEach((row, index) => {
      const entry = fused.get(row.id) ?? { row, score: 0 };
      entry.score += 1 / (60 + index + 1);
      fused.set(row.id, entry);
    });
  }
  // At most two chunks per article, so the model sees a diverse set of sources.
  const perDocument = new Map<string, number>();
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .filter(({ row }) => {
      const used = perDocument.get(row.slug) ?? 0;
      perDocument.set(row.slug, used + 1);
      return used < 2;
    })
    .slice(0, k)
    .map(({ row, score }) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      category: row.category,
      heading: row.heading,
      content: row.content,
      score: Number(score.toFixed(5)),
    }));
}

export async function knowledgeStatus() {
  const db = await getDb();
  const { rows } = await db.query<{ documents: string; chunks: string; embedded: string; model: string | null }>(
    `SELECT (SELECT count(*) FROM kb_documents)::text AS documents, count(*)::text AS chunks,
            count(embedding)::text AS embedded, max(embedding_model) AS model FROM kb_chunks`,
  );
  return {
    documents: Number(rows[0].documents),
    chunks: Number(rows[0].chunks),
    embeddedChunks: Number(rows[0].embedded),
    embeddingModel: rows[0].model,
  };
}

export async function listKnowledgeDocuments() {
  const db = await getDb();
  const { rows } = await db.query<{ slug: string; title: string; category: string; updated_at: Date }>(
    `SELECT slug, title, category, updated_at FROM kb_documents ORDER BY category, title`,
  );
  return rows.map((row) => ({ slug: row.slug, title: row.title, category: row.category, updatedAt: new Date(row.updated_at).toISOString() }));
}

export function readKnowledgeDocument(slug: string) {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const file = path.join(knowledgeDir(), `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  return parseKbFile(slug, fs.readFileSync(file, "utf8"));
}
