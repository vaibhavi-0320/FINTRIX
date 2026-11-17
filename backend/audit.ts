import type { Queryable } from "./db";

/** Appends a security-relevant event. Never store secrets or document contents in `detail`. */
export async function audit(db: Queryable, userId: string | null, action: string, entity?: string, entityId?: string, detail?: Record<string, unknown>) {
  await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5)`, [
    userId,
    action,
    entity ?? null,
    entityId ?? null,
    detail ? JSON.stringify(detail) : null,
  ]);
}
