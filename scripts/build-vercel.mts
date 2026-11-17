/**
 * Builds a Vercel deployment using the Build Output API v3:
 *   .vercel/output/static/                     the React app (Vite build)
 *   .vercel/output/functions/api/index.func/   one Node.js function serving /api/*
 *   .vercel/output/config.json                 routes, headers and SPA fallback
 *
 * The API is bundled with esbuild; packages that ship WASM/worker files are kept
 * external and their files are traced with @vercel/nft and copied alongside.
 * Usage: npm run build:vercel
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { build } from "esbuild";
import { nodeFileTrace } from "@vercel/nft";

const root = process.cwd();
const out = path.join(root, ".vercel", "output");
const funcDir = path.join(out, "functions", "api", "index.func");

const EXTERNAL = ["pdfjs-dist", "tesseract.js", "@electric-sql/pglite", "@electric-sql/pglite-pgvector", "pg-native", "@huggingface/transformers", "onnxruntime-node", "sharp"];
// Packages whose runtime loads files by computed path (workers, wasm) — copied whole.
const COPY_WHOLE = ["node_modules/pdfjs-dist/legacy/build", "node_modules/pdfjs-dist/package.json", "node_modules/tesseract.js", "node_modules/tesseract.js-core"];

function copy(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

console.log("1/5 building frontend");
execSync("npm run build --workspace frontend", { stdio: "inherit" });

fs.rmSync(out, { recursive: true, force: true });
copy(path.join(root, "frontend", "dist"), path.join(out, "static"));
// Source maps are for error reporting, not for public download.
for (const file of fs.readdirSync(path.join(out, "static", "assets"))) if (file.endsWith(".map")) fs.rmSync(path.join(out, "static", "assets", file));

console.log("2/5 bundling API");
fs.mkdirSync(funcDir, { recursive: true });
const bundle = path.join(funcDir, "index.mjs");
await build({
  entryPoints: [path.join(root, "api", "index.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  minify: false,
  external: EXTERNAL,
  // CommonJS dependencies inside an ESM bundle need require/__dirname.
  banner: {
    js: [
      "import { createRequire as __fintrixCreateRequire } from 'module';",
      "import { fileURLToPath as __fintrixFileURLToPath } from 'url';",
      "import { dirname as __fintrixDirname } from 'path';",
      "const require = __fintrixCreateRequire(import.meta.url);",
      "const __filename = __fintrixFileURLToPath(import.meta.url);",
      "const __dirname = __fintrixDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "warning",
});

console.log("3/5 tracing external dependencies");
// Not deployed to Vercel: the local embedding model runtime (use EMBEDDINGS_PROVIDER=voyage)
// and the embedded PGlite database (production requires DATABASE_URL).
const SERVERLESS_EXCLUDED = /node_modules[\\/](onnxruntime-node|onnxruntime-common|@huggingface|sharp|@img|@emnapi|@electric-sql)([\\/]|$)/;
const { fileList } = await nodeFileTrace([bundle], { base: root, processCwd: root, ignore: (file) => SERVERLESS_EXCLUDED.test(file) });
let traced = 0;
for (const file of fileList) {
  if (!file.startsWith("node_modules")) continue;
  copy(path.join(root, file), path.join(funcDir, file));
  traced++;
}
for (const entry of COPY_WHOLE) if (fs.existsSync(path.join(root, entry))) copy(path.join(root, entry), path.join(funcDir, entry));

console.log("4/5 copying runtime data");
for (const entry of ["knowledge", "backend/db/migrations", "backend/modules/ml/models"]) copy(path.join(root, entry), path.join(funcDir, entry));
fs.writeFileSync(path.join(funcDir, "package.json"), JSON.stringify({ type: "module" }));
fs.writeFileSync(
  path.join(funcDir, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 60, memory: 1024 }, null, 2),
);

console.log("5/5 writing routing config");
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};
fs.writeFileSync(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/assets/(.*)", headers: { "Cache-Control": "public, max-age=31536000, immutable", ...securityHeaders }, continue: true },
        { src: "/(.*)", headers: securityHeaders, continue: true },
        { src: "/api/(.*)", dest: "/api/index" },
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);

const size = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? size(path.join(dir, entry.name)) : fs.statSync(path.join(dir, entry.name)).size), 0);
console.log(`done: function ${(size(funcDir) / 1024 / 1024).toFixed(1)} MB (${traced} traced files), static ${(size(path.join(out, "static")) / 1024 / 1024).toFixed(1)} MB`);
