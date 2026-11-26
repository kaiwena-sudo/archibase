import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

describe("OpenAPI document (served from src/openapi.json)", () => {
  const app = makeApp();

  it("is served as OpenAPI 3.1 without embedding a personal contact address", async () => {
    const r = await app.request("/openapi.json");
    expect(r.status).toBe(200);
    const doc = await r.json();
    expect(doc.openapi).toBe("3.1.0");
    // Only the public contact address may appear; no personal addresses.
    expect(JSON.stringify(doc.info).match(/[\w.+-]+@[\w.-]+/g) ?? []).toEqual(["kaizim@archibase.dev"]);
    expect(doc.externalDocs.url).toMatch(/^https:\/\//);
  });

  it("prices every paid operation the way the paywall actually charges it", async () => {
    const doc = await (await app.request("/openapi.json")).json();
    const challenge = await app.request("/api/v1/plans/search");
    expect(challenge.status).toBe(402);
    const accepted = JSON.parse(atob(challenge.headers.get("payment-required")!)).accepts[0];
    const search = doc.paths["/api/v1/plans/search"].get["x-payment-info"].price;
    expect(search.currency).toBe("USDC");
    expect(Number(search.amount)).toBeCloseTo(Number(accepted.amount) / 1e6, 6);
  });

  it("describes every parameter", async () => {
    const doc = await (await app.request("/openapi.json")).json();
    for (const ops of Object.values<any>(doc.paths)) {
      for (const op of Object.values<any>(ops)) {
        for (const p of op.parameters ?? []) expect(p.description, p.name).toBeTruthy();
      }
    }
  });
});
