import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pageEnd } from "../src/site/landing.js";
import { FOOTER_SCRIPT_SHA256, SECURITY_HEADERS } from "../src/site/security.js";
import { makeApp } from "./helpers.js";

describe("security headers (SEC-04)", () => {
  const app = makeApp();

  it("sends CSP and anti-framing headers on pages and JSON", async () => {
    for (const path of ["/", "/explore", "/api/v1/count"]) {
      const r = await app.request(path);
      expect(r.headers.get("x-frame-options"), path).toBe("DENY");
      expect(r.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(r.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
      expect(r.headers.get("content-security-policy"), path).toContain("object-src 'none'");
    }
  });

  it("lets the site's pages read the API cross-origin, including the x402 preflight", async () => {
    const get = await app.request("/api/v1/sample", { headers: { Origin: "https://archibase.dev" } });
    expect(get.headers.get("access-control-allow-origin")).toBe("*");
    expect(get.headers.get("access-control-expose-headers")).toContain("PAYMENT-REQUIRED");
    const pre = await app.request("/api/v1/plans/search", {
      method: "OPTIONS",
      headers: { Origin: "https://archibase.dev", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "payment-signature" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("PAYMENT-SIGNATURE");
  });

  it("the footer script hash in the CSP matches the script the page actually renders", () => {
    const html = pageEnd({ baseUrl: "https://archibase.dev" } as never);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(createHash("sha256").update(script, "utf8").digest("base64")).toBe(FOOTER_SCRIPT_SHA256);
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain(`'sha256-${FOOTER_SCRIPT_SHA256}'`);
  });

  it("every executable inline script on the explorer is covered by a hash in the CSP", async () => {
    const r = await app.request("/explore");
    const csp = r.headers.get("content-security-policy")!;
    const html = await r.text();
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(inline.length).toBeGreaterThan(0);
    for (const body of inline) {
      const hash = createHash("sha256").update(body, "utf8").digest("base64");
      expect(csp).toContain(`'sha256-${hash}'`);
    }
  });
});
