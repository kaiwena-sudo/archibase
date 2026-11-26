import { describe, expect, it } from "vitest";
import {
  createPlanStore,
  InMemoryPlanStore,
  JsonPlanStore,
  matchesFilters,
  MAX_LIMIT,
  SupabasePlanStore,
  type FloorPlan,
} from "../src/db/client.js";
import { TEST_PLAN_FILE } from "./data.js";

const store = new JsonPlanStore(TEST_PLAN_FILE);

describe("JsonPlanStore", () => {
  it("returns all sample plans sorted by total_area_m2 when unfiltered", async () => {
    const plans = await store.searchPlans({});
    expect(plans.length).toBeGreaterThanOrEqual(3);
    const m2 = plans.map((p) => p.total_area_m2);
    expect(m2).toEqual([...m2].sort((a, b) => a - b));
  });

  it("filters by exact bedroom count", async () => {
    const plans = await store.searchPlans({ bedrooms: 3 });
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((p) => p.bedrooms === 3)).toBe(true);
  });

  it("filters by inclusive m² range", async () => {
    const plans = await store.searchPlans({ areaMinM2: 126.35, areaMaxM2: 178.37 });
    expect(plans.map((p) => p.total_area_m2)).toEqual([126.35, 134.71, 178.37]);
  });

  it("matches style case-insensitively", async () => {
    const plans = await store.searchPlans({ style: "INDUSTRIAL" });
    expect(plans.map((p) => p.plan_id).sort()).toEqual(["ab-industrial-2br-0005", "ab-industrial-loft-0002"]);
  });

  it("combines filters", async () => {
    const plans = await store.searchPlans({ bedrooms: 3, areaMinM2: 140, areaMaxM2: 230, style: "modern" });
    expect(plans.map((p) => p.plan_id)).toEqual(["ab-modern-3br-0004"]);
  });

  it("returns an empty array when nothing matches", async () => {
    expect(await store.searchPlans({ bedrooms: 19 })).toEqual([]);
  });

  it("applies and clamps limit", async () => {
    expect(await store.searchPlans({ limit: 2 })).toHaveLength(2);
    const all = await store.searchPlans({ limit: 0 }); // invalid → default 25
    expect(all.length).toBeGreaterThan(2);
    expect((await store.searchPlans({ limit: MAX_LIMIT * 10 })).length).toBe(all.length);
  });

  it("every record has the documented shape", async () => {
    for (const p of await store.searchPlans({})) {
      expect(p).toMatchObject({
        plan_id: expect.any(String),
        style: expect.any(String),
        total_area_m2: expect.any(Number),
        bedrooms: expect.any(Number),
        bathrooms: expect.any(Number),
        // vector_schema_url is never stored; the API assigns it
      });
      expect(p.adjacency_graph.units).toBe("m2");
      expect(p).not.toHaveProperty("total_sqft");
      const ids = new Set(p.adjacency_graph.nodes.map((n) => n.id));
      for (const e of p.adjacency_graph.edges) {
        expect(ids.has(e.from) && ids.has(e.to), `${p.plan_id}: ${e.from}->${e.to}`).toBe(true);
      }
    }
  });
});

describe("matchesFilters", () => {
  const plan = { plan_id: "x", style: "Modern", total_area_m2: 100, bedrooms: 2 } as FloorPlan;
  it("treats bounds as inclusive and empty filters as match-all", () => {
    expect(matchesFilters(plan, {})).toBe(true);
    expect(matchesFilters(plan, { areaMinM2: 100, areaMaxM2: 100 })).toBe(true);
    expect(matchesFilters(plan, { areaMinM2: 100.01 })).toBe(false);
    expect(matchesFilters(plan, { areaMaxM2: 99.99 })).toBe(false);
    expect(matchesFilters(plan, { style: "modern" })).toBe(true);
    expect(matchesFilters(plan, { bedrooms: 0 })).toBe(false);
  });
});

describe("createPlanStore", () => {
  const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

  it("defaults to the JSON store", () => {
    expect(createPlanStore(env({})).kind).toBe("json");
  });

  it("accepts file: URLs", () => {
    expect(createPlanStore(env({ DATABASE_URL: "file:data/plans.json" })).kind).toBe("json");
  });

  it("builds a Supabase store when a key is present", () => {
    const s = createPlanStore(env({ DATABASE_URL: "https://abc.supabase.co", SUPABASE_KEY: "k" }));
    expect(s).toBeInstanceOf(SupabasePlanStore);
  });

  it("requires SUPABASE_KEY for Supabase", () => {
    expect(() => createPlanStore(env({ DATABASE_URL: "https://abc.supabase.co" }))).toThrow(/SUPABASE_KEY/);
  });

  it("rejects unsupported URLs", () => {
    expect(() => createPlanStore(env({ DATABASE_URL: "postgres://localhost/db" }))).toThrow(/Unsupported DATABASE_URL/);
  });

  it("surfaces a missing JSON file on first query", async () => {
    const s = createPlanStore(env({ DATABASE_URL: "file:does/not/exist.json" }));
    await expect(s.searchPlans({})).rejects.toThrow();
  });
});

describe("InMemoryPlanStore", () => {
  it("is used when records are passed, with the same filters", async () => {
    const records = await store.searchPlans({});
    const s = createPlanStore({}, { records });
    expect(s).toBeInstanceOf(InMemoryPlanStore);
    expect((await s.searchPlans({ style: "industrial" })).length).toBe(2);
    expect((await s.searchPlans({ limit: 1 })).length).toBe(1);
  });
});
