/**
 * Cloudflare Workers entry point. Same Hono app as the Node server (src/index.ts),
 * configured from Worker bindings instead of process.env.
 *
 *   npx wrangler dev        # local
 *   npx wrangler deploy     # production
 *
 * Requires compatibility_flags = ["nodejs_compat"] (node:crypto for the mock
 * facilitator, Buffer inside @x402/core). See wrangler.toml.
 */
import type { ExecutionContext, Hono } from "hono";
import { createPlanStore, supabaseHeaders, type FloorPlan } from "./db/client.js";
import { createCreditStore } from "./credits.js";
import { createVectorStore } from "./db/vectors.js";
import { buildRoutes, createApp } from "./index.js";
import { createPaymentGateway, loadPaymentConfig } from "./middleware/x402.js";

export interface Env {
  WALLET_ADDRESS: string;
  X402_NETWORK?: string;
  PRICE_USD?: string;
  FACILITATOR_URL?: string;
  /** Secret: `wrangler secret put FACILITATOR_API_KEY` */
  FACILITATOR_API_KEY?: string;
  /** Secrets for FACILITATOR_URL=cdp (Coinbase Developer Platform, mainnet). */
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  /** Secret: required Supabase project URL for the catalogue. */
  DATABASE_URL: string;
  /** Secret: `wrangler secret put SUPABASE_KEY` */
  SUPABASE_KEY: string;
  PUBLIC_BASE_URL?: string;
  /** Cloudflare rate-limit binding (wrangler.toml [[ratelimits]]). */
  RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  /** https://<bucket> holding <plan_id>.json files and index.json, or "none" */
  VECTOR_STORE_URL?: string;
  VECTOR_PRICE_USD?: string;
  /** Public contact for dataset licences, shown on the landing page. */
  CONTACT_EMAIL?: string;
  /** Canonical site origin, e.g. https://archibase.dev */
  SITE_URL?: string;
  NODE_ENV?: string;
}

// Built once per isolate. Bindings are fixed for an isolate's lifetime.
let app: Hono | undefined;

function getApp(env: Env): Hono {
  if (app) return app;
  for (const name of ["WALLET_ADDRESS", "DATABASE_URL", "SUPABASE_KEY"] as const) {
    if (!env[name]?.trim()) throw new Error(`${name} secret is required for the catalogue-backed Worker`);
  }
  if (env.FACILITATOR_URL === "cdp" && (!env.CDP_API_KEY_ID?.trim() || !env.CDP_API_KEY_SECRET?.trim())) {
    throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET secrets are required when FACILITATOR_URL=cdp");
  }
  // Only string bindings are relevant; loadPaymentConfig/createPlanStore read plain string maps.
  const vars = env as unknown as Record<string, string | undefined>;
  const cfg = loadPaymentConfig(vars as NodeJS.ProcessEnv);
  const gateway = createPaymentGateway(cfg, buildRoutes(cfg));
  // Production reads Supabase (DATABASE_URL). No corpus is bundled into the Worker.
  const store = createPlanStore(vars, { records: [] });
  // Workers have no filesystem: geometry comes from an https bucket (VECTOR_STORE_URL) or is off.
  const vectors = createVectorStore(vars, "none");
  app = createApp({ store, gateway, vectors, publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/$/, ""), contactEmail: env.CONTACT_EMAIL || undefined, siteUrl: env.SITE_URL || undefined,
    credits: createCreditStore(vars, supabaseHeaders),
  });
  return app;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // Per-IP limit on the routes that cost database work or can be scanned cheaply (SEC-03).
      const path = new URL(request.url).pathname;
      if (env.RATE_LIMITER && (path === "/api/v1/count" || /^\/api\/v1\/plans\/[^/]+\/vector$/.test(path))) {
        const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
        if (!success) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
      }
      return getApp(env).fetch(request, env, ctx);
    } catch (err) {
      // Misconfiguration (e.g. missing WALLET_ADDRESS): fail loudly but don't cache a broken app.
      console.error(err);
      return Response.json({ error: "server_misconfigured" }, { status: 500 });
    }
  },
};
