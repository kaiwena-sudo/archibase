/**
 * Convert the Swiss Dwellings dataset (Archilyse AG, CC BY 4.0) into Archibase
 * plan records plus per-plan vector files.
 *
 *   unzip -p swiss-dwellings-v3.0.0.zip '*geometries.csv' \
 *     | npx tsx scripts/import/swiss-dwellings.ts --out incoming/swiss --rate 150
 *
 * Writes <out>/plans-0001.json, ... (5000 plans each; load with `npm run seed`) and
 * <out>/vectors/<plan_id>.json. --rate 1 imports every apartment (~45k); memory stays
 * bounded because the source is processed one site at a time.
 *
 * Only geometries.csv is read. locations.csv / location_ratings.csv tie buildings
 * to addresses and are deliberately ignored; geometry is in site-local metres.
 *
 * How the room graph is derived:
 *   - nodes: each area of a RESIDENTIAL apartment (shafts/voids dropped)
 *   - door edges: a DOOR's centroid lies within the wall between two rooms, so the
 *     two rooms nearest to it (< DOOR_REACH_M) are the ones it connects
 *   - opening edges: rooms whose outlines touch (no wall between them)
 *   - ENTRANCE_DOOR: connects the nearest room to a synthetic "building_access" node
 *   - stairs: rooms containing a STAIRS feature on different floors of the same
 *     apartment (maisonettes) are linked
 *   - bathrooms vs toilets: a source BATHROOM with a bathtub or shower stays "bathroom"
 *     (counts 1); one with a toilet but no bath/shower becomes "toilet" (a WC, counts 0.5)
 *   - fixtures: each room lists the fixtures recorded in it (toilet, sink, bathtub, ...)
 *   - windows: counted per room (each window goes to the nearest room)
 *   - bedrooms: BEDROOM areas, plus generic ROOM areas whose evidence says bedroom
 *     (see inferRoomUse); ROOMs stay type "room" with inferred_use, and the count of
 *     inferred ones is reported as bedrooms_inferred
 */
import { parse } from "csv-parse";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdjacencyEdge, AdjacencyNode, FloorPlan } from "../../src/db/client.js";
import { roundM2 } from "../../src/units.js";

const DOOR_REACH_M = 0.45;
const TOUCH_M = 0.05;
const DATASET_URL = "https://zenodo.org/records/7788422";
const ATTRIBUTION =
  "Swiss Dwellings v3.0.0 by M. Standfest, M. Franzen, Y. Schröder, L. Gonzalez Medina, " +
  "Y. Villanueva Hernandez, J. H. Buck (Archilyse AG), CC BY 4.0, " + DATASET_URL +
  ". Modified: converted by Archibase into room adjacency graphs.";

type Pt = [number, number];
type Ring = Pt[];
/** One polygon: outer ring first, then holes (e.g. a hallway wrapped around a bathroom). */
type Poly = Ring[];

interface Row {
  apartment_id: string;
  site_id: string;
  building_id: string;
  floor_id: string;
  unit_usage: string;
  area_id: string;
  entity_type: string;
  entity_subtype: string;
  geometry: string;
  elevation: string;
}

interface Area { id: string; type: string; floor: string; elevation: number; rings: Poly[]; m2: number }
interface Opening { type: string; floor: string; rings: Poly[] }
interface Feature { type: string; areaId: string; /** kept for STAIRS, which are sold as geometry */ rings?: Poly[] }
interface Apartment { site: string; building: string; id: string; areas: Area[]; doors: Opening[]; windows: Opening[]; features: Feature[] }

// ---------- geometry ----------

/** POLYGON / MULTIPOLYGON -> polygons, each [outer, ...holes]. */
export function parseWkt(wkt: string): Poly[] {
  const ring = (s: string): Ring => s.split(",").map((p) => p.trim().split(/\s+/).map(Number) as Pt);
  const polys: Poly[] = [];
  // Each polygon body looks like "(x y, ...), (x y, ...)" inside an outer pair of parens.
  for (const m of wkt.matchAll(/\(\s*(\([^()]+\)(?:\s*,\s*\([^()]+\))*)\s*\)/g)) {
    polys.push([...m[1]!.matchAll(/\(([^()]+)\)/g)].map((r) => ring(r[1]!)));
  }
  return polys;
}

export function polyArea(poly: Poly): number {
  const [outer, ...holes] = poly;
  return Math.max(0, ringArea(outer!) - holes.reduce((s, h) => s + ringArea(h), 0));
}

export function ringArea(r: Ring): number {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i]![0] * r[i + 1]![1] - r[i + 1]![0] * r[i]![1];
  return Math.abs(s) / 2;
}

function centroid(polys: Poly[]): Pt {
  let x = 0, y = 0, n = 0;
  for (const poly of polys) for (const p of poly[0]!.slice(0, -1)) { x += p[0]; y += p[1]; n++; }
  return [x / n, y / n];
}

/** Below this much standable floor (m²), a room that holds a stairwell opening is the stairwell. */
const STAIRWELL_MIN_FLOOR_M2 = 0.5;

/**
 * Area of the union of `pieces` that lies inside `clip`, sampled on a 5 cm grid. Overlapping
 * pieces are counted once. Accurate to roughly ±1% for room-sized shapes, which is plenty
 * for floor-area deductions.
 */
export function coveredArea(pieces: Poly[], clip: Poly[], step = 0.05): number {
  const pts = pieces.flatMap((p) => p[0]!);
  if (!pts.length) return 0;
  const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  const inPoly = (p: Pt, poly: Poly) => inside(p, poly[0]!) && !poly.slice(1).some((h) => inside(p, h));
  let hits = 0;
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let y = y0 + step / 2; y < y1; y += step) {
      const p: Pt = [x, y];
      if (pieces.some((q) => inPoly(p, q)) && clip.some((q) => inPoly(p, q))) hits++;
    }
  }
  return hits * step * step;
}

/**
 * Output cleanup: drop consecutive vertices closer than 1 cm (digitisation noise in the
 * source, e.g. repeated points) and round to the millimetre. Rings stay closed.
 */
export function cleanPolys(polys: Poly[]): Poly[] {
  const mm = (n: number) => Math.round(n * 1000) / 1000;
  return polys.map((poly) =>
    poly.map((ring) => {
      const out: Pt[] = [];
      for (const p of ring.slice(0, -1)) {
        const last = out[out.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.01) out.push([mm(p[0]), mm(p[1])]);
      }
      while (out.length > 1 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) < 0.01) out.pop();
      return out.length >= 3 ? [...out, out[0]!] : ring;
    }),
  );
}

/**
 * Points spread along an opening's long axis (at -80%, -40%, 0, +40%, +80% of its half-length),
 * staying clear of the very ends where a perpendicular partition wall could be nearer.
 */
export function samplesAlong(polys: Poly[]): Pt[] {
  const c = centroid(polys);
  const ring = polys[0]?.[0];
  if (!ring || ring.length < 3) return [c];
  let best: [number, number, number] = [0, 0, 0]; // dx, dy, length of the longest edge
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i + 1]![0] - ring[i]![0], dy = ring[i + 1]![1] - ring[i]![1];
    const len = Math.hypot(dx, dy);
    if (len > best[2]) best = [dx, dy, len];
  }
  if (!best[2]) return [c];
  const [ux, uy] = [best[0] / best[2], best[1] / best[2]];
  return [-0.8, -0.4, 0, 0.4, 0.8].map((t) => [c[0] + ux * t * best[2] / 2, c[1] + uy * t * best[2] / 2] as Pt);
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function inside(p: Pt, r: Ring): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!, [xj, yj] = r[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function pointToArea(p: Pt, polys: Poly[]): number {
  let best = Infinity;
  for (const [outer, ...holes] of polys) {
    if (inside(p, outer!) && !holes.some((h) => inside(p, h))) return 0;
    for (const r of [outer!, ...holes]) {
      for (let i = 0; i < r.length - 1; i++) best = Math.min(best, segDist(p, r[i]!, r[i + 1]!));
    }
  }
  return best;
}

function areaToArea(a: Poly[], b: Poly[]): number {
  let best = Infinity;
  for (const poly of a) for (const r of poly) for (const p of r) best = Math.min(best, pointToArea(p, b));
  for (const poly of b) for (const r of poly) for (const p of r) best = Math.min(best, pointToArea(p, a));
  return best;
}

// ---------- mapping ----------

const DROP = new Set(["SHAFT", "VOID", "AIR", "LIGHTWELL", "OUTDOOR_VOID", "ELEVATOR", "TRANSPORT_SHAFT"]);
const EXTERIOR = new Set(["BALCONY", "LOGGIA", "TERRACE", "GARDEN", "PATIO", "ARCADE"]);
const TYPE_MAP: Record<string, string> = {
  BEDROOM: "bedroom", ROOM: "room", LIVING_ROOM: "living_room", LIVING_DINING: "living_dining",
  KITCHEN: "kitchen", KITCHEN_DINING: "kitchen_dining", DINING: "dining_room", BATHROOM: "bathroom",
  CORRIDOR: "hallway", CORRIDORS_AND_HALLS: "hallway", FOYER: "foyer", STOREROOM: "storage",
  BALCONY: "balcony", LOGGIA: "loggia", TERRACE: "terrace", GARDEN: "garden", PATIO: "patio",
  WINTERGARTEN: "winter_garden", STAIRCASE: "stair", OFFICE: "office", STUDIO: "studio",
  WASH_AND_DRY_ROOM: "laundry", BASEMENT_COMPARTMENT: "storage", NOT_DEFINED: "room",
};

/**
 * The source uses md5("") as a placeholder apartment_id for units with no id (5,091 rows over
 * 11 sites). Grouping by it would merge unrelated units into one fake "apartment", so skip it.
 */
const EMPTY_ID_HASH = "d41d8cd98f00b204e9800998ecf8427e";
export const isRealApartmentId = (id: string | undefined): boolean => !!id && id !== EMPTY_ID_HASH;

/** Fixture features worth reporting per room (STAIRS/ELEVATOR/RAMP are structure, not fixtures). */
const FIXTURES = new Set(["TOILET", "SINK", "BATHTUB", "SHOWER", "KITCHEN", "WASHING_MACHINE", "BUILT_IN_FURNITURE"]);

/**
 * Source BATHROOM areas cover both WCs and full bathrooms. Split them by fixtures:
 *   bathroom — has a bathtub or shower (counts 1 bath)
 *   toilet   — has a toilet but no bathtub/shower, i.e. a WC / half bath (counts 0.5)
 *   bathroom — no fixtures recorded: left as the source labelled it (counts 1)
 */
export function bathroomType(fixtures: string[]): "bathroom" | "toilet" {
  const bathing = fixtures.includes("bathtub") || fixtures.includes("shower");
  return !bathing && fixtures.includes("toilet") ? "toilet" : "bathroom";
}

/**
 * What an unlabelled private room ("ROOM") most likely is.
 *   entry   — the front door opens into it
 *   bedroom — has daylight (a window, or a glazed door onto a balcony/loggia/terrace/winter
 *             garden), is big enough to sleep in (>= 6 m²), and is a
 *             destination rather than a through-route (<= 3 connections)
 *   unknown — anything else (e.g. a windowless box room, or a hub that rooms open off)
 */
export function inferRoomUse(r: {
  isEntrance: boolean;
  connections: number;
  windows: number;
  /** Doors/openings onto a balcony, loggia, terrace or winter garden: glazed, so they bring daylight. */
  outdoorDoors: number;
  areaM2: number;
}): string {
  if (r.isEntrance) return "entry";
  const daylight = r.windows >= 1 || r.outdoorDoors >= 1;
  if (daylight && r.areaM2 >= 6 && r.connections <= 3) return "bedroom";
  return "unknown";
}

export function convertApartment(apt: Apartment): { plan: FloorPlan; vector: unknown } | null {
  const areas = apt.areas.filter((a) => !DROP.has(a.type) && a.m2 > 0.3);
  if (!areas.length) return null;
  const floors = [...new Set(areas.map((a) => a.floor))].sort(
    (x, y) => (areas.find((a) => a.floor === x)!.elevation - areas.find((a) => a.floor === y)!.elevation),
  );
  const level = (floor: string) => floors.indexOf(floor) + 1;

  // Fixtures recorded inside each room (toilet, sink, bathtub, shower, kitchen, washing_machine, ...).
  const fixturesIn = new Map<string, string[]>();
  for (const f of apt.features) {
    if (!FIXTURES.has(f.type)) continue;
    const list = fixturesIn.get(f.areaId) ?? [];
    list.push(f.type.toLowerCase());
    fixturesIn.set(f.areaId, list);
  }

  const nodeId = new Map<string, string>();
  const counters = new Map<string, number>();
  const nodes: AdjacencyNode[] = areas.map((a) => {
    const fixtures = (fixturesIn.get(a.id) ?? []).sort();
    const type = a.type === "BATHROOM" ? bathroomType(fixtures) : (TYPE_MAP[a.type] ?? a.type.toLowerCase());
    const n = (counters.get(type) ?? 0) + 1;
    counters.set(type, n);
    const id = `${type}_${n}`;
    nodeId.set(a.id, id);
    const node: AdjacencyNode = { id, type, area: roundM2(a.m2) };
    if (fixtures.length) node.fixtures = fixtures;
    if (floors.length > 1) node.level = level(a.floor);
    if (EXTERIOR.has(a.type)) node.exterior = true;
    return node;
  });

  // Windows: credited to every room they light. Five points along the window's length each
  // go to their nearest *indoor* room, so a ribbon window spanning two rooms lights both,
  // and a window between a room and a balcony belongs to the room, not the balcony.
  const windowCount = new Map<string, number>();
  for (const w of apt.windows) {
    const lit = new Set<string>();
    for (const c of samplesAlong(w.rings)) {
      let best: { a: Area; dist: number; indoor: boolean } | undefined;
      for (const a of areas) {
        if (a.floor !== w.floor) continue;
        const dist = pointToArea(c, a.rings);
        if (dist >= DOOR_REACH_M) continue;
        const indoor = !EXTERIOR.has(a.type);
        if (!best || (indoor && !best.indoor) || (indoor === best.indoor && dist < best.dist)) best = { a, dist, indoor };
      }
      if (best) lit.add(best.a.id);
    }
    for (const id of lit) windowCount.set(id, (windowCount.get(id) ?? 0) + 1);
  }
  areas.forEach((a, i) => (nodes[i]!.windows = windowCount.get(a.id) ?? 0));

  const edges: AdjacencyEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (a: string, b: string, connection: string) => {
    if (a === b) return;
    const key = [a, b].sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: a, to: b, connection });
  };

  let hasAccess = false;
  for (const d of apt.doors) {
    const c = centroid(d.rings);
    const near = areas
      .filter((a) => a.floor === d.floor)
      .map((a) => ({ a, dist: pointToArea(c, a.rings) }))
      .filter((x) => x.dist < DOOR_REACH_M)
      .sort((x, y) => x.dist - y.dist);
    if (d.type === "ENTRANCE_DOOR") {
      if (near[0]) { addEdge("building_access", nodeId.get(near[0].a.id)!, "entrance_door"); hasAccess = true; }
    } else if (near.length >= 2) {
      addEdge(nodeId.get(near[0]!.a.id)!, nodeId.get(near[1]!.a.id)!, "door");
    }
  }
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      const a = areas[i]!, b = areas[j]!;
      if (a.floor !== b.floor) continue;
      const key = [nodeId.get(a.id), nodeId.get(b.id)].sort().join("|");
      if (seen.has(key)) continue;
      if (areaToArea(a.rings, b.rings) < TOUCH_M) addEdge(nodeId.get(a.id)!, nodeId.get(b.id)!, "opening");
    }
  }
  // Maisonettes: link stair-bearing rooms on consecutive levels.
  const stairAreas = new Set(apt.features.filter((f) => f.type === "STAIRS").map((f) => f.areaId));
  const stairByFloor = floors.map((fl) => areas.find((a) => a.floor === fl && stairAreas.has(a.id)));
  for (let i = 0; i + 1 < stairByFloor.length; i++) {
    const lo = stairByFloor[i], hi = stairByFloor[i + 1];
    if (lo && hi) addEdge(nodeId.get(lo.id)!, nodeId.get(hi.id)!, "stair");
  }
  // Stair roles: on the lower level a stair is a flight (floor area); on the level it arrives
  // at, its polygon marks the stairwell opening, which is not floor area.
  const stairRole = (f: Feature): { to_level?: number; from_level?: number } => {
    const a = areas.find((x) => x.id === f.areaId);
    if (!a) return {};
    const li = floors.indexOf(a.floor);
    if (stairByFloor[li]?.id !== a.id) return {};
    if (stairByFloor[li + 1]) return { to_level: li + 2 };
    if (li > 0 && stairByFloor[li - 1]) return { from_level: li };
    return {};
  };
  // The source stores a staircase as several (often overlapping) fragments per room. Group
  // them per room, and measure the stairwell opening as the area they cover inside the room.
  const stairPieces = new Map<string, Poly[]>();
  for (const f of apt.features) {
    if (f.type !== "STAIRS" || !f.rings || !areas.some((a) => a.id === f.areaId)) continue;
    stairPieces.set(f.areaId, [...(stairPieces.get(f.areaId) ?? []), ...f.rings]);
  }
  const openingM2 = new Map<string, number>();
  areas.forEach((a, i) => {
    const pieces = stairPieces.get(a.id);
    if (!pieces || !stairRole({ type: "STAIRS", areaId: a.id }).from_level) return;
    const cut = coveredArea(pieces, a.rings);
    const left = a.m2 - cut;
    if (left < STAIRWELL_MIN_FLOOR_M2) {
      // The "room" is essentially the stairwell: keep it in the graph (it links the floors)
      // but give it no floor area.
      openingM2.set(a.id, a.m2);
      delete nodes[i]!.area;
      nodes[i]!.stairwell = true;
    } else {
      openingM2.set(a.id, cut);
      nodes[i]!.area = roundM2(left);
    }
  });
  if (hasAccess) nodes.push({ id: "building_access", type: "building_circulation", exterior: true });

  // Archilyse "ROOM" is an unlabelled private room. Keep type "room" and record what the
  // evidence suggests, rather than presenting a guess as a bedroom.
  const degree = new Map<string, number>();
  for (const e of edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const entranceRooms = new Set(
    edges.filter((e) => e.connection === "entrance_door").map((e) => (e.from === "building_access" ? e.to : e.from)),
  );
  const outdoorIds = new Set(nodes.filter((n) => n.exterior || n.type === "winter_garden").map((n) => n.id));
  outdoorIds.delete("building_access");
  for (const n of nodes) {
    if (n.type !== "room") continue;
    n.inferred_use = inferRoomUse({
      isEntrance: entranceRooms.has(n.id),
      connections: degree.get(n.id) ?? 0,
      windows: (n.windows as number) ?? 0,
      outdoorDoors: edges.filter(
        (e) => (e.from === n.id && outdoorIds.has(e.to)) || (e.to === n.id && outdoorIds.has(e.from)),
      ).length,
      areaM2: n.area ?? 0,
    });
  }
  const bedroomsLabelled = nodes.filter((n) => n.type === "bedroom").length;
  const bedroomsInferred = nodes.filter((n) => n.type === "room" && n.inferred_use === "bedroom").length;

  // Derived from the node types so the count can't disagree with the graph.
  const bathrooms =
    nodes.filter((n) => n.type === "bathroom").length + 0.5 * nodes.filter((n) => n.type === "toilet").length;
  const interiorM2 = areas
    .filter((a) => !EXTERIOR.has(a.type))
    .reduce((s, a) => s + a.m2 - (openingM2.get(a.id) ?? 0), 0);
  const plan_id = `sd-${apt.site}-${apt.id.slice(0, 12)}`;

  const plan: FloorPlan = {
    plan_id,
    style: "unspecified",
    total_area_m2: roundM2(interiorM2),
    bedrooms: bedroomsLabelled + bedroomsInferred,
    bedrooms_inferred: bedroomsInferred,
    bathrooms,
    adjacency_graph: {
      units: "m2",
      nodes,
      edges,
      ...({
        source_ids: { site_id: apt.site, building_id: apt.building, apartment_id: apt.id },
        derivation:
          "Derived from Swiss Dwellings geometry: door centroids -> adjoining rooms; touching outlines -> openings; " +
          "windows -> nearest room. Source 'ROOM' areas are unlabelled private rooms: kept as type 'room' with an " +
          "inferred_use; those inferred as bedrooms are counted in bedrooms and in bedrooms_inferred.",
      } as object),
    },
    provenance: {
      source: "dataset",
      built: true,
      license: "CC-BY-4.0",
      author: "Archilyse AG",
      source_url: DATASET_URL,
      attribution: ATTRIBUTION,
    },
  };

  // Level registration: in a few source apartments an upper floor is not placed above the one
  // below (different local origin). If two consecutive levels don't overlap at all but share a
  // stair, shift the upper level so the stair's two ends line up, and record the shift.
  const offsets = new Map<string, Pt>(); // floor -> shift applied
  const shiftNotes: string[] = [];
  const bbox = (polys: Poly[]) => {
    const pts = polys.flatMap((p) => p[0]!);
    return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
  };
  for (let i = 1; i < floors.length; i++) {
    const lo = stairByFloor[i - 1], hi = stairByFloor[i];
    const loPieces = lo && stairPieces.get(lo.id), hiPieces = hi && stairPieces.get(hi.id);
    if (!loPieces || !hiPieces) continue;
    const [a0, a1] = [bbox(areas.filter((a) => a.floor === floors[i - 1]).flatMap((a) => a.rings)), bbox(areas.filter((a) => a.floor === floors[i]).flatMap((a) => a.rings))];
    const overlaps = Math.min(a0[2]!, a1[2]!) > Math.max(a0[0]!, a1[0]!) && Math.min(a0[3]!, a1[3]!) > Math.max(a0[1]!, a1[1]!);
    if (overlaps) continue;
    const prev = offsets.get(floors[i - 1]!) ?? [0, 0];
    const [cl, ch] = [centroid(loPieces), centroid(hiPieces)];
    const shift: Pt = [cl[0] + prev[0] - ch[0], cl[1] + prev[1] - ch[1]];
    offsets.set(floors[i]!, shift);
    shiftNotes.push(`level ${i + 1} shifted by (${shift[0].toFixed(2)}, ${shift[1].toFixed(2)}) m to align its stair with level ${i}`);
  }
  const place = (floor: string, polys: Poly[]): Poly[] => {
    const o = offsets.get(floor);
    const out = cleanPolys(polys);
    return o ? out.map((p) => p.map((r) => r.map(([x, y]) => [Math.round((x + o[0]) * 1000) / 1000, Math.round((y + o[1]) * 1000) / 1000] as Pt))) : out;
  };

  const vector = {
    plan_id,
    schema_version: 1,
    units: "m",
    crs: "site-local; +x east, +y north" + (shiftNotes.length ? `; source levels were not registered: ${shiftNotes.join("; ")}` : ""),
    attribution: ATTRIBUTION,
    // Room ids *and types* come from the graph nodes, so graph and geometry never disagree.
    rooms: areas.map((a, i) => ({ id: nodes[i]!.id, type: nodes[i]!.type, level: level(a.floor), polygon: place(a.floor, a.rings) })),
    doors: apt.doors.map((d) => ({ type: d.type.toLowerCase(), level: level(d.floor), polygon: place(d.floor, d.rings) })),
    windows: apt.windows.map((w) => ({ level: level(w.floor), polygon: place(w.floor, w.rings) })),
    // Internal stairs on every level they appear: the flight where it starts (to_level) and the
    // stairwell opening where it arrives (from_level; excluded from that room's area).
    // One entry per room the stair appears in, its fragments merged into one multi-part outline.
    stairs: [...stairPieces.entries()].map(([areaId, pieces], i) => {
      const a = areas.find((x) => x.id === areaId)!;
      return {
        id: `stair_${i + 1}`,
        level: level(a.floor),
        ...stairRole({ type: "STAIRS", areaId }),
        room: nodeId.get(areaId),
        polygon: place(a.floor, pieces),
      };
    }),
  };
  return { plan, vector };
}

// ---------- streaming ----------

function selected(site: string, apt: string, rate: number): boolean {
  return createHash("md5").update(`${site}:${apt}`).digest().readUInt32BE(0) % rate === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1]! : d;
  };
  const out = arg("--out", "incoming/swiss");
  const rate = Number(arg("--rate", "150"));
  const chunkSize = Number(arg("--chunk", "5000"));
  await mkdir(join(out, "vectors"), { recursive: true });

  // The source is grouped by site (each site's rows are contiguous), so apartments are
  // converted and written one site at a time; memory stays bounded even for --rate 1.
  let apts = new Map<string, Apartment>();
  let currentSite: string | undefined;
  const ids: string[] = [];
  let pending: FloorPlan[] = [];
  let chunk = 0, converted = 0, skipped = 0, sampled = 0;

  const writeChunk = async () => {
    if (!pending.length) return;
    chunk++;
    pending.sort((a, b) => a.plan_id.localeCompare(b.plan_id));
    await writeFile(join(out, `plans-${String(chunk).padStart(4, "0")}.json`), JSON.stringify(pending, null, 1) + "\n");
    pending = [];
  };
  const flushSite = async () => {
    for (const apt of apts.values()) {
      sampled++;
      const res = convertApartment(apt);
      if (!res) { skipped++; continue; }
      converted++;
      ids.push(res.plan.plan_id);
      pending.push(res.plan);
      await writeFile(join(out, "vectors", `${res.plan.plan_id}.json`), JSON.stringify(res.vector));
      if (pending.length >= chunkSize) await writeChunk();
    }
    apts = new Map();
  };

  const parser = process.stdin.pipe(parse({ columns: true, relax_column_count: true }));
  let rows = 0;
  for await (const row of parser as AsyncIterable<Row>) {
    rows++;
    if (row.site_id !== currentSite) {
      await flushSite();
      currentSite = row.site_id;
    }
    if (!isRealApartmentId(row.apartment_id) || row.unit_usage !== "RESIDENTIAL") continue;
    if (!selected(row.site_id, row.apartment_id, rate)) continue;
    const key = `${row.site_id}:${row.apartment_id}`;
    let apt = apts.get(key);
    if (!apt) {
      apt = { site: row.site_id, building: row.building_id, id: row.apartment_id, areas: [], doors: [], windows: [], features: [] };
      apts.set(key, apt);
    }
    const areaId = row.area_id ? String(Math.round(Number(row.area_id))) : "";
    if (row.entity_type === "area") {
      const rings = parseWkt(row.geometry);
      apt.areas.push({
        id: areaId, type: row.entity_subtype, floor: row.floor_id, elevation: Number(row.elevation) || 0,
        rings, m2: rings.reduce((s, poly) => s + polyArea(poly), 0),
      });
    } else if (row.entity_type === "opening") {
      const o = { type: row.entity_subtype, floor: row.floor_id, rings: parseWkt(row.geometry) };
      (row.entity_subtype === "WINDOW" ? apt.windows : apt.doors).push(o);
    } else if (row.entity_type === "feature") {
      apt.features.push({
        type: row.entity_subtype,
        areaId,
        ...(row.entity_subtype === "STAIRS" && { rings: parseWkt(row.geometry) }),
      });
    }
  }
  await flushSite();
  await writeChunk();
  // Lets an https bucket serve as the vector store (see src/db/vectors.ts).
  await writeFile(join(out, "vectors", "index.json"), JSON.stringify(ids.sort()));
  console.error(
    `read ${rows} rows; ${sampled} apartments sampled (1/${rate}); ${converted} converted, ${skipped} skipped -> ` +
      `${out}/plans-*.json (${chunk} file(s)) + vectors/`,
  );
}

if (process.argv[1]?.endsWith("swiss-dwellings.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
