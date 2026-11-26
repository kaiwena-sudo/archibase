/**
 * Floor plan data access.
 *
 * Backends, selected from DATABASE_URL:
 *   - unset / "file:<path>"            → local JSON file (default: data/plans.json),
 *                                        or in-memory records when `records` is passed
 *   - "https://<project>.supabase.co"  → Supabase (PostgREST) table `floor_plans`,
 *                                        authenticated with SUPABASE_KEY
 *
 * Both backends apply the same filters, so agents see identical semantics.
 */

export interface AdjacencyNode {
  id: string;
  type: string;
  area?: number;
  level?: number;
  exterior?: boolean;
  [key: string]: unknown;
}

export interface AdjacencyEdge {
  from: string;
  to: string;
  connection: string;
  [key: string]: unknown;
}

export interface AdjacencyGraph {
  /** Stored records are always "m2"; responses may be converted to "sqft". */
  units?: string;
  nodes: AdjacencyNode[];
  edges: AdjacencyEdge[];
  /** Provenance and context notes (derivation, source_ids, level, level_name, identical_levels, ...). */
  [key: string]: unknown;
}

import { rankLayouts, type LayoutInfo } from "./layout.js";
import type { StatsRow } from "../site/catalogue.js";
import { toPublicPlan, type BuildingType, type InternalRights, type PlanSource, type Provenance } from "./validate.js";

export interface FloorPlan {
  plan_id: string;
  style: string;
  /** What the building is used for. Absent = "residential". */
  building_type?: BuildingType;
  /** Net interior area in m² (exterior spaces like balconies excluded). */
  total_area_m2: number;
  /** Labelled bedrooms plus rooms whose inferred_use is "bedroom". */
  bedrooms: number;
  /** How many of `bedrooms` are inferred rather than labelled in the source. Absent = all labelled. */
  bedrooms_inferred?: number;
  bathrooms: number;
  adjacency_graph: AdjacencyGraph;
  /**
   * Response-only: set by the API to the paid vector route when geometry exists,
   * null otherwise. Never stored.
   */
  vector_schema_url?: string | null;
  /**
   * Response-only: how many plans in the catalogue share this exact layout (same rooms, sizes and
   * connections), this one included. 1 = unique. Computed by the store (src/db/layout.ts).
   */
  layout_copies?: number;
  provenance: Provenance;
}

export interface PlanFilters {
  bedrooms?: number;
  /** Inclusive bounds on total_area_m2. */
  areaMinM2?: number;
  areaMaxM2?: number;
  style?: string;
  built?: boolean;
  source?: PlanSource;
  buildingType?: BuildingType;
  /** Also return non-canonical copies of repeated layouts. Default false: one plan per layout. */
  includeDuplicates?: boolean;
  limit?: number;
}

export interface PlanStore {
  readonly kind: string;
  searchPlans(filters: PlanFilters): Promise<FloorPlan[]>;
  /** Live catalogue counts per plan_id prefix and building type (for the site). */
  stats?(): Promise<StatsRow[]>;
  /** How many plans a search with these filters could return (limit ignored). Free, so stores should be cheap. */
  count?(filters: PlanFilters): Promise<number>;
}

/** Counts in the shape of public.catalogue_stats, computed in memory. */
function statsOf(plans: readonly FloorPlan[], layouts: Map<string, LayoutInfo>): StatsRow[] {
  const rows = new Map<string, StatsRow>();
  for (const p of plans) {
    const prefix = p.plan_id.split("-")[0]!;
    const building_type = p.building_type ?? "residential";
    const key = `${prefix}|${building_type}`;
    const row = rows.get(key) ?? { prefix, building_type, served: 0, stored: 0 };
    const info = layouts.get(p.plan_id)!;
    row.stored++;
    if (info.layout_rank === 1 && !info.quality_flags.length) row.served++;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export function matchesFilters(plan: FloorPlan, f: PlanFilters): boolean {
  if (f.bedrooms !== undefined && plan.bedrooms !== f.bedrooms) return false;
  if (f.areaMinM2 !== undefined && plan.total_area_m2 < f.areaMinM2) return false;
  if (f.areaMaxM2 !== undefined && plan.total_area_m2 > f.areaMaxM2) return false;
  if (f.style !== undefined && plan.style.toLowerCase() !== f.style.toLowerCase()) return false;
  if (f.built !== undefined && plan.provenance?.built !== f.built) return false;
  if (f.source !== undefined && plan.provenance?.source !== f.source) return false;
  if (f.buildingType !== undefined && (plan.building_type ?? "residential") !== f.buildingType) return false;
  return true;
}

function matchesServing(plan: FloorPlan, layouts: Map<string, LayoutInfo>, filters: PlanFilters): boolean {
  const info = layouts.get(plan.plan_id)!;
  if (info.quality_flags.length) return false;
  if (!filters.includeDuplicates && info.layout_rank !== 1) return false;
  return matchesFilters(plan, filters);
}

/** In-memory equivalent of the Supabase query: unflagged, one copy per layout unless asked. */
function searchRecords(plans: readonly FloorPlan[], layouts: Map<string, LayoutInfo>, filters: PlanFilters): FloorPlan[] {
  return plans
    .filter((p) => matchesServing(p, layouts, filters))
    .sort((a, b) => a.total_area_m2 - b.total_area_m2)
    .slice(0, clampLimit(filters.limit))
    .map((p) => ({ ...p, layout_copies: layouts.get(p.plan_id)!.layout_copies }));
}

/** Store over records already in memory (e.g. a JSON module bundled into a Worker). */
export class InMemoryPlanStore implements PlanStore {
  readonly kind = "memory";
  private layouts?: Map<string, LayoutInfo>;

  constructor(private readonly records: readonly FloorPlan[]) {}

  async searchPlans(filters: PlanFilters): Promise<FloorPlan[]> {
    this.layouts ??= rankLayouts(this.records);
    return searchRecords(this.records, this.layouts, filters);
  }

  async stats(): Promise<StatsRow[]> {
    this.layouts ??= rankLayouts(this.records);
    return statsOf(this.records, this.layouts);
  }

  async count(filters: PlanFilters): Promise<number> {
    this.layouts ??= rankLayouts(this.records);
    return this.records.filter((p) => matchesServing(p, this.layouts!, filters)).length;
  }
}

/** JSON-file store (Node). The file is read once and cached in memory. */
export class JsonPlanStore implements PlanStore {
  readonly kind = "json";
  private cache?: Promise<{ plans: FloorPlan[]; layouts: Map<string, LayoutInfo> }>;

  constructor(private readonly path: string) {}

  private load(): Promise<{ plans: FloorPlan[]; layouts: Map<string, LayoutInfo> }> {
    // node:fs is imported lazily so this module also loads on Cloudflare Workers.
    this.cache ??= import("node:fs/promises").then(({ readFile }) => readFile(this.path, "utf8")).then((raw) => {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error(`${this.path} must contain a JSON array`);
      const plans = (parsed as (FloorPlan & InternalRights)[]).map(toPublicPlan);
      return { plans, layouts: rankLayouts(plans) };
    });
    return this.cache;
  }

  async searchPlans(filters: PlanFilters): Promise<FloorPlan[]> {
    const { plans, layouts } = await this.load();
    return searchRecords(plans, layouts, filters);
  }

  async stats(): Promise<StatsRow[]> {
    const { plans, layouts } = await this.load();
    return statsOf(plans, layouts);
  }

  async count(filters: PlanFilters): Promise<number> {
    const { plans, layouts } = await this.load();
    return plans.filter((p) => matchesServing(p, layouts, filters)).length;
  }
}

/**
 * Auth headers for Supabase's REST API. Current secret keys (sb_secret_...) go only in the
 * `apikey` header; legacy service_role keys are JWTs and also need `Authorization: Bearer`.
 * Sending a non-JWT as Bearer is rejected, so it is only added for JWT-shaped keys.
 */
export function supabaseHeaders(key: string): Record<string, string> {
  const isJwt = key.split(".").length === 3;
  return { apikey: key, ...(isJwt && { Authorization: `Bearer ${key}` }) };
}

/**
 * Supabase store using the PostgREST HTTP API directly (no SDK dependency, so
 * it also runs unchanged on Cloudflare Workers). See db/schema.sql for the table.
 */
export class SupabasePlanStore implements PlanStore {
  readonly kind = "supabase";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly table = "floor_plans",
  ) {}

  /** The WHERE part of a search, shared by search and count so they can never disagree. */
  private filterUrl(filters: PlanFilters): URL {
    const url = new URL(`/rest/v1/${this.table}`, this.baseUrl);
    if (filters.bedrooms !== undefined) url.searchParams.append("bedrooms", `eq.${filters.bedrooms}`);
    if (filters.areaMinM2 !== undefined) url.searchParams.append("total_area_m2", `gte.${filters.areaMinM2}`);
    if (filters.areaMaxM2 !== undefined) url.searchParams.append("total_area_m2", `lte.${filters.areaMaxM2}`);
    // ilike without wildcards = case-insensitive equality. Escape PostgREST/LIKE metacharacters.
    if (filters.style !== undefined) {
      const safe = filters.style.replace(/[%_*,()\\]/g, "");
      url.searchParams.append("style", `ilike.${safe}`);
    }
    if (filters.built !== undefined) url.searchParams.append("built", `is.${filters.built}`);
    if (filters.source !== undefined) {
      url.searchParams.append("source", `eq.${filters.source}`); // enum-validated upstream
    }
    if (filters.buildingType !== undefined) url.searchParams.append("building_type", `eq.${filters.buildingType}`); // enum-validated
    // Flagged records (probably merged units) are never served; repeated layouts only on request.
    url.searchParams.append("quality_flags", "eq.{}");
    if (!filters.includeDuplicates) url.searchParams.append("layout_rank", "eq.1");
    return url;
  }

  async count(filters: PlanFilters): Promise<number> {
    const url = this.filterUrl(filters);
    url.searchParams.set("select", "plan_id");
    url.searchParams.set("limit", "1");
    const res = await fetch(url, {
      headers: { ...supabaseHeaders(this.apiKey), Accept: "application/json", Prefer: "count=exact" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Supabase count failed: ${res.status} ${await res.text().catch(() => "")}`);
    const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1];
    if (total === undefined) throw new Error("Supabase count: no content-range header");
    return Number(total);
  }

  async searchPlans(filters: PlanFilters): Promise<FloorPlan[]> {
    const url = this.filterUrl(filters);
    url.searchParams.set("select", SUPABASE_COLUMNS.join(","));
    url.searchParams.set("order", "total_area_m2.asc");
    url.searchParams.set("limit", String(clampLimit(filters.limit)));

    const res = await fetch(url, {
      headers: { ...supabaseHeaders(this.apiKey), Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Supabase query failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    return ((await res.json()) as SupabaseRow[]).map(fromRow);
  }

  /** Live counts from the public.catalogue_stats view (db/schema.sql). */
  async stats(): Promise<StatsRow[]> {
    const res = await fetch(new URL("/rest/v1/catalogue_stats?select=prefix,building_type,served,stored", this.baseUrl), {
      headers: { ...supabaseHeaders(this.apiKey), Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Supabase stats failed: ${res.status} ${await res.text().catch(() => "")}`);
    return (await res.json()) as StatsRow[];
  }

  /** Insert or update records by plan_id (seed script; needs a service-role key). */
  async upsertPlans(records: (FloorPlan & InternalRights)[]): Promise<void> {
    const url = new URL(`/rest/v1/${this.table}`, this.baseUrl);
    url.searchParams.set("on_conflict", "plan_id");
    for (let i = 0; i < records.length; i += 500) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...supabaseHeaders(this.apiKey),
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(records.slice(i, i + 500).map(toRow)),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }
}

// ---- Supabase row mapping: flat, filterable columns <-> nested API shape ----

export const SUPABASE_COLUMNS = [
  "plan_id", "style", "building_type", "total_area_m2", "bedrooms", "bedrooms_inferred", "bathrooms", "adjacency_graph",
  "source", "built", "license", "author", "source_url", "attribution", "layout_copies",
] as const;

export interface SupabaseRow extends Omit<FloorPlan, "provenance">, Omit<Provenance, "built"> {
  built: boolean;
  rights_ref?: string | null;
}

export function fromRow(row: SupabaseRow): FloorPlan {
  const { source, built, license, author, source_url, attribution, rights_ref: _internal, ...plan } = row;
  const provenance: Provenance = { source, built, license };
  if (author) provenance.author = author;
  if (source_url) provenance.source_url = source_url;
  if (attribution) provenance.attribution = attribution;
  // numeric columns can arrive as strings from PostgREST
  return {
    ...plan,
    total_area_m2: Number(plan.total_area_m2),
    bathrooms: Number(plan.bathrooms),
    layout_copies: plan.layout_copies == null ? 1 : Number(plan.layout_copies),
    provenance,
  };
}

/** A plan as a floor_plans row (also used by scripts/supabase-load.ts). */
export function toRow(plan: FloorPlan & InternalRights): SupabaseRow {
  const { provenance, layout_copies: _computed, ...rest } = plan;
  return {
    ...rest,
    bedrooms_inferred: plan.bedrooms_inferred ?? 0,
    building_type: plan.building_type ?? "residential",
    source: provenance.source,
    built: provenance.built,
    license: provenance.license,
    author: provenance.author,
    source_url: provenance.source_url,
    attribution: provenance.attribution,
    rights_ref: plan.rights_ref ?? null,
  };
}

export interface PlanStoreOptions {
  /** Records to serve when DATABASE_URL is unset or file:, instead of reading a file. */
  records?: readonly FloorPlan[];
}

export function createPlanStore(
  env: Record<string, string | undefined> = process.env,
  opts: PlanStoreOptions = {},
): PlanStore {
  const dbUrl = env.DATABASE_URL?.trim();
  if (!dbUrl || dbUrl.startsWith("file:")) {
    if (opts.records) return new InMemoryPlanStore(opts.records);
    // Relative paths resolve against the working directory, as before.
    const path = dbUrl ? dbUrl.slice("file:".length) : "data/plans.json";
    return new JsonPlanStore(path);
  }
  if (/^https:\/\/.+\.supabase\.co\/?$/.test(dbUrl)) {
    const key = env.SUPABASE_KEY;
    if (!key) throw new Error("DATABASE_URL points at Supabase but SUPABASE_KEY is not set");
    return new SupabasePlanStore(dbUrl, key);
  }
  throw new Error(
    `Unsupported DATABASE_URL "${dbUrl}". Use file:<path> or https://<project>.supabase.co`,
  );
}
