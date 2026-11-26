import { describe, expect, it } from "vitest";
import worker from "../src/worker.js";

// The Worker checks the per-IP rate limit before it builds the app (SEC-03), so a stub binding is enough.
describe("worker rate limit on the expensive free routes", () => {
  const limited = { RATE_LIMITER: { limit: async () => ({ success: false }) } } as never;
  const ctx = {} as never;

  it("returns 429 for a limited count request", async () => {
    const res = await worker.fetch(new Request("https://api.test/api/v1/count?bedrooms=2"), limited, ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("returns 429 for a limited vector request", async () => {
    const res = await worker.fetch(new Request("https://api.test/api/v1/plans/rp-1/vector"), limited, ctx);
    expect(res.status).toBe(429);
  });

  it("does not limit other routes", async () => {
    const res = await worker.fetch(new Request("https://api.test/health"), limited, ctx);
    expect(res.status).not.toBe(429);
  });
});
