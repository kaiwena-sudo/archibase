import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryPlanStore, SupabasePlanStore, type FloorPlan } from "../src/db/client.js";
import { layoutKey, qualityFlags, rankLayouts } from "../src/db/layout.js";
import { parseSearchQuery } from "../src/index.js";

function plan(id: string, opts: { area?: number; kitchens?: number; ids?: [string, string] } = {}): FloorPlan {
  const [a, b] = opts.ids ?? ["room_1", "kitchen_1"];
  const kitchens = Array.from({ length: (opts.kitchens ?? 1) - 1 }, (_, i) => ({ id: `kitchen_x${i}`, type: "kitchen", area: 5 }));
  return {
    plan_id: id,
    style: "unspecified",
    total_area_m2: 40,
    bedrooms: 1,
    bathrooms: 1,
    adjacency_graph: {
      units: "m2",
      nodes: [
        { id: a, type: "bedroom", area: opts.area ?? 12.04, windows: 1 },
        { id: b, type: "kitchen", area: 8, fixtures: ["sink", "kitchen"] },
        ...kitchens,
      ],
      edges: [{ from: a, to: b, connection: "door" }],
    },
    provenance: { source: "dataset", built: true, license: "CC-BY-4.0", attribution: "test" },
  };
}

describe("layoutKey", () => {
  it("ignores node ids, list order and fixture order", () => {
    const p = plan("sd-1-a");
    const renamed = plan("sd-1-b", { ids: ["r9", "k9"] });
    renamed.adjacency_graph.nodes.reverse();
    (renamed.adjacency_graph.nodes[0]!.fixtures as string[]).reverse();
    expect(layoutKey(renamed)).toBe(layoutKey(p));
  });

  it("treats areas equal to 0.1 m² as the same and larger changes as different", () => {
    expect(layoutKey(plan("a", { area: 12.04 }))).toBe(layoutKey(plan("b", { area: 12.01 })));
    expect(layoutKey(plan("a", { area: 12.0 }))).not.toBe(layoutKey(plan("b", { area: 12.3 })));
  });

  it("depends on connections", () => {
    const p = plan("a");
    const q = plan("b");
    q.adjacency_graph.edges[0]!.connection = "opening";
    expect(layoutKey(q)).not.toBe(layoutKey(p));
  });
});

describe("qualityFlags", () => {
  it("flags 3+ kitchens as a probable multi-unit record", () => {
    expect(qualityFlags(plan("a", { kitchens: 2 }))).toEqual([]);
    expect(qualityFlags(plan("a", { kitchens: 3 }))).toEqual(["multi_unit_suspect"]);
  });
});

describe("rankLayouts", () => {
  it("makes the lowest plan_id canonical and counts copies", () => {
    const ranks = rankLayouts([plan("sd-1-c"), plan("sd-1-a"), plan("sd-1-b"), plan("sd-2-z", { area: 20 })]);
    expect(ranks.get("sd-1-a")).toMatchObject({ layout_rank: 1, layout_copies: 3 });
    expect(ranks.get("sd-1-c")).toMatchObject({ layout_rank: 3, layout_copies: 3 });
    expect(ranks.get("sd-2-z")).toMatchObject({ layout_rank: 1, layout_copies: 1 });
  });

  it("keeps flagged plans out of the groups", () => {
    const flagged = plan("sd-0-a", { kitchens: 3 });
    const ranks = rankLayouts([flagged, plan("sd-1-a", { kitchens: 3 })]);
    expect(ranks.get("sd-0-a")).toMatchObject({ layout_rank: 1, layout_copies: 1, quality_flags: ["multi_unit_suspect"] });
  });
});

describe("search over repeated layouts", () => {
  const store = new InMemoryPlanStore([plan("sd-1-b"), plan("sd-1-a"), plan("sd-2-a", { area: 20 }), plan("sd-3-a", { kitchens: 4 })]);

  it("returns one plan per layout by default, with its copy count, and never flagged plans", async () => {
    const res = await store.searchPlans({});
    expect(res.map((p) => [p.plan_id, p.layout_copies])).toEqual([["sd-1-a", 2], ["sd-2-a", 1]]);
  });

  it("returns every copy with includeDuplicates", async () => {
    const res = await store.searchPlans({ includeDuplicates: true });
    expect(res.map((p) => p.plan_id).sort()).toEqual(["sd-1-a", "sd-1-b", "sd-2-a"]);
  });

  it("parses include_duplicates", () => {
    expect(parseSearchQuery({ include_duplicates: "true" })).toMatchObject({ ok: true, filters: { includeDuplicates: true } });
    expect(parseSearchQuery({ include_duplicates: "yes" })).toMatchObject({ ok: false });
  });
});

describe("SupabasePlanStore query", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function urlFor(filters: Parameters<SupabasePlanStore["searchPlans"]>[0]): Promise<URL> {
    let seen: URL | undefined;
    vi.stubGlobal("fetch", async (u: URL) => {
      seen = new URL(u);
      return Response.json([{ ...plan("sd-1-a"), provenance: undefined, source: "dataset", built: true, license: "CC-BY-4.0", attribution: "t", layout_copies: 4 }]);
    });
    const res = await new SupabasePlanStore("https://x.supabase.co", "sb_secret_test").searchPlans(filters);
    expect(res[0]!.layout_copies).toBe(4);
    return seen!;
  }

  it("filters out flagged plans and repeats by default", async () => {
    const u = await urlFor({});
    expect(u.searchParams.get("quality_flags")).toBe("eq.{}");
    expect(u.searchParams.get("layout_rank")).toBe("eq.1");
    expect(u.searchParams.get("select")).toContain("layout_copies");
  });

  it("drops the rank filter for include_duplicates but still hides flagged plans", async () => {
    const u = await urlFor({ includeDuplicates: true });
    expect(u.searchParams.get("layout_rank")).toBeNull();
    expect(u.searchParams.get("quality_flags")).toBe("eq.{}");
  });
});

describe("building type", () => {
  const office = { ...plan("hk-1-0", { area: 30 }), building_type: "office" as const };
  const store = new InMemoryPlanStore([plan("sd-1-a"), office]);

  it("treats records without building_type as residential and filters on it", async () => {
    expect((await store.searchPlans({ buildingType: "residential" })).map((p) => p.plan_id)).toEqual(["sd-1-a"]);
    expect((await store.searchPlans({ buildingType: "office" })).map((p) => p.plan_id)).toEqual(["hk-1-0"]);
  });

  it("parses building_type and rejects unknown values", () => {
    expect(parseSearchQuery({ building_type: "retail" })).toMatchObject({ ok: true, filters: { buildingType: "retail" } });
    expect(parseSearchQuery({ building_type: "castle" })).toMatchObject({ ok: false });
  });
});
