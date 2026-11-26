import { describe, expect, it } from "vitest";
import { cleanPolys, convertApartment, coveredArea, inferRoomUse, parseWkt, polyArea } from "../scripts/import/swiss-dwellings.js";
import { validatePlan } from "../src/db/validate.js";

const rect = (x0: number, y0: number, x1: number, y1: number) =>
  parseWkt(`POLYGON ((${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0}))`);

/**
 * Hand-built flat, walls 0.2 m thick:
 *   bedroom (0..4 x 0..4) | wall 4..4.2 with a door | hall (4.2..6 x 0..4)
 *   bath (4.2..6 x 4.2..6) above the hall, door between
 *   living (6..10 x 0..4) touches the hall directly (open plan, no wall)
 *   balcony (10.2..12 x 0..4) beyond the living room's east wall
 *   entrance door on the hall's south wall
 *   windows: one in the room's west wall; one between living and balcony
 */
function flat() {
  const area = (id: string, type: string, rings: ReturnType<typeof rect>) => ({
    id, type, floor: "f1", elevation: 0, rings, m2: rings.reduce((s, p) => s + polyArea(p), 0),
  });
  return {
    site: "1", building: "2", id: "abcdef0123456789abcdef0123456789",
    areas: [
      area("10", "ROOM", rect(0, 0, 4, 4)),
      area("11", "CORRIDOR", rect(4.2, 0, 6, 4)),
      area("12", "BATHROOM", rect(4.2, 4.2, 6, 6)),
      area("13", "LIVING_DINING", rect(6, 0, 10, 4)),
      area("14", "SHAFT", rect(9, 3, 9.5, 3.5)),
      area("15", "BALCONY", rect(10.2, 0, 12, 4)),
    ],
    doors: [
      { type: "DOOR", floor: "f1", rings: rect(4, 1, 4.2, 2) },
      { type: "DOOR", floor: "f1", rings: rect(5, 4, 5.8, 4.2) },
      { type: "ENTRANCE_DOOR", floor: "f1", rings: rect(4.5, -0.2, 5.5, 0) },
    ],
    windows: [
      { type: "WINDOW", floor: "f1", rings: rect(-0.2, 1, 0, 2) },
      { type: "WINDOW", floor: "f1", rings: rect(10, 1, 10.2, 2) }, // equidistant from living and balcony
    ],
    features: [
      { type: "SHOWER", areaId: "12" }, { type: "TOILET", areaId: "12" }, { type: "SINK", areaId: "12" },
      { type: "STAIRS", areaId: "11" },
    ],
  };
}

describe("WKT parsing", () => {
  it("subtracts holes from polygon area", () => {
    const [p] = parseWkt("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 2, 1 1))");
    expect(polyArea(p!)).toBe(15);
  });
  it("reads every part of a MULTIPOLYGON", () => {
    expect(parseWkt("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))")).toHaveLength(2);
  });
});

describe("convertApartment", () => {
  const { plan, vector } = convertApartment(flat())!;
  const edges = plan.adjacency_graph.edges.map((e) => `${[e.from, e.to].sort().join("~")}:${e.connection}`).sort();

  it("links rooms through doors, open boundaries and the entrance", () => {
    expect(edges).toEqual([
      "bathroom_1~hallway_1:door",
      "building_access~hallway_1:entrance_door",
      "hallway_1~living_dining_1:opening",
      "hallway_1~room_1:door",
    ]);
  });

  const node = (id: string) => plan.adjacency_graph.nodes.find((n) => n.id === id)!;

  it("keeps an unlabelled ROOM as type room, inferring bedroom from window, size and connections", () => {
    expect(node("room_1")).toMatchObject({ type: "room", inferred_use: "bedroom", windows: 1 });
    expect(plan.adjacency_graph.nodes.some((n) => n.type === "bedroom")).toBe(false);
    expect(plan.bedrooms).toBe(1);
    expect(plan.bedrooms_inferred).toBe(1);
  });

  it("credits a window between a room and a balcony to the room", () => {
    expect(node("living_dining_1").windows).toBe(1);
    expect(node("balcony_1").windows).toBe(0);
  });

  it("lists fixtures per room and keeps a shower room as a full bathroom", () => {
    expect(node("bathroom_1")).toMatchObject({ type: "bathroom", fixtures: ["shower", "sink", "toilet"] });
    expect(node("hallway_1")).not.toHaveProperty("fixtures"); // stairs are structure, not a fixture
    expect(plan.bathrooms).toBe(1);
    expect(plan.adjacency_graph.nodes.map((n) => n.id)).not.toContain("shaft_1");
  });

  it("keeps areas in m² and produces a valid, attributed CC BY record", () => {
    // 16 + 7.2 + 3.24 + 16 = 42.44 m² (the balcony is exterior and excluded)
    expect(plan.total_area_m2).toBeCloseTo(42.44, 2);
    expect(plan.adjacency_graph.units).toBe("m2");
    expect(node("room_1").area).toBe(16);
    expect(plan.provenance).toMatchObject({ source: "dataset", license: "CC-BY-4.0", built: true });
    expect(plan.provenance.attribution).toMatch(/CC BY 4.0.*Modified/);
    expect(validatePlan(plan).errors).toEqual([]);
  });

  it("turns a toilet-without-bath room into a WC counted as half a bath", () => {
    const f = flat();
    f.features = [{ type: "TOILET", areaId: "12" }, { type: "SINK", areaId: "12" }];
    const p = convertApartment(f)!.plan;
    expect(p.adjacency_graph.nodes.find((n) => n.id === "toilet_1")).toMatchObject({ type: "toilet", fixtures: ["sink", "toilet"] });
    expect(p.bathrooms).toBe(0.5);
    expect(validatePlan(p).errors).toEqual([]);
  });

  it("leaves a bathroom with no recorded fixtures as the source labelled it", () => {
    const f = flat();
    f.features = [];
    const p = convertApartment(f)!.plan;
    expect(p.adjacency_graph.nodes.find((n) => n.id === "bathroom_1")).not.toHaveProperty("fixtures");
    expect(p.bathrooms).toBe(1);
  });

  it("marks the room the front door opens into as an entry, not a bedroom", () => {
    const f = flat();
    f.doors[2] = { type: "ENTRANCE_DOOR", floor: "f1", rings: rect(1, -0.2, 2, 0) }; // into the ROOM
    const p = convertApartment(f)!.plan;
    expect(p.adjacency_graph.nodes.find((n) => n.id === "room_1")).toMatchObject({ inferred_use: "entry" });
    expect(p.bedrooms).toBe(0);
    expect(p.bedrooms_inferred).toBe(0);
  });

  it("emits a vector file with room polygons in metres", () => {
    expect(vector).toMatchObject({ plan_id: plan.plan_id, units: "m" });
    expect((vector as { rooms: unknown[] }).rooms).toHaveLength(5);
  });
});

describe("inferRoomUse", () => {
  const base = { isEntrance: false, connections: 1, windows: 1, outdoorDoors: 0, areaM2: 12 };
  it.each([
    [base, "bedroom"],
    [{ ...base, isEntrance: true }, "entry"],
    [{ ...base, windows: 0 }, "unknown"],
    [{ ...base, windows: 0, outdoorDoors: 1 }, "bedroom"], // glazed balcony door = daylight
    [{ ...base, areaM2: 5 }, "unknown"],
    [{ ...base, connections: 4 }, "unknown"],
  ])("%o -> %s", (input, expected) => expect(inferRoomUse(input)).toBe(expected));
});

describe("daylight evidence", () => {
  it("credits a ribbon window to every room it spans", () => {
    const f = flat();
    // 6 m long window along the south walls of the ROOM (x 0..4) and the hall (x 4.2..6)
    f.windows = [{ type: "WINDOW", floor: "f1", rings: rect(0, -0.2, 6, 0) }];
    const nodes = convertApartment(f)!.plan.adjacency_graph.nodes;
    expect(nodes.find((n) => n.id === "room_1")!.windows).toBe(1);
    expect(nodes.find((n) => n.id === "hallway_1")!.windows).toBe(1);
    expect(nodes.find((n) => n.id === "living_dining_1")!.windows).toBe(0);
  });

  it("treats a windowless room with a balcony door as daylit", () => {
    const f = flat();
    f.windows = [];
    f.areas.push({ id: "16", type: "BALCONY", floor: "f1", elevation: 0, rings: rect(-2, 0, -0.2, 4), m2: 7.2 });
    f.doors.push({ type: "DOOR", floor: "f1", rings: rect(-0.2, 1, 0, 2) }); // room <-> new balcony
    const p = convertApartment(f)!.plan;
    expect(p.adjacency_graph.nodes.find((n) => n.id === "room_1")).toMatchObject({ windows: 0, inferred_use: "bedroom" });
    expect(p.bedrooms).toBe(1);
  });

  it("leaves a windowless room with no outdoor door unknown", () => {
    const f = flat();
    f.windows = [];
    expect(convertApartment(f)!.plan.adjacency_graph.nodes.find((n) => n.id === "room_1")!.inferred_use).toBe("unknown");
  });
});

describe("geometry output", () => {
  it("uses the graph's room types (a WC is 'toilet' in both)", () => {
    const f = flat();
    f.features = [{ type: "TOILET", areaId: "12" }];
    const { plan, vector } = convertApartment(f)!;
    const rooms = (vector as { rooms: { id: string; type: string }[] }).rooms;
    for (const r of rooms) expect(r.type).toBe(plan.adjacency_graph.nodes.find((n) => n.id === r.id)!.type);
    expect(rooms.find((r) => r.id === "toilet_1")!.type).toBe("toilet");
  });

  it("drops near-duplicate vertices and rounds to the millimetre", () => {
    const [poly] = cleanPolys(parseWkt("POLYGON ((0 0, 0.0004 0.0002, 4 0, 4 0, 4 4.12345, 0 4, 0 0))"));
    expect(poly![0]).toEqual([[0, 0], [4, 0], [4, 4.123], [0, 4], [0, 0]]);
  });
});

describe("stairs", () => {
  /** Two-level maisonette: hall downstairs with a stair, landing upstairs where it arrives. */
  function maisonette(landing: ReturnType<typeof rect>, upperPieces: ReturnType<typeof rect>[]) {
    const f = flat();
    f.features = [
      { type: "STAIRS", areaId: "11", rings: rect(4.4, 1, 5.8, 3) },
      ...upperPieces.map((rings) => ({ type: "STAIRS", areaId: "21", rings })),
    ] as any;
    f.areas.push({ id: "21", type: "CORRIDOR", floor: "f2", elevation: 2.8, rings: landing, m2: landing.reduce((s, p) => s + polyArea(p), 0) });
    return convertApartment(f)!;
  }

  it("emits the flight downstairs and the opening upstairs, and deducts the opening once", () => {
    // landing 3 x 4 = 12 m²; two overlapping pieces cover 2 x 2 = 4 m² in total
    const { plan, vector } = maisonette(rect(4.2, 0, 7.2, 4), [rect(4.4, 1, 5.4, 3), rect(4.9, 1, 6.4, 3)]);
    const stairs = (vector as any).stairs;
    expect(stairs).toHaveLength(2);
    expect(stairs[0]).toMatchObject({ level: 1, to_level: 2, room: "hallway_1" });
    expect(stairs[1]).toMatchObject({ level: 2, from_level: 1, room: "hallway_2" });
    expect(stairs[1].polygon).toHaveLength(2); // fragments merged into one multi-part stair
    const landing = plan.adjacency_graph.nodes.find((n) => n.id === "hallway_2")!;
    expect(landing.area).toBeCloseTo(12 - 4, 1);
    expect(plan.adjacency_graph.edges).toContainEqual({ from: "hallway_1", to: "hallway_2", connection: "stair" });
  });

  it("flags a room that is all stairwell and leaves it out of the total", () => {
    const { plan } = maisonette(rect(4.4, 1, 5.8, 3), [rect(4.4, 1, 5.8, 3)]);
    const landing = plan.adjacency_graph.nodes.find((n) => n.id === "hallway_2")!;
    expect(landing).toMatchObject({ stairwell: true });
    expect(landing).not.toHaveProperty("area");
    expect(plan.total_area_m2).toBeCloseTo(42.44, 1); // unchanged by the stairwell
    expect(validatePlan(plan).errors).toEqual([]);
  });

  it("coveredArea counts overlaps once and clips to the room", () => {
    const pieces = [...rect(0, 0, 2, 2), ...rect(1, 0, 3, 2)]; // union 3 x 2 = 6
    expect(coveredArea(pieces, rect(0, 0, 10, 10))).toBeCloseTo(6, 1);
    expect(coveredArea(pieces, rect(0, 0, 1.5, 2))).toBeCloseTo(3, 1);
  });
});

describe("level registration", () => {
  it("shifts an upper level that doesn't overlap the one below so the stair lines up", () => {
    const f = flat();
    // upper landing drawn 20 m east of where it belongs; its stair piece too
    const off = (r: ReturnType<typeof rect>) => r.map((p) => p.map((ring) => ring.map(([x, y]) => [x + 20, y] as [number, number])));
    f.areas.push({ id: "21", type: "CORRIDOR", floor: "f2", elevation: 2.8, rings: off(rect(4.2, 0, 7.2, 4)), m2: 12 });
    f.features = [
      { type: "STAIRS", areaId: "11", rings: rect(4.4, 1, 5.8, 3) },
      { type: "STAIRS", areaId: "21", rings: off(rect(4.4, 1, 5.8, 3)) },
    ] as any;
    const v = convertApartment(f)!.vector as any;
    expect(v.crs).toMatch(/level 2 shifted by \(-20\.00, 0\.00\) m/);
    const landing = v.rooms.find((r: any) => r.id === "hallway_2");
    expect(landing.polygon[0][0][0]).toEqual([4.2, 0]);
    expect(v.stairs[1].polygon[0][0][0]).toEqual([4.4, 1]);
  });

  it("leaves aligned levels alone", () => {
    const f = flat();
    f.areas.push({ id: "21", type: "CORRIDOR", floor: "f2", elevation: 2.8, rings: rect(4.2, 0, 7.2, 4), m2: 12 });
    f.features = [
      { type: "STAIRS", areaId: "11", rings: rect(4.4, 1, 5.8, 3) },
      { type: "STAIRS", areaId: "21", rings: rect(4.4, 1, 5.8, 3) },
    ] as any;
    expect((convertApartment(f)!.vector as any).crs).toBe("site-local; +x east, +y north");
  });
});

describe("source quirks", () => {
  it("rejects the md5('') placeholder apartment id", async () => {
    const { isRealApartmentId } = await import("../scripts/import/swiss-dwellings.js");
    expect(isRealApartmentId("d41d8cd98f00b204e9800998ecf8427e")).toBe(false);
    expect(isRealApartmentId("")).toBe(false);
    expect(isRealApartmentId("3665ea60078cfcb890246c85f90d5a70")).toBe(true);
  });
});
