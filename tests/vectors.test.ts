import { describe, expect, it, vi } from "vitest";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { createVectorStore, FileVectorStore, HttpVectorStore, NoVectorStore } from "../src/db/vectors.js";
import { loadPaymentConfig } from "../src/middleware/x402.js";
import { challengeFrom, makeApp, SEARCH, simulatedPayment, WALLET } from "./helpers.js";
import { TEST_VECTOR_DIR } from "./data.js";

const VEC = "/api/v1/plans/ab-modern-3br-0004/vector";

async function paid(app: ReturnType<typeof makeApp>, url: string) {
  const challenge = challengeFrom(await app.request(url));
  return app.request(url, { headers: { "X-PAYMENT": simulatedPayment(challenge) } });
}

describe("vector route", () => {
  const app = makeApp();

  it("charges $0.10 by default (2x a search)", async () => {
    const res = await app.request(VEC);
    expect(res.status).toBe(402);
    expect(challengeFrom(res).accepts[0]!.amount).toBe("100000");
    expect(challengeFrom(await app.request(SEARCH)).accepts[0]!.amount).toBe("20000");
  });

  it("returns geometry in metres with a receipt once paid", async () => {
    const res = await paid(app, VEC);
    expect(res.status).toBe(200);
    const v = (await res.json()) as any;
    expect(v).toMatchObject({ plan_id: "ab-modern-3br-0004", units: "m", schema_version: 1 });
    expect(v.rooms[0].polygon[0][0][2]).toEqual([10, 4.4594]);
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
  });

  it("converts coordinates to feet with units=imperial", async () => {
    const v = (await (await paid(app, `${VEC}?units=imperial`)).json()) as any;
    expect(v.units).toBe("ft");
    expect(v.rooms[0].polygon[0][0][1]).toEqual([32.808, 0]); // 10 m
  });

  it("404s before the paywall for unknown or malformed ids (nobody pays for nothing)", async () => {
    for (const id of ["ab-modern-2br-0001", "index", "..%2F..%2Fpackage", "UPPER"]) {
      const res = await app.request(`/api/v1/plans/${id}/vector`);
      expect(res.status, id).toBe(404);
      expect(res.headers.get("payment-required"), id).toBeNull();
    }
  });

  const PLACEHOLDERS = [":plan_id", "%3Aplan_id", "{plan_id}", "%7Bplan_id%7D"];

  it("answers unpaid probes of the route template with the payment terms", async () => {
    for (const id of PLACEHOLDERS) {
      const res = await app.request(`/api/v1/plans/${id}/vector`);
      expect(res.status, id).toBe(402);
      expect(challengeFrom(res).accepts[0]!.amount, id).toBe("100000");
    }
  });

  it("never takes payment or credits for a placeholder id", async () => {
    const challenge = challengeFrom(await app.request(VEC));
    const attempts: Record<string, string>[] = [
      { "PAYMENT-SIGNATURE": simulatedPayment(challenge) },
      { "X-PAYMENT": simulatedPayment(challenge) },
      { "X-API-Key": "ak_anything" },
      { Authorization: "Bearer ak_anything" },
    ];
    for (const id of PLACEHOLDERS) {
      for (const headers of attempts) {
        const res = await app.request(`/api/v1/plans/${id}/vector`, { headers });
        const label = `${id} ${Object.keys(headers)[0]}`;
        expect(res.status, label).toBe(404);
        expect(res.headers.get("payment-response"), label).toBeNull();
      }
    }
  });

  it("400s before the paywall for unknown query parameters or units", async () => {
    for (const q of ["?foo=1", "?units=cubits"]) {
      const res = await app.request(`${VEC}${q}`);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("payment-required"), q).toBeNull();
    }
  });
});

describe("search results link to geometry", () => {
  it("sets vector_schema_url only for plans that have geometry", async () => {
    const res = await paid(makeApp(), `${SEARCH}?limit=100`);
    const body = (await res.json()) as any;
    const byId = Object.fromEntries(body.results.map((r: any) => [r.plan_id, r.vector_schema_url]));
    expect(byId["ab-modern-3br-0004"]).toBe(`http://test.local${VEC}`);
    expect(byId["ab-modern-2br-0001"]).toBeNull();
  });

  it("carries units=imperial through to the vector link", async () => {
    const body = (await (await paid(makeApp(), `${SEARCH}?m2_min=200&m2_max=210&units=imperial`)).json()) as any;
    expect(body.results[0].vector_schema_url).toBe(`http://test.local${VEC}?units=imperial`);
  });

  it("returns null links everywhere when no vector store is configured", async () => {
    const body = (await (await paid(makeApp({ vectors: new NoVectorStore() }), SEARCH)).json()) as any;
    expect(body.results.every((r: any) => r.vector_schema_url === null)).toBe(true);
  });
});

describe("vector stores", () => {
  it("file store ignores index.json and rejects path tricks", async () => {
    const s = new FileVectorStore(TEST_VECTOR_DIR);
    expect(await s.has("ab-modern-3br-0004")).toBe(true);
    expect(await s.has("index")).toBe(false);
    expect(await s.get("../fixtures/plans")).toBeNull();
  });

  it("http store reads index.json once and fetches files by id", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/index.json")) return Response.json(["p-001"]);
      if (u.endsWith("/p-001.json")) return Response.json({ plan_id: "p-001", units: "m", rooms: [], doors: [], windows: [] });
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const s = new HttpVectorStore("https://bucket.example");
      expect(await s.has("p-001")).toBe(true);
      expect(await s.has("p-002")).toBe(false);
      expect((await s.get("p-001"))!.plan_id).toBe("p-001");
      expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("index.json"))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is selected from VECTOR_STORE_URL", () => {
    expect(createVectorStore({}).kind).toBe("file");
    expect(createVectorStore({}, "none").kind).toBe("none");
    expect(createVectorStore({ VECTOR_STORE_URL: "https://b.example/v/" }).kind).toBe("http");
    expect(() => createVectorStore({ VECTOR_STORE_URL: "ftp://x" })).toThrow(/Unsupported/);
  });

  it("VECTOR_PRICE_USD is configurable and validated", () => {
    expect(loadPaymentConfig({ WALLET_ADDRESS: WALLET, VECTOR_PRICE_USD: "0.25" } as NodeJS.ProcessEnv).vectorPrice).toBe("$0.25");
    expect(() => loadPaymentConfig({ WALLET_ADDRESS: WALLET, VECTOR_PRICE_USD: "free" } as NodeJS.ProcessEnv)).toThrow(/VECTOR_PRICE_USD/);
  });
});

describe("stair metadata", () => {
  it("converts stair start/end/run/rise to feet with units=imperial", async () => {
    const { vectorInFeet } = await import("../src/db/vectors.js");
    const v = vectorInFeet({
      plan_id: "x", units: "m", crs: "", rooms: [], doors: [], windows: [],
      stairs: [{ id: "stair_1", level: 1, to_level: 2, risers: 18, start: [0, 10], end: [0, 0], run: 3.2, rise: 3, polygon: [] }],
    });
    expect(v.stairs![0]).toMatchObject({ risers: 18, start: [0, 32.808], end: [0, 0], run: 10.499, rise: 9.843 });
  });
});

describe("Supabase backends", () => {
  it("sends a secret key as apikey only, and a legacy JWT key as Bearer too", async () => {
    const { supabaseHeaders } = await import("../src/db/client.js");
    expect(supabaseHeaders("sb_secret_abc")).toEqual({ apikey: "sb_secret_abc" });
    expect(supabaseHeaders("proxy-injected")).toEqual({ apikey: "proxy-injected" });
    expect(supabaseHeaders("aaa.bbb.ccc")).toEqual({ apikey: "aaa.bbb.ccc", Authorization: "Bearer aaa.bbb.ccc" });
  });

  it("uses Supabase for geometry when plans are in Supabase", () => {
    const env = { DATABASE_URL: "https://ref.supabase.co", SUPABASE_KEY: "k" };
    expect(createVectorStore(env).kind).toBe("supabase");
    expect(createVectorStore({ ...env, VECTOR_STORE_URL: "none" }).kind).toBe("none");
    expect(() => createVectorStore({ VECTOR_STORE_URL: "supabase" })).toThrow(/needs DATABASE_URL/);
  });

  it("SupabaseVectorStore looks up only the ids it is asked about, in one request per batch, and memoises", async () => {
    const { SupabaseVectorStore, withGeometry } = await import("../src/db/vectors.js");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const u = decodeURIComponent(String(url));
      calls.push(u);
      if (u.includes("select=plan_id")) return Response.json(u.includes("sd-1-abc") ? [{ plan_id: "sd-1-abc" }] : []);
      if (u.includes("select=vector")) return Response.json([{ vector: { plan_id: "sd-1-abc", units: "m", rooms: [], doors: [], windows: [] } }]);
      return new Response("", { status: 404 });
    }));
    try {
      const s = new SupabaseVectorStore("https://ref.supabase.co", "sb_secret_x");
      // A search page of 3 ids (one invalid) is a single request, with no catalogue-wide scan.
      expect([...(await withGeometry(s, ["sd-1-abc", "sd-2-def", "BAD id"]))]).toEqual(["sd-1-abc"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("plan_id=in.(sd-1-abc,sd-2-def)");
      expect(calls[0]).not.toContain("offset");
      // Known answers are memoised.
      expect(await s.has("sd-1-abc")).toBe(true);
      expect(await s.has("sd-2-def")).toBe(false);
      expect(calls).toHaveLength(1);
      expect((await s.get("sd-1-abc"))!.plan_id).toBe("sd-1-abc");
      expect(calls.every((c) => c.startsWith("https://ref.supabase.co/rest/v1/floor_plan_vectors?"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
