/**
 * Re-ingests knowledge/*.md into the database (chunk + embed + index).
 * The server also does this automatically on startup when files change;
 * use this after editing articles or switching EMBEDDINGS_PROVIDER.
 *
 * Usage: npm run kb:ingest [-- --force]
 */
import { ingestKnowledge, knowledgeStatus } from "../backend/modules/assistant/knowledge.ts";
import { getDb } from "../backend/db/index.ts";

const force = process.argv.includes("--force");
const result = await ingestKnowledge({ force });
console.log(`ingested ${result.changed} changed of ${result.total} articles`);
console.log(await knowledgeStatus());
await (await getDb()).close();
// HTTP keep-alive sockets (Stellar RPC/Horizon) would otherwise keep the process open.
process.exit(0);
