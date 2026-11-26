/**
 * Per-plan vector geometry (room polygons, doors, windows) sold by the vector route.
 *
 * Backends, selected from VECTOR_STORE_URL:
 *   - unset / "file:<dir>"   → JSON files <dir>/<plan_id>.json (default data/vectors; Node only)
 *   - "https://..."          → <url>/<plan_id>.json plus <url>/index.json (a JSON array of
 *                              plan_ids), e.g. a public R2 or Supabase Storage bucket; works on Workers
 *   - "none"                 → no geometry available
 *
 * The set of available ids is loaded once and kept in memory, so search results
 * can say which plans have geometry without a lookup per result.
 */
import { PLAN_ID } from "./validate.js";
import { supabaseHeaders } from "./client.js";
import { m2ToSqft } from "../units.js";

type Pt = [number, number];
type Poly = Pt[][];

export interface PlanVector {
  plan_id: string;
  schema_version?: number;
  units: "m" | "ft";
  crs: string;
  attribution?: string;
  rooms: { id: string; type: string; level: number; polygon: Poly[] }[];
  doors: { type: string; level: number; polygon: Poly[] }[];
  windows: { level: number; polygon: Poly[] }[];
  /** Internal stairs. Absent in files made before stairs were added. */
  stairs?: PlanStair[];
}

export interface PlanStair {
  id: string;
  /** Level the stair starts on; its footprint is drawn on this level. */
  level: number;
  /** On the level where the stair starts: the level it climbs to. The footprint is floor area. */
  to_level?: number;
  /**
   * On the level where the stair arrives: the level it comes from. The polygon marks the
   * stairwell opening, which is excluded from the room's area.
   */
  from_level?: number;
  /** Graph node id of the room the stair stands in. */
  room?: string;
  risers?: number;
  /** Bottom and top of the flight (centreline points, file units): together they give the direction of travel up. */
  start?: Pt;
  end?: Pt;
  /** Horizontal length of the flight, in file units. */
  run?: number;
  /** Total height climbed, in file units. */
  rise?: number;
  /** The stair zone (shade it; individual treads are not modelled). */
  polygon: Poly[];
}

export interface VectorStore {
  readonly kind: string;
  has(planId: string): Promise<boolean>;
  /** Batch form of has(), for search results: which of these ids have geometry. */
  hasMany?(planIds: string[]): Promise<Set<string>>;
  get(planId: string): Promise<PlanVector | null>;
}

/** Ids among `planIds` with geometry, in as few store round trips as the store allows. */
export async function withGeometry(store: VectorStore, planIds: string[]): Promise<Set<string>> {
  if (store.hasMany) return store.hasMany(planIds);
  const flags = await Promise.all(planIds.map((id) => store.has(id)));
  return new Set(planIds.filter((_, i) => flags[i]));
}

/** Geometry held in memory (the bundled free sample). */
export class MemoryVectorStore implements VectorStore {
  readonly kind = "memory";
  constructor(private readonly byId: Record<string, PlanVector>) {}
  async has(planId: string) {
    return Object.hasOwn(this.byId, planId);
  }
  async hasMany(planIds: string[]) {
    return new Set(planIds.filter((id) => Object.hasOwn(this.byId, id)));
  }
  async get(planId: string) {
    return Object.hasOwn(this.byId, planId) ? this.byId[planId]! : null;
  }
}

export class NoVectorStore implements VectorStore {
  readonly kind = "none";
  async has() {
    return false;
  }
  async get() {
    return null;
  }
}

export class FileVectorStore implements VectorStore {
  readonly kind = "file";
  private ids?: Promise<Set<string>>;

  constructor(private readonly dir: string) {}

  private index(): Promise<Set<string>> {
    this.ids ??= import("node:fs/promises")
      .then(({ readdir }) => readdir(this.dir))
      .then((files) => new Set(files.filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => f.slice(0, -5))))
      .catch(() => new Set<string>());
    return this.ids;
  }

  async has(planId: string) {
    return PLAN_ID.test(planId) && (await this.index()).has(planId);
  }

  async get(planId: string): Promise<PlanVector | null> {
    // The id is checked against the directory listing, so it can never escape `dir`.
    if (!(await this.has(planId))) return null;
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(`${this.dir}/${planId}.json`, "utf8")) as PlanVector;
  }
}

export class HttpVectorStore implements VectorStore {
  readonly kind = "http";
  private ids?: Promise<Set<string>>;

  constructor(private readonly baseUrl: string) {}

  private index(): Promise<Set<string>> {
    this.ids ??= fetch(`${this.baseUrl}/index.json`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
      .then((list) => new Set(list))
      .catch((err) => {
        this.ids = undefined; // retry on the next request
        throw err;
      });
    return this.ids;
  }

  async has(planId: string) {
    return PLAN_ID.test(planId) && (await this.index()).has(planId);
  }

  async get(planId: string): Promise<PlanVector | null> {
    if (!(await this.has(planId))) return null;
    const res = await fetch(`${this.baseUrl}/${planId}.json`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`vector fetch failed: ${res.status}`);
    return (await res.json()) as PlanVector;
  }
}

/**
 * Geometry in the Supabase table floor_plan_vectors (db/schema.sql), read with the server's
 * secret key over PostgREST. The id list is read once (paged) and cached.
 */
export class SupabaseVectorStore implements VectorStore {
  readonly kind = "supabase";
  /**
   * Per-isolate memo of known answers. The catalogue is too large to index up front (Workers
   * allow ~50 outbound requests per call), so ids are looked up on demand: one request per search.
   */
  private known = new Map<string, boolean>();
  private static readonly MEMO_LIMIT = 20_000;

  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  private async page(query: string): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/rest/v1/floor_plan_vectors?${query}`, {
      headers: { ...supabaseHeaders(this.apiKey), Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Supabase vector query failed: ${res.status} ${await res.text().catch(() => "")}`);
    return (await res.json()) as unknown[];
  }

  async hasMany(planIds: string[]): Promise<Set<string>> {
    const valid = [...new Set(planIds.filter((id) => PLAN_ID.test(id)))];
    const unknown = valid.filter((id) => !this.known.has(id));
    // PLAN_ID allows only [a-z0-9-], so ids are safe inside PostgREST's in.(...) list.
    for (let i = 0; i < unknown.length; i += 100) {
      const chunk = unknown.slice(i, i + 100);
      const rows = (await this.page(`select=plan_id&plan_id=in.(${chunk.join(",")})`)) as { plan_id: string }[];
      const found = new Set(rows.map((r) => r.plan_id));
      if (this.known.size > SupabaseVectorStore.MEMO_LIMIT) this.known.clear();
      for (const id of chunk) this.known.set(id, found.has(id));
    }
    return new Set(valid.filter((id) => this.known.get(id)));
  }

  async has(planId: string) {
    return (await this.hasMany([planId])).has(planId);
  }

  async get(planId: string): Promise<PlanVector | null> {
    if (!(await this.has(planId))) return null;
    const rows = (await this.page(`select=vector&plan_id=eq.${encodeURIComponent(planId)}`)) as { vector: PlanVector }[];
    return rows[0]?.vector ?? null;
  }
}

export function createVectorStore(env: Record<string, string | undefined>, fallback = "file:data/vectors"): VectorStore {
  const db = env.DATABASE_URL?.trim() ?? "";
  // With plans in Supabase, geometry lives there too unless VECTOR_STORE_URL says otherwise.
  const url = env.VECTOR_STORE_URL?.trim() || (/^https:\/\/.+\.supabase\.co\/?$/.test(db) ? "supabase" : fallback);
  if (url === "none") return new NoVectorStore();
  if (url === "supabase") {
    if (!/^https:\/\/.+\.supabase\.co\/?$/.test(db) || !env.SUPABASE_KEY) {
      throw new Error("VECTOR_STORE_URL=supabase needs DATABASE_URL=https://<project>.supabase.co and SUPABASE_KEY");
    }
    return new SupabaseVectorStore(db, env.SUPABASE_KEY);
  }
  if (url.startsWith("file:")) return new FileVectorStore(url.slice("file:".length));
  if (url.startsWith("https://")) return new HttpVectorStore(url.replace(/\/$/, ""));
  throw new Error(`Unsupported VECTOR_STORE_URL "${url}". Use file:<dir>, https://<bucket>, supabase or none`);
}

/** Imperial view: coordinates in feet. (Areas aren't stored in vectors; polygons carry the geometry.) */
export function vectorInFeet(v: PlanVector): PlanVector {
  const k = Math.sqrt(m2ToSqft(1)); // ft per m
  const conv = (polys: Poly[]): Poly[] =>
    polys.map((poly) => poly.map((ring) => ring.map(([x, y]) => [Math.round(x * k * 1000) / 1000, Math.round(y * k * 1000) / 1000] as Pt)));
  return {
    ...v,
    units: "ft",
    rooms: v.rooms.map((r) => ({ ...r, polygon: conv(r.polygon) })),
    doors: v.doors.map((d) => ({ ...d, polygon: conv(d.polygon) })),
    windows: v.windows.map((w) => ({ ...w, polygon: conv(w.polygon) })),
    ...(v.stairs && {
      stairs: v.stairs.map((s) => ({
        ...s,
        polygon: conv(s.polygon),
        ...(s.start && { start: [Math.round(s.start[0] * k * 1000) / 1000, Math.round(s.start[1] * k * 1000) / 1000] as Pt }),
        ...(s.end && { end: [Math.round(s.end[0] * k * 1000) / 1000, Math.round(s.end[1] * k * 1000) / 1000] as Pt }),
        ...(s.run !== undefined && { run: Math.round(s.run * k * 1000) / 1000 }),
        ...(s.rise !== undefined && { rise: Math.round(s.rise * k * 1000) / 1000 }),
      })),
    }),
  };
}
