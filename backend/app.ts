import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { getConfig } from "./config";
import { getDb } from "./db";
import { apiNotFound, errorHandler, HttpError } from "./errors";
import { attachUser, clearSessionCookie, csrfGuard, currentUser, requireUser, setSessionCookie } from "./http/middleware";
import { aiLimiter, authLimiter, chainLimiter, generalLimiter, uploadLimiter } from "./rateLimit";
import { configureSecurity } from "./security";
import * as validation from "./validation";
import * as auth from "./modules/auth/service";
import * as invoices from "./modules/invoices/service";
import * as chain from "./modules/chain/service";
import * as documents from "./modules/documents/service";
import * as assistant from "./modules/assistant/service";
import { isLlmConfigured } from "./modules/assistant/llm";
import { ensureKnowledge, knowledgeStatus, listKnowledgeDocuments, readKnowledgeDocument, retrieve } from "./modules/assistant/knowledge";
import { loadRiskModel } from "./modules/ml/risk";

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Wraps an async route so thrown errors reach the error handler. */
const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(handler(req, res)).catch(next);
};

const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

/** Host shown in the sign-in message. X-Forwarded-Host is honoured only behind a trusted proxy. */
function requestDomain(req: Request) {
  const forwarded = getConfig().TRUST_PROXY_HOPS > 0 ? req.get("x-forwarded-host") : undefined;
  return (forwarded || req.get("host") || "fintrix").split(",")[0].trim().slice(0, 100);
}

/**
 * The Fintrix API. Mounted by the local server (backend/dev-server.ts) and exported
 * as the Vercel serverless function (api/index.ts).
 */
export function createApp() {
  const config = getConfig();
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

  configureSecurity(app);
  app.use("/api", express.json({ limit: "1mb" }));
  app.use("/api", attachUser);
  app.use("/api", csrfGuard);
  app.use("/api", generalLimiter);

  const api = express.Router();

  // ------------------------------------------------------------- public
  api.get(
    "/health",
    route(async (_req, res) => {
      const db = await getDb();
      await db.query("SELECT 1");
      ok(res, {
        status: "ok",
        database: db.kind,
        network: config.stellar.network,
        contractConfigured: Boolean(config.FINTRIX_CONTRACT_ID),
        aiConfigured: isLlmConfigured(),
        riskModel: loadRiskModel() ? `${loadRiskModel()!.name}@${loadRiskModel()!.version}` : null,
      });
    }),
  );

  api.get(
    "/config",
    route((_req, res) =>
      ok(res, {
        network: config.stellar.network,
        networkPassphrase: config.stellar.passphrase,
        horizonUrl: config.stellar.horizonUrl,
        rpcUrl: config.stellar.rpcUrl,
        explorerBase: config.stellar.explorerBase,
        contractId: config.FINTRIX_CONTRACT_ID ?? null,
        settlementTokenId: config.SETTLEMENT_TOKEN_ID ?? null,
        settlementAsset: config.SETTLEMENT_ASSET_CODE,
        usdPerSettlementUnit: config.USD_PER_XLM,
        maxUploadBytes: config.MAX_UPLOAD_BYTES,
        aiConfigured: isLlmConfigured(),
        extractionEngine: config.EXTRACTION_PROVIDER === "auto" ? (isLlmConfigured() ? "claude" : "local") : config.EXTRACTION_PROVIDER,
      }),
    ),
  );

  // Help centre: the same knowledge base the assistant retrieves from.
  api.get(
    "/knowledge",
    route(async (_req, res) => {
      await ensureKnowledge();
      ok(res, { documents: await listKnowledgeDocuments(), status: await knowledgeStatus() });
    }),
  );
  api.get(
    "/knowledge/search",
    route(async (req, res) => {
      const q = String(req.query.q ?? "").trim().slice(0, 200);
      if (!q) throw new HttpError(400, "Enter a search query.");
      const results = await retrieve(q, 8);
      ok(res, results.map((result) => ({ ...result, content: result.content.slice(0, 600) })));
    }),
  );
  api.get(
    "/knowledge/:slug",
    route((req, res) => {
      const doc = readKnowledgeDocument(String(req.params.slug));
      if (!doc) throw new HttpError(404, "Article not found.");
      ok(res, { slug: doc.slug, title: doc.title, category: doc.category, body: doc.body });
    }),
  );

  // ------------------------------------------------------------- auth
  api.post(
    "/auth/challenge",
    authLimiter,
    route(async (req, res) => {
      const body = validation.challengeSchema.parse(req.body);
      ok(res, await auth.createChallenge(body.address, requestDomain(req)));
    }),
  );

  api.post(
    "/auth/verify",
    authLimiter,
    route(async (req, res) => {
      const body = validation.verifySchema.parse(req.body);
      const result = await auth.verifyChallengeAndCreateSession({ ...body, userAgent: req.get("user-agent") });
      setSessionCookie(req, res, result.token, result.expiresAt);
      ok(res, { user: result.user });
    }),
  );

  api.get("/auth/session", route((req, res) => ok(res, { user: req.user ?? null })));

  api.post(
    "/auth/logout",
    route(async (req, res) => {
      if (req.user) await auth.revokeSession(req.user.sessionId);
      clearSessionCookie(req, res);
      ok(res, { signedOut: true });
    }),
  );

  // Everything below requires a signed-in user.
  api.use(requireUser);

  // ------------------------------------------------------------- profile
  api.get("/me", route((req, res) => ok(res, currentUser(req))));
  api.patch(
    "/me",
    route(async (req, res) => {
      const body = validation.profileSchema.parse(req.body);
      const user = await auth.updateProfile(currentUser(req).id, body.displayName ?? null);
      ok(res, { id: user.id, stellarAddress: user.stellar_address, displayName: user.display_name, role: user.role });
    }),
  );
  api.get("/me/sessions", route(async (req, res) => ok(res, { current: currentUser(req).sessionId, sessions: await auth.listSessions(currentUser(req).id) })));
  api.post(
    "/me/sessions/revoke-all",
    route(async (req, res) => {
      await auth.revokeAllSessions(currentUser(req).id);
      clearSessionCookie(req, res);
      ok(res, { revoked: true });
    }),
  );

  api.get("/dashboard", route(async (req, res) => ok(res, await invoices.dashboard(currentUser(req)))));

  // ------------------------------------------------------------- invoices
  api.get(
    "/invoices",
    route(async (req, res) => {
      const query = validation.invoiceListQuerySchema.parse(req.query);
      ok(res, await invoices.listInvoices(currentUser(req), query));
    }),
  );
  api.post(
    "/invoices",
    route(async (req, res) => {
      const body = validation.invoiceInputSchema.parse(req.body);
      ok(res, await invoices.createInvoice(currentUser(req), body), 201);
    }),
  );
  api.get("/invoices/:id", route(async (req, res) => ok(res, await invoices.getInvoice(String(req.params.id), currentUser(req)))));
  api.put(
    "/invoices/:id",
    route(async (req, res) => {
      const body = validation.invoiceInputSchema.parse(req.body);
      ok(res, await invoices.updateDraft(currentUser(req), String(req.params.id), body));
    }),
  );
  api.delete(
    "/invoices/:id",
    route(async (req, res) => {
      await invoices.deleteDraft(currentUser(req), String(req.params.id));
      ok(res, { deleted: true });
    }),
  );
  api.post("/invoices/:id/reconcile", chainLimiter, route(async (req, res) => ok(res, await chain.reconcileInvoice(currentUser(req), String(req.params.id)))));

  // ------------------------------------------------------------- blockchain
  api.post(
    "/invoices/:id/actions/:action",
    chainLimiter,
    route(async (req, res) => {
      const action = validation.chainActionSchema.parse(req.params.action);
      ok(res, await chain.prepareAction(currentUser(req), String(req.params.id), action));
    }),
  );
  api.post(
    "/chain/transactions/:txId/submit",
    chainLimiter,
    route(async (req, res) => {
      const body = validation.submitSchema.parse(req.body);
      ok(res, await chain.submitSigned(currentUser(req), String(req.params.txId), body.signedXdr));
    }),
  );
  api.post(
    "/chain/simulations",
    chainLimiter,
    route(async (req, res) => {
      const body = validation.simulationSchema.parse(req.body);
      ok(res, await chain.prepareSimulation(currentUser(req), body));
    }),
  );
  api.get("/chain/transactions", route(async (req, res) => ok(res, await chain.listTransactions(currentUser(req)))));
  api.get("/chain/transactions/:txId", chainLimiter, route(async (req, res) => ok(res, await chain.refreshTransaction(currentUser(req), String(req.params.txId)))));
  api.get("/chain/account", route(async (req, res) => ok(res, await chain.accountOverview(currentUser(req).stellarAddress))));
  api.get("/chain/activity", route(async (req, res) => ok(res, await chain.accountActivity(currentUser(req).stellarAddress))));

  // ------------------------------------------------------------- documents
  api.post(
    "/documents",
    uploadLimiter,
    (req, res, next) =>
      upload.single("file")(req, res, (error: unknown) => {
        if (error instanceof multer.MulterError) {
          return next(new HttpError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, error.code === "LIMIT_FILE_SIZE" ? "File is too large." : "Invalid upload."));
        }
        next(error);
      }),
    route(async (req, res) => {
      if (!req.file) throw new HttpError(400, "Attach a file in the 'file' field.");
      ok(res, await documents.uploadDocument(currentUser(req), req.file), 201);
    }),
  );
  api.get("/documents", route(async (req, res) => ok(res, await documents.listDocuments(currentUser(req)))));
  api.get("/documents/:id", route(async (req, res) => ok(res, await documents.getDocument(currentUser(req), String(req.params.id)))));
  api.get(
    "/documents/:id/file",
    route(async (req, res) => {
      const file = await documents.getDocumentContent(currentUser(req), String(req.params.id));
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "")}"`);
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "private, no-store");
      res.send(file.content);
    }),
  );
  api.post(
    "/documents/:id/extract",
    uploadLimiter,
    route(async (req, res) => {
      const body = validation.reExtractSchema.parse(req.body ?? {});
      if (body.engine === "claude") await aiLimiterPromise(req, res);
      ok(res, await documents.reExtract(currentUser(req), String(req.params.id), body.engine));
    }),
  );
  api.delete(
    "/documents/:id",
    route(async (req, res) => {
      await documents.deleteDocument(currentUser(req), String(req.params.id));
      ok(res, { deleted: true });
    }),
  );
  api.put(
    "/extractions/:id/review",
    route(async (req, res) => {
      const body = validation.reviewSchema.parse(req.body);
      ok(res, await documents.reviewExtraction(currentUser(req), String(req.params.id), body.fields));
    }),
  );
  api.post(
    "/extractions/:id/invoice",
    route(async (req, res) => {
      const body = validation.extractionToInvoiceSchema.parse(req.body);
      ok(res, await documents.createInvoiceFromExtraction(currentUser(req), String(req.params.id), body), 201);
    }),
  );

  // ------------------------------------------------------------- assistant
  api.get("/assistant/status", route(async (_req, res) => ok(res, { aiConfigured: isLlmConfigured(), model: config.ANTHROPIC_MODEL, knowledge: await knowledgeStatus() })));
  api.get("/assistant/conversations", route(async (req, res) => ok(res, await assistant.listConversations(currentUser(req)))));
  api.post(
    "/assistant/conversations",
    route(async (req, res) => {
      const body = validation.conversationCreateSchema.parse(req.body ?? {});
      ok(res, await assistant.createConversation(currentUser(req), body.audience), 201);
    }),
  );
  api.get("/assistant/conversations/:id", route(async (req, res) => ok(res, await assistant.getConversation(currentUser(req), String(req.params.id)))));
  api.patch(
    "/assistant/conversations/:id",
    route(async (req, res) => {
      const body = validation.conversationPatchSchema.parse(req.body);
      ok(res, await assistant.updateConversation(currentUser(req), String(req.params.id), body));
    }),
  );
  api.delete(
    "/assistant/conversations/:id",
    route(async (req, res) => {
      await assistant.deleteConversation(currentUser(req), String(req.params.id));
      ok(res, { deleted: true });
    }),
  );
  api.post(
    "/assistant/conversations/:id/messages",
    aiLimiter,
    route(async (req, res) => {
      const body = validation.messageSchema.parse(req.body);
      // Check ownership before the stream starts: once headers are sent, errors must be SSE events.
      await assistant.ownConversation(currentUser(req), String(req.params.id));
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (event: { type: string }) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      try {
        for await (const event of assistant.sendMessage(currentUser(req), String(req.params.id), body.content, controller.signal, body.context)) send(event);
      } catch (error) {
        send({
          type: "error",
          message: error instanceof HttpError && error.expose ? error.message : "The assistant failed to respond.",
          status: error instanceof HttpError ? error.statusCode : 500,
        } as { type: string });
      }
      res.end();
    }),
  );

  // ------------------------------------------------------------- ML transparency
  api.get(
    "/ml/models",
    route((_req, res) => {
      const model = loadRiskModel();
      ok(res, {
        risk: model ? { name: model.name, version: model.version, trainedAt: model.trainedAt, dataset: model.dataset, metrics: model.metrics, features: model.features } : null,
      });
    }),
  );

  app.use("/api", api);
  app.use("/api", apiNotFound);
  app.use(errorHandler);
  return app;

  /** Applies the AI rate limit inline for requests that only sometimes call the model. */
  function aiLimiterPromise(req: Request, res: Response) {
    return new Promise<void>((resolve, reject) => aiLimiter(req, res, (error?: unknown) => (error ? reject(error) : resolve())));
  }
}
