/**
 * Archibase — AI-ready architectural floor plan API, paid per request via x402.
 *
 *   GET /                         service info (free)
 *   GET /health                   liveness (free)
 *   GET /.well-known/x402.json    machine-readable discovery: endpoints, schemas, pricing (free)
 *   GET /api/v1/plans/search      floor plan search — $0.02 USDC per call via x402
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { RoutesConfig } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { BUILDING_TYPES, COMMERCIAL_LICENSES, PLAN_ID, SOURCES, type BuildingType, type PlanSource } from "./db/validate.js";
import { atomicToUsd, createCreditStore, extractKey, hashKey, KEY_FORMAT, usdToAtomic, type CreditStore } from "./credits.js";
import { catalogueProvider } from "./site/catalogue.js";
import { EXPLORE_JS } from "./site/client-bundle.js";
import { skillAsset, skillIndex, skillsPage } from "./site/skills.js";
import { explorePage } from "./site/explore.js";
import { FAVICON_ICO_BASE64, LOGO_SVG } from "./site/logo.js";
import { SECURITY_HEADERS } from "./site/security.js";
import { docsPage } from "./site/docs.js";
import { esc, landingPage, llmsTxt, type SiteInfo } from "./site/landing.js";
import { OG_PNG_BASE64 } from "./site/og.js";
import { SAMPLE_PLANS, SAMPLE_VECTORS } from "./site/sample-data.js";
import { createVectorStore, MemoryVectorStore, NoVectorStore, vectorInFeet, withGeometry, type VectorStore } from "./db/vectors.js";
import openapiDoc from "./openapi.json" with { type: "json" };
import { present, roundM2, sqftToM2, UNIT_SYSTEMS, type UnitSystem } from "./units.js";
import { createPlanStore, InMemoryPlanStore, MAX_LIMIT, supabaseHeaders, type PlanFilters, type PlanStore } from "./db/client.js";
import {
  createPaymentGateway,
  describeAccepts,
  paymentNetworks,
  loadPaymentConfig,
  NETWORK_NAMES,
  X402_VERSION,
  type PaymentConfig,
  type PaymentGateway,
} from "./middleware/x402.js";

const SEARCH_PATH = "/api/v1/plans/search";
const WELL_KNOWN_PATH = "/.well-known/x402.json";
const VECTOR_PATH = "/api/v1/plans/:plan_id/vector";
const vectorPath = (planId: string) => VECTOR_PATH.replace(":plan_id", planId);
/** Directories probe the route with its literal template as the id; both spellings are in use. */
const PLAN_ID_PLACEHOLDERS = new Set([":plan_id", "{plan_id}"]);
const SAMPLE_PATH = "/api/v1/sample";
const COUNT_PATH = "/api/v1/count";
const VECTOR_DESCRIPTION =
  "Vector geometry for one floor plan (floorplan): room polygons (ids match the adjacency graph), doors and windows, " +
  "in metres (or feet with units=imperial).";
const SEARCH_DESCRIPTION =
  "Search architectural floor plans (floorplans). Returns structured JSON records with room adjacency graphs " +
  "and links to vector (geometry) schemas.";

// ---------- Schemas shared by validation, discovery, and the bazaar extension ----------

const searchInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    bedrooms: { type: "integer", minimum: 0, maximum: 20, description: "Exact bedroom count" },
    m2_min: { type: "number", minimum: 0, maximum: 100000, description: "Minimum net interior area in m² (inclusive)" },
    m2_max: { type: "number", minimum: 0, maximum: 100000, description: "Maximum net interior area in m² (inclusive)" },
    sqft_min: { type: "number", minimum: 0, maximum: 1000000, description: "Same filter in square feet (converted to m²; don't combine with m2_*)" },
    sqft_max: { type: "number", minimum: 0, maximum: 1000000, description: "Same filter in square feet (converted to m²; don't combine with m2_*)" },
    style: { type: "string", maxLength: 64, description: 'Architectural style, e.g. "modern", "industrial"' },
    built: { type: "boolean", description: "true = plans of constructed buildings only; false = unbuilt designs only" },
    source: { type: "string", enum: [...SOURCES], description: "Provenance: synthetic, habs, commissioned, dataset, ai_generated" },
    building_type: {
      type: "string",
      enum: [...BUILDING_TYPES],
      description: "What the building is used for, e.g. residential, office, retail, transport. Non-residential plans are one floor each",
    },
    include_duplicates: {
      type: "boolean",
      description: "Datasets repeat the same apartment on many floors. Default false returns one plan per layout (see layout_copies); true returns every copy",
    },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Max results (default 25)" },
    units: {
      type: "string",
      enum: [...UNIT_SYSTEMS],
      description: "Response units. metric (default): total_area_m2 and room areas in m². imperial: total_sqft and room areas in sqft.",
    },
  },
} as const;

const floorPlanSchema = {
  type: "object",
  required: ["plan_id", "style", "bedrooms", "bathrooms", "adjacency_graph", "vector_schema_url", "provenance"],
  properties: {
    plan_id: { type: "string" },
    style: { type: "string" },
    building_type: { type: "string", enum: [...BUILDING_TYPES], description: "What the building is used for. Absent = residential" },
    total_area_m2: { type: "number", description: "Net interior area in m² (metric responses)" },
    total_sqft: { type: "integer", description: "Net interior area in sqft (units=imperial responses)" },
    bedrooms: { type: "integer", description: "Labelled bedrooms plus rooms inferred as bedrooms" },
    bedrooms_inferred: {
      type: "integer",
      description: "How many of bedrooms are inferred (rooms the source didn't label; see node inferred_use). Absent = 0",
    },
    bathrooms: { type: "number" },
    adjacency_graph: {
      type: "object",
      description: "Rooms as nodes, connections (door/opening/...) as undirected edges",
      properties: {
        units: { type: "string", enum: ["m2", "sqft"], description: "Unit of node areas" },
        nodes: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "type"],
            properties: {
              id: { type: "string" },
              type: { type: "string", description: 'Room type from the source. "room" = a private room the source did not label' },
              area: { type: "number" },
              windows: { type: "integer", description: "Number of windows in this room, when known" },
              stairwell: { type: "boolean", description: "true when this space is a stairwell opening rather than floor: it has no area and is excluded from total_area_m2" },
              inferred_use: {
                type: "string",
                enum: ["bedroom", "entry", "unknown"],
                description: 'Only on type "room": our inference, from windows, size and connections',
              },
            },
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            required: ["from", "to", "connection"],
            properties: { from: { type: "string" }, to: { type: "string" }, connection: { type: "string" } },
          },
        },
      },
    },
    layout_copies: {
      type: "integer",
      description: "How many plans in the catalogue share this exact layout (rooms, sizes, connections), this one included. 1 = unique",
    },
    vector_schema_url: {
      type: ["string", "null"],
      format: "uri",
      description: "Paid URL for this plan's vector geometry (see the vector resource); null when none exists",
    },
    provenance: {
      type: "object",
      description: "Where the plan came from and the licence it is sold under",
      required: ["source", "built", "license"],
      properties: {
        source: { type: "string", enum: [...SOURCES] },
        built: { type: "boolean", description: "Whether the design was actually constructed" },
        license: { type: "string", enum: Object.keys(COMMERCIAL_LICENSES) },
        author: { type: "string" },
        source_url: { type: "string", format: "uri" },
        attribution: { type: "string", description: "Credit line you must reproduce when the licence requires it" },
      },
    },
  },
} as const;

const vectorInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    units: { type: "string", enum: [...UNIT_SYSTEMS], description: "metric (default): coordinates in metres; imperial: feet" },
  },
} as const;

const polygonsSchema = {
  type: "array",
  description: "Polygons; each is [outer ring, ...holes]; each ring is [[x, y], ...] closed",
  items: { type: "array", items: { type: "array", items: { type: "array", items: { type: "number" } } } },
} as const;

const vectorOutputSchema = {
  type: "object",
  required: ["plan_id", "units", "crs", "rooms", "doors", "windows"],
  properties: {
    plan_id: { type: "string" },
    units: { type: "string", enum: ["m", "ft"] },
    crs: { type: "string", description: "Plan-local coordinates: +x east, +y north" },
    attribution: { type: "string", description: "Licence credit you must reproduce (e.g. CC BY)" },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string", description: "Matches an adjacency_graph node id" }, type: { type: "string" }, level: { type: "integer" }, polygon: polygonsSchema },
      },
    },
    doors: { type: "array", items: { type: "object", properties: { type: { type: "string" }, level: { type: "integer" }, polygon: polygonsSchema } } },
    windows: { type: "array", items: { type: "object", properties: { level: { type: "integer" }, polygon: polygonsSchema } } },
    stairs: {
      type: "array",
      description: "Internal stairs, on each level they appear: the flight where they start, the stairwell opening where they arrive",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          level: { type: "integer" },
          to_level: { type: "integer", description: "Set where the stair starts: the level it climbs to (footprint counts as floor area)" },
          from_level: { type: "integer", description: "Set where the stair arrives: the level it comes from (polygon = stairwell opening, excluded from the room's area)" },
          room: { type: "string", description: "Graph node id of the room the stair stands in" },
          risers: { type: "integer" },
          start: { type: "array", items: { type: "number" }, description: "Bottom of the flight [x, y]; with end, gives the direction up" },
          end: { type: "array", items: { type: "number" }, description: "Top of the flight [x, y]" },
          run: { type: "number", description: "Horizontal length of the flight (file units)" },
          rise: { type: "number", description: "Total height climbed (file units)" },
          polygon: { ...polygonsSchema, description: "The stair zone; individual treads are not modelled" },
        },
      },
    },
  },
} as const;

const searchOutputSchema = {
  type: "object",
  properties: {
    count: { type: "integer" },
    filters: { type: "object" },
    results: { type: "array", items: floorPlanSchema },
  },
} as const;

// ---------- Query parsing ----------

type ParseResult = { ok: true; filters: PlanFilters; units: UnitSystem } | { ok: false; errors: string[] };

export function parseSearchQuery(q: Record<string, string | undefined>): ParseResult {
  const errors: string[] = [];
  const allowed = new Set(Object.keys(searchInputSchema.properties));
  for (const key of Object.keys(q)) if (!allowed.has(key)) errors.push(`unknown parameter "${key}"`);

  const num = (key: string, opts: { int?: boolean; min?: number; max?: number }) => {
    const raw = q[key];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || (opts.int && !Number.isInteger(n))) {
      errors.push(`"${key}" must be ${opts.int ? "an integer" : "a number"}`);
      return undefined;
    }
    if (opts.min !== undefined && n < opts.min) errors.push(`"${key}" must be >= ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) errors.push(`"${key}" must be <= ${opts.max}`);
    return n;
  };

  const filters: PlanFilters = {
    bedrooms: num("bedrooms", { int: true, min: 0, max: 20 }),
    limit: num("limit", { int: true, min: 1, max: MAX_LIMIT }),
  };
  const style = q.style?.trim();
  if (style) {
    if (style.length > 64 || !/^[a-zA-Z][a-zA-Z \-]*$/.test(style)) {
      errors.push('"style" must be letters, spaces or hyphens (max 64 chars)');
    } else filters.style = style;
  }
  if (q.built !== undefined && q.built !== "") {
    if (q.built === "true" || q.built === "false") filters.built = q.built === "true";
    else errors.push('"built" must be true or false');
  }
  if (q.building_type !== undefined && q.building_type !== "") {
    if ((BUILDING_TYPES as readonly string[]).includes(q.building_type)) filters.buildingType = q.building_type as BuildingType;
    else errors.push(`"building_type" must be one of ${BUILDING_TYPES.join(", ")}`);
  }
  if (q.include_duplicates !== undefined && q.include_duplicates !== "") {
    if (q.include_duplicates === "true" || q.include_duplicates === "false") filters.includeDuplicates = q.include_duplicates === "true";
    else errors.push('"include_duplicates" must be true or false');
  }
  if (q.source !== undefined && q.source !== "") {
    if ((SOURCES as readonly string[]).includes(q.source)) filters.source = q.source as PlanSource;
    else errors.push(`"source" must be one of ${SOURCES.join(", ")}`);
  }
  // Area: metric is canonical; sqft bounds are converted. Mixing systems is ambiguous, so it's rejected.
  const m2Min = num("m2_min", { min: 0, max: 100_000 });
  const m2Max = num("m2_max", { min: 0, max: 100_000 });
  const sqftMin = num("sqft_min", { min: 0, max: 1_000_000 });
  const sqftMax = num("sqft_max", { min: 0, max: 1_000_000 });
  const usesM2 = m2Min !== undefined || m2Max !== undefined;
  const usesSqft = sqftMin !== undefined || sqftMax !== undefined;
  if (usesM2 && usesSqft) errors.push("use either m2_min/m2_max or sqft_min/sqft_max, not both");
  filters.areaMinM2 = m2Min ?? (sqftMin !== undefined ? sqftToM2(sqftMin) : undefined);
  filters.areaMaxM2 = m2Max ?? (sqftMax !== undefined ? sqftToM2(sqftMax) : undefined);
  if (filters.areaMinM2 !== undefined && filters.areaMaxM2 !== undefined && filters.areaMinM2 > filters.areaMaxM2) {
    errors.push(usesSqft ? '"sqft_min" must be <= "sqft_max"' : '"m2_min" must be <= "m2_max"');
  }
  for (const k of Object.keys(filters) as (keyof PlanFilters)[]) if (filters[k] === undefined) delete filters[k];

  let units: UnitSystem = "metric";
  if (q.units !== undefined && q.units !== "") {
    if ((UNIT_SYSTEMS as readonly string[]).includes(q.units)) units = q.units as UnitSystem;
    else errors.push(`"units" must be one of ${UNIT_SYSTEMS.join(", ")}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, filters, units };
}

/** Reject malformed queries *before* the paywall so agents never pay for a 400. */
const validateSearchQuery: MiddlewareHandler = async (c, next) => {
  const parsed = parseSearchQuery(c.req.query());
  if (!parsed.ok) {
    return c.json({ error: "invalid_query", details: parsed.errors, schema: searchInputSchema }, 400);
  }
  c.set("filters" as never, parsed.filters as never);
  c.set("units" as never, parsed.units as never);
  await next();
};

// ---------- App ----------

export function buildRoutes(cfg: PaymentConfig): RoutesConfig {
  return {
    [`GET ${VECTOR_PATH}`]: {
      accepts: paymentNetworks(cfg).map((network) => ({
        scheme: "exact",
        network,
        payTo: cfg.walletAddress,
        price: cfg.vectorPrice,
        maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      })),
      description: VECTOR_DESCRIPTION,
      mimeType: "application/json",
      serviceName: "Archibase",
      iconUrl: "https://archibase.dev/logo.svg",
      tags: ["architecture", "floor-plans", "geometry", "vector"],
      extensions: declareDiscoveryExtension({
        input: { units: "metric" },
        inputSchema: vectorInputSchema,
        pathParams: { plan_id: "sd-1078-4c05a80dbbdb" },
        pathParamsSchema: {
          type: "object",
          properties: { plan_id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,79}$", description: "A plan_id from search results" } },
          required: ["plan_id"],
        },
        output: { schema: vectorOutputSchema },
      }),
    },
    [`GET ${SEARCH_PATH}`]: {
      accepts: paymentNetworks(cfg).map((network) => ({
        scheme: "exact",
        network,
        payTo: cfg.walletAddress,
        price: cfg.price,
        maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      })),
      description: SEARCH_DESCRIPTION,
      mimeType: "application/json",
      serviceName: "Archibase",
      iconUrl: "https://archibase.dev/logo.svg",
      tags: ["architecture", "floor-plans", "real-estate", "graph"],
      extensions: declareDiscoveryExtension({
        input: { bedrooms: 3, m2_min: 140, m2_max: 230, style: "modern" },
        inputSchema: searchInputSchema,
        output: { schema: searchOutputSchema },
      }),
    },
  };
}

export interface AppDeps {
  store: PlanStore;
  gateway: PaymentGateway;
  /** Vector geometry backend; defaults to none (no plan offers geometry). */
  vectors?: VectorStore;
  publicBaseUrl?: string;
  /** Public contact for dataset licences, shown on the landing page. */
  contactEmail?: string;
  /** Canonical site origin (e.g. https://archibase.dev): share tags, and www. redirects to it. */
  siteUrl?: string;
  /** Prepaid credits (API keys). Without it, only x402 payment works. */
  credits?: CreditStore;
}

export function createApp({ store, gateway, vectors = new NoVectorStore(), publicBaseUrl, contactEmail, siteUrl, credits }: AppDeps): Hono {
  const app = new Hono();
  const cfg = gateway.config;
  // Keys marked as test by maintainers are only honoured on testnet deployments.
  const allowTestKeys = cfg.network !== "eip155:8453";
  const baseUrl = (c: { req: { url: string } }) => publicBaseUrl ?? new URL(c.req.url).origin;

  // www.<site> -> <site>, so the site has one address (better for links and search engines).
  if (siteUrl) {
    const site = new URL(siteUrl);
    app.use("*", async (c, next) => {
      const url = new URL(c.req.url);
      if (url.hostname === `www.${site.hostname}`) return c.redirect(`${site.origin}${url.pathname}${url.search}`, 301);
      await next();
    });
  }

  // Advertise discovery on every response so agents can find pricing from any entry point.
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.append("Link", `<${WELL_KNOWN_PATH}>; rel="x402-discovery"; type="application/json"`);
  });

  // Security headers on every response (SEC-04): no framing, no injected script, strict referrer.
  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(name)) c.res.headers.set(name, value);
  });

  // CORS for the API so browser pages on the site (the explorer on archibase.dev calls api.archibase.dev) can read it.
  // Wildcard is safe: the API takes keys in headers, never cookies, so no ambient credentials are sent cross-origin.
  const apiCors: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key, PAYMENT-SIGNATURE, Authorization",
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, X-Archibase-Credits-Remaining, Link",
    "Access-Control-Max-Age": "86400",
  };
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: apiCors });
    await next();
    for (const [name, value] of Object.entries(apiCors)) c.res.headers.set(name, value);
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  const catalogue = catalogueProvider(store.stats ? () => store.stats!() : undefined);
  const siteInfo = async (c: Context): Promise<SiteInfo> => ({
    baseUrl: baseUrl(c),
    network: cfg.network,
    extraNetworks: cfg.extraNetworks,
    price: cfg.price,
    vectorPrice: cfg.vectorPrice,
    contactEmail,
    siteUrl,
    catalogue: await catalogue(),
  });
  const cacheHeader = (c: Context) => c.header("Cache-Control", publicBaseUrl ? "public, max-age=300" : "private, max-age=300");

  // Browsers get the landing page; agents and scripts (no text/html in Accept) keep getting JSON.
  app.get("/", async (c) => {
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      cacheHeader(c);
      c.header("Vary", "Accept");
      return c.html(landingPage(await siteInfo(c)));
    }
    c.header("Vary", "Accept");
    return c.json({
      name: "Archibase",
      description: "Machine-readable architectural floor plans for AI agents, paid per request with x402.",
      discovery: `${baseUrl(c)}${WELL_KNOWN_PATH}`,
      llms_txt: `${baseUrl(c)}/llms.txt`,
      explore: `${baseUrl(c)}/explore`,
      endpoints: { search: `${baseUrl(c)}${SEARCH_PATH}`, vector: `${baseUrl(c)}${VECTOR_PATH}` },
      free: { sample: `${baseUrl(c)}${SAMPLE_PATH}`, count: `${baseUrl(c)}${COUNT_PATH}` },
    });
  });

  app.get("/llms.txt", async (c) => {
    cacheHeader(c);
    return c.text(llmsTxt(await siteInfo(c)));
  });

  app.get("/docs", async (c) => {
    cacheHeader(c);
    return c.html(docsPage(await siteInfo(c)));
  });

  // djb2 hash of the script: the page links /assets/explore.js?v=<hash>, so a new deploy busts caches.
  const scriptVersion = (src: string) => { let h = 5381; for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) >>> 0; return h.toString(36); };
  app.get("/explore", async (c) => {
    cacheHeader(c);
    return c.html(explorePage(await siteInfo(c), scriptVersion(EXPLORE_JS)));
  });
  app.get("/assets/explore.js", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(EXPLORE_JS, 200, { "Content-Type": "text/javascript; charset=utf-8" });
  });
  app.get("/skills", async (c) => {
    cacheHeader(c);
    return c.html(skillsPage(await siteInfo(c)));
  });
  app.get("/skills/index.json", (c) => {
    cacheHeader(c);
    return c.json(skillIndex(baseUrl(c)));
  });
  app.get("/skills/*", (c) => {
    const asset = skillAsset(decodeURIComponent(new URL(c.req.url).pathname.slice("/skills/".length)));
    if (!asset) return c.json({ error: "not_found" }, 404);
    cacheHeader(c);
    return c.body(asset.body as never, 200, { "Content-Type": asset.type, ...(asset.disposition && { "Content-Disposition": asset.disposition }) });
  });

  app.get("/og.png", () => {
    const bytes = Uint8Array.from(atob(OG_PNG_BASE64), (ch) => ch.charCodeAt(0));
    return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  });

  app.get("/logo.svg", () => new Response(LOGO_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } }));

  app.get("/favicon.ico", () => {
    const bytes = Uint8Array.from(atob(FAVICON_ICO_BASE64), (ch) => ch.charCodeAt(0));
    return new Response(bytes, { headers: { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" } });
  });

  // The human-readable pages, for search engines.
  app.get("/sitemap.xml", (c) => {
    cacheHeader(c);
    const origin = siteUrl ?? baseUrl(c);
    const urls = ["/", "/docs", "/explore", "/skills"].map((path) => `  <url><loc>${esc(origin + path)}</loc></url>`).join("\n");
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      200,
      { "Content-Type": "application/xml; charset=utf-8" },
    );
  });

  // satring.com domain verification (challenge issued from its verify page; expires 30 min after generation).
  app.get("/.well-known/satring-verify", () =>
    new Response("7b0c5ef2a2ea970006c1d3c22b45892307eea9fc1670e69abd07341eb2945e3d\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }),
  );

  // Machine-readable API description for agents and marketplaces. Source: src/openapi.json (kept in git).
  app.get("/openapi.json", (c) => {
    cacheHeader(c);
    return c.json(openapiDoc);
  });

  app.get("/health", (c) =>
    c.json({ ok: true, store: store.kind, vectors: vectors.kind, facilitator: cfg.mock ? "mock" : "remote" }),
  );

  // Payment terms are resolved once (asset address, decimals, EIP-712 domain) and cached.
  let resolvedAccepts: Promise<[unknown[], unknown[]]> | undefined;
  const discovery = async (c: Context) => {
    resolvedAccepts ??= Promise.all([describeAccepts(cfg), describeAccepts(cfg, cfg.vectorPrice)]).catch((err) => {
      resolvedAccepts = undefined;
      throw err;
    });
    const [accepts, vectorAccepts] = await resolvedAccepts;
    const base = baseUrl(c);
    // URLs derived from the Host header must not be cached by shared caches.
    c.header("Cache-Control", publicBaseUrl ? "public, max-age=300" : "private, max-age=300");
    return c.json({
      x402Version: X402_VERSION,
      name: "Archibase",
      description: "AI-ready architectural floor plan data: room adjacency graphs, vector schemas, metadata.",
      payTo: cfg.walletAddress,
      networks: paymentNetworks(cfg).map((network) => ({ network, name: NETWORK_NAMES[network] ?? network })),
      facilitator: cfg.mock ? "mock (development only — no funds move)" : cfg.facilitatorUrl,
      paymentHeaders: { request: ["PAYMENT-SIGNATURE", "X-PAYMENT"], challenge: "PAYMENT-REQUIRED", receipt: "PAYMENT-RESPONSE" },
      resources: [
        {
          resource: `${base}${SEARCH_PATH}`,
          method: "GET",
          description: SEARCH_DESCRIPTION,
          mimeType: "application/json",
          price: { amount: cfg.price, currency: "USD", asset: "USDC" },
          accepts,
          input: { type: "query", schema: searchInputSchema, example: "?bedrooms=3&m2_min=140&m2_max=230&style=modern (add &units=imperial for sqft)" },
          output: { schema: searchOutputSchema },
        },
        {
          resource: `${base}${VECTOR_PATH}`,
          method: "GET",
          description: VECTOR_DESCRIPTION,
          mimeType: "application/json",
          price: { amount: cfg.vectorPrice, currency: "USD", asset: "USDC" },
          accepts: vectorAccepts,
          input: {
            type: "path+query",
            pathParams: { plan_id: "a plan_id from search results; follow vector_schema_url when it is not null" },
            schema: vectorInputSchema,
          },
          output: { schema: vectorOutputSchema },
        },
      ],
    });
  };
  app.get(WELL_KNOWN_PATH, discovery);
  app.get("/.well-known/x402", discovery);

  /**
   * Pay for a call with prepaid credits (X-API-Key) or fall through to x402. Credits are spent first and
   * refunded if the handler fails or returns an error, mirroring x402, which settles only on success.
   */
  const payOrKey = (price: string): MiddlewareHandler => async (c, next) => {
    const key = extractKey(c.req.raw.headers);
    if (!key) return gateway.middleware(c, next);
    if (!credits) return c.json({ error: "api_keys_unavailable" }, 501);
    if (!KEY_FORMAT.test(key)) return c.json({ error: "invalid_api_key" }, 401);
    const hash = await hashKey(key);
    const amount = usdToAtomic(price);
    const left = await credits.spend(hash, amount, allowTestKeys);
    if (left === null) {
      const known = await credits.balance(hash);
      if (!known || (known.test && !allowTestKeys)) return c.json({ error: "invalid_api_key" }, 401);
      return c.json({ error: "insufficient_credits", balance_usd: atomicToUsd(known.balance), price_usd: atomicToUsd(amount), contact: contactEmail ?? null }, 402);
    }
    let served = false;
    try {
      await next();
      served = c.res.status < 400 && !c.error;
    } finally {
      if (!served) await credits.refund(hash, amount).catch((err) => console.error("[credits] refund failed", err));
    }
    c.header("X-Archibase-Credits-Remaining", atomicToUsd(left).toFixed(2));
    return undefined;
  };

  app.get("/api/v1/account", async (c) => {
    c.header("Cache-Control", "no-store");
    const key = extractKey(c.req.raw.headers);
    if (!credits) return c.json({ error: "api_keys_unavailable" }, 501);
    if (!key || !KEY_FORMAT.test(key)) return c.json({ error: "invalid_api_key" }, 401);
    const known = await credits.balance(await hashKey(key));
    if (!known || (known.test && !allowTestKeys)) return c.json({ error: "invalid_api_key" }, 401);
    return c.json({ balance_usd: atomicToUsd(known.balance), balance_atomic: known.balance, prices: { search_usd: atomicToUsd(usdToAtomic(cfg.price)), geometry_usd: atomicToUsd(usdToAtomic(cfg.vectorPrice)) } });
  });

  /** The filters as the API understood them (areas always in m²), echoed in every response. */
  const echoFilters = (filters: PlanFilters) => {
    const m2 = (v?: number) => (v === undefined ? null : roundM2(v));
    return {
      bedrooms: filters.bedrooms ?? null,
      m2_min: m2(filters.areaMinM2),
      m2_max: m2(filters.areaMaxM2),
      style: filters.style ?? null,
      built: filters.built ?? null,
      source: filters.source ?? null,
      building_type: filters.buildingType ?? null,
      include_duplicates: filters.includeDuplicates ?? false,
    };
  };

  // ---- free: sample set and aggregate counts (no payment; the sample is public, counts are rate-limited at the edge) ----
  const sampleStore = new InMemoryPlanStore(SAMPLE_PLANS);
  const sampleVectors = new MemoryVectorStore(SAMPLE_VECTORS);
  const freeHeaders = (c: Context) => {
    c.header("Cache-Control", "public, max-age=3600");
    c.header("X-Archibase-Sample", "true");
  };

  app.get(SAMPLE_PATH, validateSearchQuery, async (c) => {
    const filters = c.get("filters" as never) as PlanFilters;
    const units = c.get("units" as never) as UnitSystem;
    const results = await sampleStore.searchPlans(filters);
    freeHeaders(c);
    return c.json({
      sample: true,
      note: `Free sample: ${SAMPLE_PLANS.length} real plans in the same format as the paid API. Search the full catalogue at ${baseUrl(c)}${SEARCH_PATH}.`,
      count: results.length,
      units,
      filters: echoFilters(filters),
      results: results.map((p) => ({
        ...present(p, units),
        vector_schema_url: `${baseUrl(c)}${SAMPLE_PATH}/${p.plan_id}/vector${units === "imperial" ? "?units=imperial" : ""}`,
      })),
    });
  });

  app.get(`${SAMPLE_PATH}/:plan_id/vector`, async (c) => {
    const q = c.req.query();
    const unknown = Object.keys(q).filter((k) => k !== "units");
    const units = q.units || "metric";
    if (unknown.length || !(UNIT_SYSTEMS as readonly string[]).includes(units)) {
      return c.json({ error: "invalid_query", details: ['only "units" (metric|imperial) is accepted'] }, 400);
    }
    const vector = await sampleVectors.get(c.req.param("plan_id"));
    if (!vector) return c.json({ error: "not_in_sample", hint: `List sample plans at ${baseUrl(c)}${SAMPLE_PATH}` }, 404);
    freeHeaders(c);
    return c.json(units === "imperial" ? vectorInFeet(vector) : vector);
  });

  // How many plans a search would match: lets developers size a query before paying. Memoised per
  // isolate for a minute so repeated or hostile calls can't turn into database load.
  const countMemo = new Map<string, { at: number; count: number }>();
  app.get(COUNT_PATH, validateSearchQuery, async (c) => {
    if (!store.count) return c.json({ error: "count_unavailable" }, 501);
    const filters = { ...(c.get("filters" as never) as PlanFilters) };
    const limit = filters.limit ?? 25;
    delete filters.limit;
    const key = JSON.stringify(Object.entries(filters).sort());
    let hit = countMemo.get(key);
    if (!hit || Date.now() - hit.at > 60_000) {
      if (countMemo.size > 500) countMemo.clear();
      hit = { at: Date.now(), count: await store.count(filters) };
      countMemo.set(key, hit);
    }
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      count: hit.count,
      filters: echoFilters(filters),
      search_returns: Math.min(hit.count, limit),
      max_results_per_search: MAX_LIMIT,
      search_price: cfg.price,
      searches_to_read_all: Math.ceil(hit.count / MAX_LIMIT),
    });
  });

  app.get(SEARCH_PATH, validateSearchQuery, payOrKey(cfg.price), async (c) => {
    const filters = c.get("filters" as never) as PlanFilters;
    const units = c.get("units" as never) as UnitSystem;
    const results = await store.searchPlans(filters);
    const m2 = (v?: number) => (v === undefined ? null : roundM2(v));
    return c.json({
      count: results.length,
      units,
      filters: echoFilters(filters),
      results: await (async () => {
        const geometry = await withGeometry(vectors, results.map((p) => p.plan_id));
        return results.map((p) => ({
          ...present(p, units),
          vector_schema_url: geometry.has(p.plan_id)
            ? `${baseUrl(c)}${vectorPath(p.plan_id)}${units === "imperial" ? "?units=imperial" : ""}`
            : null,
        }));
      })(),
    });
  });

  /**
   * Check the plan id, units and that geometry exists *before* the paywall: nobody pays for a 404.
   * The one exception is an unpaid call on a placeholder id, which gets the 402 terms so directory
   * probes can read them. With any payment or API key attached it is a 404 like any unknown id.
   */
  const validateVectorRequest: MiddlewareHandler = async (c, next) => {
    const planId = c.req.param("plan_id") ?? "";
    const q = c.req.query();
    const unknown = Object.keys(q).filter((k) => k !== "units");
    const units = q.units || "metric";
    if (unknown.length || !(UNIT_SYSTEMS as readonly string[]).includes(units)) {
      return c.json({ error: "invalid_query", details: ['only "units" (metric|imperial) is accepted'], schema: vectorInputSchema }, 400);
    }
    const isProbe =
      PLAN_ID_PLACEHOLDERS.has(planId) &&
      !extractKey(c.req.raw.headers) &&
      !c.req.header("payment-signature") &&
      !c.req.header("x-payment");
    if (!isProbe && (!PLAN_ID.test(planId) || !(await vectors.has(planId)))) {
      return c.json({ error: "vector_not_found", plan_id: planId }, 404);
    }
    c.set("units" as never, units as never);
    await next();
  };

  app.get(VECTOR_PATH, validateVectorRequest, payOrKey(cfg.vectorPrice), async (c) => {
    const vector = await vectors.get(c.req.param("plan_id")!);
    if (!vector) return c.json({ error: "vector_not_found" }, 404); // not settled: x402 cancels on >= 400
    const units = c.get("units" as never) as UnitSystem;
    return c.json(units === "imperial" ? vectorInFeet(vector) : vector);
  });

  app.notFound((c) => c.json({ error: "not_found", discovery: WELL_KNOWN_PATH }, 404));
  return app;
}

// ---------- Entry point (Node only) ----------
// Guarded so importing this module from a Cloudflare Worker (src/worker.ts) has no
// side effects: Workers have no process.argv entry script, and @hono/node-server is
// only loaded on demand.

async function startNodeServer(): Promise<void> {
  const { serve } = await import("@hono/node-server");
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile();
    } catch {
      /* no .env file — rely on the real environment */
    }
  }
  const cfg = loadPaymentConfig();
  await describeAccepts(cfg); // fail fast on price/network/asset misconfiguration
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!publicBaseUrl && process.env.NODE_ENV === "production") {
    throw new Error("PUBLIC_BASE_URL is required in production (resource URLs must not come from the Host header)");
  }
  const routes = buildRoutes(cfg);
  const gateway = createPaymentGateway(cfg, routes);
  const store = createPlanStore();
  const vectors = createVectorStore(process.env);
  const app = createApp({
    store, gateway, vectors, publicBaseUrl,
    credits: createCreditStore(process.env, supabaseHeaders),
  });
  const port = Number(process.env.PORT ?? 3000);

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Archibase listening on http://localhost:${info.port}`);
    console.log(`  network: ${cfg.network} (${NETWORK_NAMES[cfg.network] ?? "custom"}), price: ${cfg.price} USDC`);
    console.log(`  payTo:   ${cfg.walletAddress}`);
    console.log(`  store:   ${store.kind}`);
    if (cfg.mock) console.warn("  ⚠ FACILITATOR_URL=mock — simulated payments are accepted, no funds move.");
    else console.log(`  facilitator: ${cfg.facilitatorUrl}`);
  });
}

const entryScript = typeof process !== "undefined" ? process.argv?.[1] : undefined;
const isMain =
  !!entryScript && (import.meta.url === `file://${entryScript}` || entryScript.endsWith("index.ts"));
if (isMain) {
  startNodeServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
