import { describe, expect, it, vi } from "vitest";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PlanStore } from "../src/db/client.js";
import { GuardedFacilitatorClient, MockFacilitatorClient } from "../src/middleware/x402.js";
import { BASE_USDC, challengeFrom, makeApp, SEARCH, simulatedPayment, WALLET } from "./helpers.js";

const QUERY = "?bedrooms=3&sqft_min=1500&sqft_max=2500&style=modern";
const app = makeApp();

async function getChallenge(query = QUERY) {
  const res = await app.request(`${SEARCH}${query}`);
  expect(res.status).toBe(402);
  return challengeFrom(res);
}

describe("free routes", () => {
  it("serves the discovery document", async () => {
    const res = await app.request("/.well-known/x402.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ x402Version: 2, payTo: WALLET, networks: [{ network: "eip155:8453", name: "Base" }] });
    const resource = body.resources[0];
    expect(resource.resource).toBe(`http://test.local${SEARCH}`);
    expect(resource.accepts[0]).toMatchObject({ scheme: "exact", amount: "20000", asset: BASE_USDC, payTo: WALLET });
    expect(Object.keys(resource.input.schema.properties)).toEqual(
      expect.arrayContaining(["bedrooms", "sqft_min", "sqft_max", "style"]),
    );
  });

  it("serves discovery at /.well-known/x402 too", async () => {
    expect((await app.request("/.well-known/x402")).status).toBe(200);
  });

  it("serves / and /health", async () => {
    expect((await app.request("/")).status).toBe(200);
    expect(await (await app.request("/health")).json()).toMatchObject({ ok: true, facilitator: "mock" });
  });

  it("adds the x402 discovery Link header to every response", async () => {
    for (const path of ["/", "/health", "/nope", SEARCH]) {
      const res = await app.request(path);
      expect(res.headers.get("link"), path).toContain('</.well-known/x402.json>; rel="x402-discovery"');
    }
  });

  it("returns JSON 404s", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});

describe("paywalled search", () => {
  it("returns 402 with JSON terms and a PAYMENT-REQUIRED header when unpaid", async () => {
    const res = await app.request(`${SEARCH}${QUERY}`);
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ x402Version: 2, payTo: WALLET, error: "Payment required" });
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:8453",
      amount: "20000",
      asset: BASE_USDC,
      payTo: WALLET,
    });
    expect(body.accepts[0]).not.toHaveProperty("assetSymbol");
    expect(body.acceptsInfo[0]).toEqual({ assetSymbol: "USDC", networkName: "Base" });
    const header = challengeFrom(res);
    expect(body.accepts).toEqual(header.accepts);
    expect(header.accepts).toEqual([expect.objectContaining({ amount: "20000", payTo: WALLET })]);
    expect(header.resource.url).toContain(SEARCH);
  });

  it("rejects malformed queries with 400 before the paywall", async () => {
    const res = await app.request(`${SEARCH}?bedrooms=two`);
    expect(res.status).toBe(400);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_query" });
  });

  it("rejects a payment to the wrong payee", async () => {
    const challenge = await getChallenge();
    const res = await app.request(`${SEARCH}${QUERY}`, {
      headers: { "X-PAYMENT": simulatedPayment(challenge, { payTo: "0x2222222222222222222222222222222222222222" }) },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-response")).toBeNull();
  });

  it("rejects a payment with an invalid signature", async () => {
    const challenge = await getChallenge();
    const res = await app.request(`${SEARCH}${QUERY}`, {
      headers: { "PAYMENT-SIGNATURE": simulatedPayment(challenge, { signature: "not-a-signature" }) },
    });
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error).toMatch(/signature/);
  });

  it("rejects an undecodable payment header", async () => {
    const res = await app.request(`${SEARCH}${QUERY}`, { headers: { "PAYMENT-SIGNATURE": "%%%not-base64%%%" } });
    expect(res.status).toBe(402);
  });

  it.each(["X-PAYMENT", "PAYMENT-SIGNATURE"])("returns results and a receipt when paid via %s", async (header) => {
    const challenge = await getChallenge();
    const res = await app.request(`${SEARCH}${QUERY}`, { headers: { [header]: simulatedPayment(challenge) } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.count).toBe(1);
    // QUERY uses the brief's sqft_min/sqft_max; they are converted to m² and echoed in metric.
    expect(body.units).toBe("metric");
    expect(body.filters).toEqual({ bedrooms: 3, m2_min: 139.35, m2_max: 232.26, style: "modern", built: null, source: null, building_type: null, include_duplicates: false });
    expect(body.results[0]).toMatchObject({
      plan_id: "ab-modern-3br-0004",
      total_area_m2: 208.1,
      adjacency_graph: expect.objectContaining({ units: "m2" }),
      provenance: { source: "synthetic", built: false, license: "CC0-1.0" },
    });
    const receipt = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(receipt).toMatchObject({ success: true, network: "eip155:8453", transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
  });
});

describe("facilitator initialisation", () => {
  it("is not started by free requests, only inside the first paid request", async () => {
    // Regression: on Workers, an initialisation started during a free request (discovery) is
    // cancelled when that request ends, and the next paid request returned 503.
    const facilitator = new MockFacilitatorClient("eip155:8453");
    const supported = vi.spyOn(facilitator, "getSupported");
    const app = makeApp({ facilitator });
    await app.request("/.well-known/x402.json");
    await app.request("/health");
    expect(supported).not.toHaveBeenCalled();
    const res = await app.request(`${SEARCH}${QUERY}`);
    expect(res.status).toBe(402);
    expect(supported).toHaveBeenCalledTimes(1);
    await app.request(`${SEARCH}${QUERY}`);
    expect(supported).toHaveBeenCalledTimes(1);
  });
});

describe("failure handling", () => {
  it("returns a retryable 503 when the facilitator is unreachable", async () => {
    const down: FacilitatorClient = {
      getSupported: () => Promise.reject(new Error("ECONNREFUSED")),
      verify: () => Promise.reject(new Error("ECONNREFUSED")),
      settle: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await makeApp({ facilitator: down }).request(`${SEARCH}${QUERY}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(await res.json()).toMatchObject({ error: "payment_facilitator_unavailable", retryable: true });
  });

  it("does not settle when the store fails after a valid payment", async () => {
    const facilitator = new MockFacilitatorClient("eip155:8453");
    const settle = vi.spyOn(facilitator, "settle");
    const verify = vi.spyOn(facilitator, "verify");
    const broken: PlanStore = { kind: "broken", searchPlans: () => Promise.reject(new Error("db down")) };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = makeApp({ store: broken, facilitator });

    const challenge = challengeFrom(await failing.request(`${SEARCH}${QUERY}`));
    const res = await failing.request(`${SEARCH}${QUERY}`, { headers: { "X-PAYMENT": simulatedPayment(challenge) } });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(settle).not.toHaveBeenCalled();
  });

  it("reports a facilitator outage during verify as 503 without leaking its error text", async () => {
    const inner = new MockFacilitatorClient("eip155:8453");
    vi.spyOn(inner, "verify").mockRejectedValue(new Error("Facilitator verify failed (503): <html>node-7.internal</html>"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp({ facilitator: new GuardedFacilitatorClient(inner) });

    const challenge = challengeFrom(await app.request(`${SEARCH}${QUERY}`));
    const res = await app.request(`${SEARCH}${QUERY}`, { headers: { "X-PAYMENT": simulatedPayment(challenge) } });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(text).not.toContain("internal");
  });

  it("returns a JSON reason when settlement fails after the handler ran", async () => {
    const facilitator = new MockFacilitatorClient("eip155:8453");
    vi.spyOn(facilitator, "settle").mockResolvedValue({
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "eip155:8453",
    });
    const app = makeApp({ facilitator });

    const challenge = challengeFrom(await app.request(`${SEARCH}${QUERY}`));
    const res = await app.request(`${SEARCH}${QUERY}`, { headers: { "X-PAYMENT": simulatedPayment(challenge) } });
    const body = (await res.json()) as { error: string; results?: unknown };

    expect(res.status).toBe(402);
    expect(body.error).toBe("insufficient_funds");
    expect(body.results).toBeUndefined();
  });
});

describe("402 body is directly usable by JSON-only agents", () => {
  it("accepts a payment built from body.accepts[0] verbatim", async () => {
    const app = makeApp();
    const unpaid = await app.request(`${SEARCH}${QUERY}`);
    const body = (await unpaid.json()) as { accepts: unknown[]; acceptsInfo: { assetSymbol: string }[]; resource: unknown };
    expect(body.acceptsInfo[0]!.assetSymbol).toBe("USDC");

    // Build the challenge from the JSON body only (not the header).
    const fromBody = { x402Version: 2, resource: body.resource, accepts: body.accepts } as Parameters<typeof simulatedPayment>[0];
    const paid = await app.request(`${SEARCH}${QUERY}`, { headers: { "X-PAYMENT": simulatedPayment(fromBody) } });
    expect(paid.status).toBe(200);
  });

  it("rejects mixing m² and sqft bounds before the paywall", async () => {
    const res = await makeApp().request(`${SEARCH}?m2_min=100&sqft_max=2000`);
    expect(res.status).toBe(400);
    expect(res.headers.get("payment-required")).toBeNull();
  });

  it("returns imperial units on request", async () => {
    const app = makeApp();
    const q = `${SEARCH}?m2_min=200&m2_max=210&units=imperial`;
    const challenge = challengeFrom(await app.request(q));
    const res = await app.request(q, { headers: { "X-PAYMENT": simulatedPayment(challenge) } });
    const body = (await res.json()) as any;
    expect(body.units).toBe("imperial");
    const [plan] = body.results;
    expect(plan).toMatchObject({ plan_id: "ab-modern-3br-0004", total_sqft: 2240 });
    expect(plan).not.toHaveProperty("total_area_m2");
    expect(plan.adjacency_graph.units).toBe("sqft");
    expect(plan.adjacency_graph.nodes.find((n: any) => n.id === "great_room").area).toBe(480);
  });
});
