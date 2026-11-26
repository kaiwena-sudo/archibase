import { describe, expect, it, vi } from "vitest";
import { SAMPLE_PLANS } from "../src/site/sample-data.js";
import { makeApp } from "./helpers.js";

describe("landing page and llms.txt", () => {
  const app = makeApp();

  it("serves HTML to browsers with live prices and the example plan", async () => {
    const res = await app.request("/", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("vary")).toContain("Accept");
    const html = await res.text();
    expect(html).toContain("$0.02");
    expect(html).toContain("$0.10");
    expect(html).toContain("<svg");
    expect(html).toContain("http://test.local/api/v1/plans/search");
    expect(html).not.toContain("mailto:"); // no contact unless CONTACT_EMAIL is set
  });

  it("keeps JSON for agents and scripts", async () => {
    const res = await app.request("/");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ name: "Archibase", llms_txt: "http://test.local/llms.txt" });
  });

  it("serves llms.txt with endpoints and prices", async () => {
    const res = await app.request("/llms.txt");
    expect(res.headers.get("content-type")).toContain("text/plain");
    const txt = await res.text();
    expect(txt).toMatch(/^# Archibase/);
    expect(txt).toContain("GET http://test.local/api/v1/plans/search, $0.02 per call");
  });
});

describe("docs, share image and www redirect", () => {
  it("serves the docs page with prices and the terms section", async () => {
    const res = await makeApp().request("/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="terms"');
    expect(html).toContain("$0.02");
    expect(html).toContain("http://test.local/api/v1/plans/search");
  });

  it("serves a PNG share image", async () => {
    const res = await makeApp().request("/og.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("redirects www to the site address and adds share tags when SITE_URL is set", async () => {
    const app = makeApp({ siteUrl: "https://archibase.example" });
    const r = await app.request("https://www.archibase.example/docs?x=1");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://archibase.example/docs?x=1");
    const page = await (await app.request("https://archibase.example/", { headers: { accept: "text/html" } })).text();
    expect(page).toContain('<link rel="canonical" href="https://archibase.example/">');
    expect(page).toContain('content="https://archibase.example/og.png"');
  });
});

describe("live catalogue figures", () => {
  it("renders counts from the store, not constants", async () => {
    const html = await (await makeApp().request("/", { headers: { accept: "text/html" } })).text();
    // tests/data.ts generates 6 distinct synthetic residential plans for this process
    expect(html).toContain("<b>6</b> real layouts");
    expect(html).toContain("residential <b>6</b>");
    const txt = await (await makeApp().request("/llms.txt")).text();
    expect(txt).toContain("6 distinct layouts");
  });

  it("falls back to the last known figures when the store fails, and recovers", async () => {
    const { catalogueProvider } = await import("../src/site/catalogue.js");
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const get = catalogueProvider(async () => {
      if (fail) throw new Error("db down");
      return [{ prefix: "hk", building_type: "office", served: 7, stored: 9 }];
    }, 0);
    expect((await get()).distinctLayouts).toBe(48_516); // FALLBACK_STATS snapshot
    fail = false;
    const c = await get();
    expect(c).toMatchObject({ distinctLayouts: 7, storedPlans: 9, byBuildingType: [{ type: "office", layouts: 7 }] });
    expect(c.sources[0]).toMatchObject({ key: "hk", name: "Hong Kong 3D Indoor Map" });
  });
});

describe("free sample and count", () => {
  const app = makeApp();

  it("serves the sample without payment, in the paid format, with free geometry links", async () => {
    const res = await app.request("/api/v1/sample");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-archibase-sample")).toBe("true");
    const body = await res.json();
    expect(body).toMatchObject({ sample: true, count: SAMPLE_PLANS.length });
    expect(SAMPLE_PLANS.length).toBeGreaterThanOrEqual(18);
    const p = body.results[0];
    expect(p).toMatchObject({ plan_id: expect.any(String), provenance: expect.any(Object) });
    expect(p.vector_schema_url).toBe(`http://test.local/api/v1/sample/${p.plan_id}/vector`);
    const vec = await app.request(`/api/v1/sample/${p.plan_id}/vector`);
    expect(vec.status).toBe(200);
    expect((await vec.json()).rooms.length).toBeGreaterThan(0);
  });

  it("filters the sample like the paid search and validates the same way", async () => {
    const ind = await (await app.request("/api/v1/sample?building_type=industrial")).json();
    expect(ind.count).toBeGreaterThan(0);
    expect(ind.results.every((r: { building_type: string }) => r.building_type === "industrial")).toBe(true);
    expect((await app.request("/api/v1/sample?bedrooms=banana")).status).toBe(400);
    const imp = await (await app.request("/api/v1/sample?units=imperial&limit=1")).json();
    expect(imp.results[0]).toHaveProperty("total_sqft");
  });

  it("never serves plans outside the sample, even for real catalogue ids", async () => {
    expect((await app.request("/api/v1/sample/ab-modern-3br-0004/vector")).status).toBe(404);
    expect((await app.request("/api/v1/sample/..%2F..%2Fetc/vector")).status).toBe(404);
    expect((await app.request("/api/v1/sample/__proto__/vector")).status).toBe(404);
    expect((await app.request("/api/v1/sample/constructor/vector")).status).toBe(404);
  });

  it("counts matches for free, with the same filters as search, and prices the search", async () => {
    const all = await (await app.request("/api/v1/count")).json();
    expect(all).toMatchObject({ count: 6, max_results_per_search: 100, search_price: "$0.02", searches_to_read_all: 1 });
    const three = await (await app.request("/api/v1/count?bedrooms=3")).json();
    expect(three.count).toBe(2);
    expect(three.filters.bedrooms).toBe(3);
    expect((await app.request("/api/v1/count?bedrooms=x")).status).toBe(400);
  });
});

describe("explorer page", () => {
  const app = makeApp();

  it("serves /explore with its config and a versioned script", async () => {
    const res = await app.request("/explore");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<script type="application\/json" id="cfg">\{[^<]*"network":"eip155:8453"/);
    expect(html).toMatch(/<script type="module" src="\/assets\/explore\.js\?v=[a-z0-9]+">/);
    expect(html).toContain('id="detail"');
    const js = await app.request("/assets/explore.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("export async function fetchPaid");
  });

  it("embeds exactly the browser scripts in src/site/client (run `npm run build:client` after editing them)", async () => {
    const { readFileSync } = await import("node:fs");
    const bundle = await import("../src/site/client-bundle.js");
    expect(bundle.EXPLORE_JS).toBe(readFileSync("src/site/client/explore.js", "utf8").replace(/\r\n?/g, "\n"));
  });

  it("links the free sample and credits from the landing page, docs and llms.txt", async () => {
    const landing = await (await app.request("/", { headers: { accept: "text/html" } })).text();
    expect(landing).toContain('href="/explore"');
    expect(landing).not.toContain("/portal");
    expect(landing).toContain("The only structured, license-clean, machine-native floorplan corpus.");
    const docs = await (await app.request("/docs")).text();
    expect(docs).toContain("/api/v1/sample");
    expect(docs).toContain("insufficient_credits");
    expect(docs).toContain("machine-native floorplan corpus");
    expect(docs).not.toContain("/portal");
    const llms = await (await app.request("/llms.txt")).text();
    expect(llms).toContain("/api/v1/count");
    expect(llms).toContain("ARCHIBASE_API_KEY");
  });
});

describe("files directories and search engines look for", () => {
  const app = makeApp({ siteUrl: "https://archibase.dev" });

  it("serves an icon at the API root", async () => {
    const res = await app.request("/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 4)]).toEqual([0, 0, 1, 0]);
  });

  it("lists the pages in a sitemap on the canonical origin", async () => {
    const xml = await (await app.request("/sitemap.xml")).text();
    for (const path of ["/", "/docs", "/explore", "/skills"]) expect(xml).toContain(`<loc>https://archibase.dev${path}</loc>`);
  });

  it("marks the home page up as a dataset", async () => {
    const html = await (await app.request("/", { headers: { Accept: "text/html" } })).text();
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)?.[1];
    expect(JSON.parse(json!)).toMatchObject({ "@type": "Dataset", url: "https://archibase.dev/" });
  });
});
