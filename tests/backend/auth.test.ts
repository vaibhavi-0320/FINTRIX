import { Keypair } from "@stellar/stellar-sdk";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeSignature } from "../../backend/modules/auth/service";
import { setupApp, signIn, teardown, type TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(() => teardown(ctx));

const csrf = { "x-fintrix-csrf": "1" };

describe("wallet sign-in (SEP-53)", () => {
  it("issues a challenge that names the domain, network and states no transaction is authorised", async () => {
    const kp = Keypair.random();
    const res = await request(ctx.app).post("/api/auth/challenge").set(csrf).send({ address: kp.publicKey() }).expect(200);
    expect(res.body.data.message).toContain(kp.publicKey());
    expect(res.body.data.message).toContain("Test SDF Network ; September 2015");
    expect(res.body.data.message).toMatch(/does not authorize any payment/);
    expect(res.body.data.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("creates an httpOnly session cookie for a valid signature and resolves the user", async () => {
    const { agent, address } = await signIn(ctx.app);
    const session = await agent.get("/api/auth/session").expect(200);
    expect(session.body.data.user.stellarAddress).toBe(address);
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.data.stellarAddress).toBe(address);
  });

  it("sets HttpOnly and SameSite=Lax on the cookie and stores only a hash", async () => {
    const kp = Keypair.random();
    const agent = request.agent(ctx.app);
    const challenge = await agent.post("/api/auth/challenge").set(csrf).send({ address: kp.publicKey() });
    const res = await agent
      .post("/api/auth/verify")
      .set(csrf)
      .send({ address: kp.publicKey(), nonce: challenge.body.data.nonce, signature: Buffer.from(kp.signMessage(challenge.body.data.message)).toString("base64") })
      .expect(200);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/fintrix_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const token = /fintrix_session=([^;]+)/.exec(cookie)![1];
    const stored = await ctx.db.query<{ token_hash: string }>("SELECT token_hash FROM sessions");
    expect(stored.rows.some((row) => row.token_hash === decodeURIComponent(token))).toBe(false);
  });

  it("accepts a raw-message signature over the exact challenge", async () => {
    const kp = Keypair.random();
    const challenge = await request(ctx.app).post("/api/auth/challenge").set(csrf).send({ address: kp.publicKey() });
    await request(ctx.app)
      .post("/api/auth/verify")
      .set(csrf)
      .send({ address: kp.publicKey(), nonce: challenge.body.data.nonce, signature: Buffer.from(kp.sign(Buffer.from(challenge.body.data.message))).toString("hex") })
      .expect(200);
  });

  it("rejects a signature from a different key", async () => {
    const victim = Keypair.random();
    const attacker = Keypair.random();
    const challenge = await request(ctx.app).post("/api/auth/challenge").set(csrf).send({ address: victim.publicKey() });
    const res = await request(ctx.app)
      .post("/api/auth/verify")
      .set(csrf)
      .send({ address: victim.publicKey(), nonce: challenge.body.data.nonce, signature: Buffer.from(attacker.signMessage(challenge.body.data.message)).toString("base64") })
      .expect(401);
    expect(res.body.error).toMatch(/does not match/);
  });

  it("does not allow a challenge to be replayed", async () => {
    const kp = Keypair.random();
    const challenge = await request(ctx.app).post("/api/auth/challenge").set(csrf).send({ address: kp.publicKey() });
    const body = { address: kp.publicKey(), nonce: challenge.body.data.nonce, signature: Buffer.from(kp.signMessage(challenge.body.data.message)).toString("base64") };
    await request(ctx.app).post("/api/auth/verify").set(csrf).send(body).expect(200);
    await request(ctx.app).post("/api/auth/verify").set(csrf).send(body).expect(401);
  });

  it("rejects an expired challenge", async () => {
    const kp = Keypair.random();
    const challenge = await request(ctx.app).post("/api/auth/challenge").set(csrf).send({ address: kp.publicKey() });
    await ctx.db.query("UPDATE auth_challenges SET expires_at = now() - interval '1 minute' WHERE nonce = $1", [challenge.body.data.nonce]);
    await request(ctx.app)
      .post("/api/auth/verify")
      .set(csrf)
      .send({ address: kp.publicKey(), nonce: challenge.body.data.nonce, signature: Buffer.from(kp.signMessage(challenge.body.data.message)).toString("base64") })
      .expect(401);
  });

  it("rejects malformed addresses and signatures", async () => {
    await request(ctx.app).post("/api/auth/challenge").set(csrf).send({ address: "GABC" }).expect(400);
    expect(decodeSignature("not-a-signature")).toBeNull();
    expect(decodeSignature({ type: "Buffer", data: new Array(64).fill(1) })).toHaveLength(64);
  });

  it("logout revokes the session server-side", async () => {
    const { agent } = await signIn(ctx.app);
    await agent.post("/api/auth/logout").set(csrf).expect(200);
    const after = await agent.get("/api/auth/session").expect(200);
    expect(after.body.data.user).toBeNull();
    await agent.get("/api/dashboard").expect(401);
  });

  it("revoke-all signs out every session of the user", async () => {
    const kp = Keypair.random();
    const first = await signIn(ctx.app, kp);
    const second = await signIn(ctx.app, kp);
    const list = await first.agent.get("/api/me/sessions").expect(200);
    expect(list.body.data.sessions.length).toBe(2);
    await second.agent.post("/api/me/sessions/revoke-all").set(csrf).expect(200);
    await first.agent.get("/api/me").expect(401);
  });

  it("updates the display name with sanitisation", async () => {
    const { agent } = await signIn(ctx.app);
    const res = await agent.patch("/api/me").set(csrf).send({ displayName: "<b>Acme</b> Treasury" }).expect(200);
    expect(res.body.data.displayName).toBe("Acme Treasury");
  });
});

describe("request security", () => {
  it("requires authentication for protected routes", async () => {
    for (const path of ["/api/dashboard", "/api/invoices", "/api/documents", "/api/chain/transactions", "/api/assistant/conversations"]) {
      await request(ctx.app).get(path).expect(401);
    }
  });

  it("rejects state-changing requests without the CSRF header", async () => {
    const kp = Keypair.random();
    const res = await request(ctx.app).post("/api/auth/challenge").send({ address: kp.publicKey() }).expect(403);
    expect(res.body.error).toMatch(/CSRF/);
  });

  it("rejects state-changing requests from a foreign Origin", async () => {
    const kp = Keypair.random();
    await request(ctx.app).post("/api/auth/challenge").set(csrf).set("Origin", "https://evil.example").send({ address: kp.publicKey() }).expect(403);
  });

  it("does not grant CORS to unknown origins", async () => {
    const res = await request(ctx.app).get("/api/health").set("Origin", "https://evil.vercel.app");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns JSON 404 for unknown API routes and hides internals on malformed JSON", async () => {
    // Anonymous callers cannot probe which routes exist; signed-in callers get a JSON 404.
    await request(ctx.app).get("/api/does-not-exist").expect(401);
    const { agent } = await signIn(ctx.app);
    const missing = await agent.get("/api/does-not-exist").expect(404);
    expect(missing.body.success).toBe(false);
    const bad = await request(ctx.app).post("/api/auth/challenge").set(csrf).set("Content-Type", "application/json").send("{bad").expect(400);
    expect(bad.body.error).toBe("Malformed JSON body.");
  });

  it("sets security headers", async () => {
    const res = await request(ctx.app).get("/api/health").expect(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.body.data.database).toBe("pglite");
  });

  it("enforces rate limits on sign-in (Postgres-backed store)", async () => {
    process.env.FINTRIX_TEST_RATE_LIMITS = "1";
    try {
      const kp = Keypair.random();
      let limited = false;
      for (let i = 0; i < 15; i++) {
        const res = await request(ctx.app).post("/api/auth/challenge").set(csrf).send({ address: kp.publicKey() });
        if (res.status === 429) {
          limited = true;
          expect(res.body.error).toMatch(/Too many/);
          break;
        }
      }
      expect(limited).toBe(true);
    } finally {
      delete process.env.FINTRIX_TEST_RATE_LIMITS;
    }
  });
});

describe("proxy trust", () => {
  it("ignores spoofed X-Forwarded-For when no proxy is configured", async () => {
    process.env.FINTRIX_TEST_RATE_LIMITS = "1";
    try {
      let limited = false;
      for (let i = 0; i < 15 && !limited; i++) {
        const res = await request(ctx.app)
          .post("/api/auth/challenge")
          .set(csrf)
          .set("X-Forwarded-For", `203.0.113.${i}`)
          .send({ address: Keypair.random().publicKey() });
        limited = res.status === 429;
      }
      expect(limited).toBe(true);
    } finally {
      delete process.env.FINTRIX_TEST_RATE_LIMITS;
    }
  });
});
