import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { logger } from "../logger";

/**
 * Minimal database abstraction shared by two drivers:
 *  - PostgreSQL via node-postgres (production; DATABASE_URL)
 *  - PGlite, Postgres compiled to WASM (local dev with zero setup, and tests)
 * Both speak the same SQL and return `{ rows }`, so the data layer is driver-agnostic.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs a multi-statement SQL script without parameters (used for migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  kind: "postgres" | "pglite";
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function createPglite(dataDir: string | undefined): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const pg = new PGlite({ dataDir, extensions: { vector } });
  await pg.waitReady;
  return {
    kind: "pglite",
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pg.query<T>(sql, params)).rows }),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    transaction: (fn) =>
      pg.transaction(async (tx) =>
        fn({
          query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await tx.query<T>(sql, params)).rows }),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
    close: () => pg.close(),
  };
}

async function createPostgres(url: string): Promise<Db> {
  const pgModule = await import("pg");
  const pg = pgModule.default ?? pgModule;
  // Return BIGINT/NUMERIC as strings (never lossy floats); DATE as plain text.
  pg.types.setTypeParser(1082, (value: string) => value);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  pool.on("error", (error: Error) => logger.error({ err: error.message }, "postgres pool error"));
  return {
    kind: "postgres",
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params as unknown[])).rows as T[] }),
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params as unknown[])).rows as T[] }),
          exec: async (sql) => {
            await client.query(sql);
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function migrationsDir() {
  return path.resolve(process.cwd(), "backend", "db", "migrations");
}

/** Applies every migration file not yet recorded in schema_migrations, in filename order. */
export async function migrate(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const files = fs.readdirSync(migrationsDir()).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir(), file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    });
    logger.info({ migration: file }, "migration applied");
  }
}

/**
 * The handle lives on globalThis, not in module scope: tooling such as tsx can load this
 * file as two module instances (ESM + CommonJS). Two PGlite instances on one data
 * directory would overwrite each other's writes, so there must be exactly one per process.
 */
const holder = globalThis as typeof globalThis & { __fintrixDb?: Promise<Db> | null };

/** Lazily opens the configured database and applies migrations once per process. */
export function getDb(): Promise<Db> {
  if (!holder.__fintrixDb) {
    holder.__fintrixDb = (async () => {
      const config = getConfig();
      let db: Db;
      if (config.DATABASE_URL) {
        db = await createPostgres(config.DATABASE_URL);
      } else {
        if (config.NODE_ENV === "production") {
          throw new Error("DATABASE_URL is required in production (PGlite is for local development and tests only).");
        }
        const dataDir = config.NODE_ENV === "test" ? undefined : path.resolve(process.cwd(), config.PGLITE_DIR);
        db = await createPglite(dataDir);
      }
      await migrate(db);
      return db;
    })().catch((error) => {
      holder.__fintrixDb = null;
      throw error;
    });
  }
  return holder.__fintrixDb;
}

/** Test helper: use an explicit database instance (e.g. a fresh in-memory PGlite). */
export function setDbForTests(db: Db | null) {
  holder.__fintrixDb = db ? Promise.resolve(db) : null;
}

export async function createTestDb() {
  const db = await createPglite(undefined);
  await migrate(db);
  return db;
}
