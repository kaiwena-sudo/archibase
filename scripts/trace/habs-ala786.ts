/**
 * Hand trace of HABS ALA-786 (204 S. Joachim St, Mobile AL), sheet 2, into Archibase
 * vector geometry. Rooms are built from the drawing's dimension strings (feet/inches),
 * then converted to metres.
 *
 *   npx tsx scripts/trace/habs-ala786.ts            # writes data/vectors/habs-ala786-mobile-creole-cottage.json
 *
 * Accuracy: rooms and windows follow the written dimensions (±2 cm). Doors without a
 * written dimension are placed from the drawing (±15 cm). Coordinates are plan-local
 * on the sheet (+x right, +y up the sheet = toward the rear); true north is not aligned.
 * Origin: south-west exterior corner of the front room (front wall, west side).
 */
import { writeFile } from "node:fs/promises";

type Pt = [number, number];
const FT = 0.3048;
const ft = (feet: number, inches = 0) => feet + inches / 12;
const m = (v: number) => Math.round(v * FT * 1000) / 1000;
/** Rectangle in feet -> closed ring in metres, wrapped as [polygon[ring]]. */
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[][][] => [[
  [[m(x0), m(y0)], [m(x1), m(y0)], [m(x1), m(y1)], [m(x0), m(y1)], [m(x0), m(y0)]],
]];

/** Arbitrary outline in feet (any angles) -> closed ring in metres, wrapped as [polygon[ring]]. */
const poly = (pts: [number, number][]): Pt[][][] => {
  const ring = pts.map(([x, y]): Pt => [m(x), m(y)]);
  return [[[...ring, ring[0]!]]];
};

// Wall thicknesses from the drawing: exterior 7", partitions 5½".
const EXT = ft(0, 7);
const PART = ft(0, 5.5);

// ---------- first floor (level 1) ----------
const frontX0 = EXT, frontX1 = EXT + ft(15, 3); //           front room 15'3" wide
const hallX0 = frontX1 + PART, hallX1 = hallX0 + ft(9, 7); // hall 9'7" wide
const frontY0 = EXT, frontY1 = EXT + ft(14, 1.5); //         front room 14'1½" deep
const backY0 = frontY1 + PART, backY1 = backY0 + ft(14, 6); // back room 14'6" deep
const backX1 = frontX1, backX0 = backX1 - ft(22, 3); //       back room 22'3" wide (extended west)
const frontWall = 0; // exterior face of the front wall

const rooms1 = [
  { id: "front_gallery", type: "porch", polygon: rect(0, -ft(6, 4), ft(26, 4.5), frontWall) },
  { id: "front_room", type: "room", polygon: rect(frontX0, frontY0, frontX1, frontY1) },
  { id: "hall", type: "stair_hall", polygon: rect(hallX0, frontY0, hallX1, backY1) },
  { id: "back_room", type: "room", polygon: rect(backX0, backY0, backX1, backY1) },
  // Side porch: under the back room's westward extension, beside the front room (6'2" deep).
  { id: "side_porch", type: "porch", polygon: rect(backX0, backY0 - PART - ft(6, 2), 0, backY0 - PART) },
];

// Front wall, from the west: 3'10" wall | 2'10½" window | 3'1" | 2'10" window | 5'11¼" | 5'4¼" door w/ sidelights | 2'5½"
const fw = [ft(3, 10), ft(2, 10.5), ft(3, 1), ft(2, 10), ft(5, 11.25), ft(5, 4.25)];
const at = (n: number) => fw.slice(0, n).reduce((s, v) => s + v, 0);
const windows1 = [
  { level: 1, polygon: rect(at(1), 0, at(2), EXT) }, //                front room, front
  { level: 1, polygon: rect(at(3), 0, at(4), EXT) }, //                front room, front
  { level: 1, polygon: rect(0, ft(6, 1), EXT, ft(6, 1) + ft(2, 10)) }, // front room, west: 6'1" up, 2'10"
  { level: 1, polygon: rect(backX0 - EXT, backY1 - ft(5, 4) - ft(2, 10), backX0, backY1 - ft(5, 4)) }, // back room, west
  { level: 1, polygon: rect(backX0 + ft(3, 5), backY1, backX0 + ft(6, 2), backY1 + EXT) }, //            back room, rear
  // Hall, east wall, from the rear: 3'10½" | 2'9½" window | 14'7" | 2'0" window
  { level: 1, polygon: rect(hallX1, backY1 - ft(3, 10.5) - ft(2, 9.5), hallX1 + EXT, backY1 - ft(3, 10.5)) },
  { level: 1, polygon: rect(hallX1, backY1 - ft(3, 10.5) - ft(2, 9.5) - ft(14, 7) - ft(2, 0), hallX1 + EXT, backY1 - ft(3, 10.5) - ft(2, 9.5) - ft(14, 7)) },
];
const doors1 = [
  { type: "entrance_door", level: 1, polygon: rect(at(5), 0, at(6), EXT) }, //                     front door + sidelights
  { type: "door", level: 1, polygon: rect(frontX1, ft(7), hallX0, ft(10)) }, //                    front room <-> hall
  { type: "door", level: 1, polygon: rect(backX1, backY0 + ft(6), hallX0, backY0 + ft(9)) }, //   back room <-> hall
  { type: "door", level: 1, polygon: rect(ft(0, 9), frontY1, ft(3, 6), backY0) }, //              front room <-> back room
  { type: "door", level: 1, polygon: rect(backX0 + ft(1, 9), backY0 - PART, backX0 + ft(4, 9), backY0) }, // back room <-> side porch (double)
];

// ---------- second floor (level 2): rooms under the roof, dormers to front and rear ----------
const upY0 = ft(9); //                                  knee wall line of the front rooms
const dormerDepth = ft(5, 5), dormerW = ft(3, 5);
const uFrontY1 = upY0 + ft(12, 6);
const uRearY0 = uFrontY1 + PART;

// Rear-dormer back room: 8'10" wide (the rest of the 15'3" after the 6'0" small room and a
// partition), 8'10" deep. Its lower edge is not straight: the partition steps down 2'4"
// toward the front, then runs back up at an angle to the hall wall (door in the angled run).
const bX0 = frontX0 + ft(6) + PART, bX1 = frontX1, bTop = uRearY0 + ft(8, 10);
const jog = ft(2, 4);
const backEdge: [number, number][] = [ // partition line, east to west, on the back room's side
  [bX1, uRearY0 - ft(0, 10)], //              hall wall, 10" below the main line
  [bX0 + ft(5, 4), uRearY0 - ft(1, 8)], //     angled run (holds the door)…
  [bX0 + ft(2, 8), uRearY0 - jog], //          …down to the 2'4" step
  [bX0 + ft(1, 6), uRearY0 - jog],
  [bX0 + ft(1, 6), uRearY0],
];
/** Point on the angled run at x (between its two ends). */
const onAngled = (x: number): number => {
  const [[xa, ya], [xb, yb]] = [backEdge[1]!, backEdge[2]!];
  return ya + ((x - xa) * (yb - ya)) / (xb - xa);
};

// Dormers are part of their rooms (no wall between), so each room is one outline.
const fdX0 = ft(6, 5), hdX0 = hallX0 + ft(2, 11);
const rooms2 = [
  { id: "upper_front_room", type: "room", polygon: poly([
    [frontX0, upY0], [fdX0, upY0], [fdX0, upY0 - dormerDepth], [fdX0 + dormerW, upY0 - dormerDepth], [fdX0 + dormerW, upY0],
    [frontX1, upY0],
    // top edge follows the back room's stepped/angled partition, one partition-width lower
    ...backEdge.map(([x, y], i): [number, number] => [i >= 3 ? x - PART : x, y - PART]),
    [bX0 + ft(1, 6) - PART, uFrontY1], [frontX0, uFrontY1],
  ]) },
  { id: "upper_hall", type: "stair_hall", polygon: poly([
    [hallX0, upY0], [hdX0, upY0], [hdX0, upY0 - dormerDepth], [hdX0 + dormerW, upY0 - dormerDepth], [hdX0 + dormerW, upY0],
    [hallX1, upY0], [hallX1, upY0 + ft(19, 10)], [hallX0, upY0 + ft(19, 10)],
  ]) },
  { id: "upper_small_room", type: "room", polygon: rect(frontX0, uRearY0, frontX0 + ft(6), uRearY0 + ft(7)) },
  { id: "upper_back_room", type: "room", polygon: poly([[bX0, uRearY0], [bX0, bTop], [bX1, bTop], ...backEdge.slice(0, 4), [bX0 + ft(1, 6), uRearY0]]) },
  { id: "pantry", type: "pantry", polygon: rect(frontX0, uRearY0 + ft(7) + PART, frontX0 + ft(6), uRearY0 + ft(7) + PART + ft(2, 6)) },
];
const windows2 = [
  { level: 2, polygon: rect(ft(6, 5) + ft(0, 3), upY0 - dormerDepth - EXT, ft(6, 5) + dormerW - ft(0, 3), upY0 - dormerDepth) }, // front room dormer
  { level: 2, polygon: rect(0, upY0 + ft(4, 2), EXT, upY0 + ft(4, 2) + ft(2, 10)) }, //                     front room, west
  { level: 2, polygon: rect(0, uRearY0 + ft(1, 8), EXT, uRearY0 + ft(1, 8) + ft(2, 10)) }, //                small room, west
  { level: 2, polygon: rect(hallX0 + ft(3, 2), upY0 - dormerDepth - EXT, hallX0 + ft(2, 11) + dormerW - ft(0, 3), upY0 - dormerDepth) }, // hall dormer
  { level: 2, polygon: rect(hallX1, upY0 + ft(4), hallX1 + EXT, upY0 + ft(6)) }, //                          hall, east (lower)
  { level: 2, polygon: rect(hallX1, upY0 + ft(14), hallX1 + EXT, upY0 + ft(16, 6)) }, //                     hall, east (upper)
  // Rear dormer: three sashes between posts.
  ...[0, 1, 2].map((i) => ({
    level: 2,
    polygon: rect(frontX1 - ft(8, 10) + ft(0, 6) + i * ft(2, 10), uRearY0 + ft(8, 10), frontX1 - ft(8, 10) + ft(0, 6) + i * ft(2, 10) + ft(2, 6), uRearY0 + ft(8, 10) + EXT),
  })),
];
const doors2 = [
  { type: "door", level: 2, polygon: rect(frontX1, uFrontY1 - ft(4, 6), hallX0, uFrontY1 - ft(1, 6)) }, //             front room <-> hall
  { type: "door", level: 2, polygon: (() => { //                                                                      front room <-> back room, in the angled run
    const [xa, xb] = [bX0 + ft(3), bX0 + ft(5)];
    return poly([[xa, onAngled(xa)], [xb, onAngled(xb)], [xb, onAngled(xb) - PART], [xa, onAngled(xa) - PART]]);
  })() },
  { type: "door", level: 2, polygon: rect(frontX0 + ft(1, 6), uFrontY1, frontX0 + ft(4), uRearY0) }, //                front room <-> small room
  { type: "door", level: 2, polygon: rect(frontX0 + ft(6), uRearY0 + ft(7, 7), bX0, uRearY0 + ft(8, 7)) }, //            back room <-> pantry
];

// Stair: one straight flight of 18 risers along the hall's east wall, "beginning at the
// rear" (HABS data pages), climbing toward the front. Width from the drawing (2'9");
// run taken from the second-floor stairwell (10'6"). The flight is floor area downstairs;
// upstairs the same footprint is the stairwell opening, cut out of the upper hall.
const stairFootprint = rect(hallX1 - ft(2, 9), backY1 - ft(1, 3) - ft(10, 6), hallX1, backY1 - ft(1, 3));
// Flight data: starts at the rear end and climbs toward the front. Total rise isn't recorded.
const stairX = hallX1 - ft(2, 9) / 2;
const flight = {
  risers: 18,
  start: [m(stairX), m(backY1 - ft(1, 3))] as Pt, //            bottom step, rear end
  end: [m(stairX), m(backY1 - ft(1, 3) - ft(10, 6))] as Pt, //  top, toward the front
  run: m(ft(10, 6)),
};
const stairs = [
  { id: "stair_1", level: 1, to_level: 2, room: "hall", ...flight, polygon: stairFootprint },
  { id: "stair_2", level: 2, from_level: 1, room: "upper_hall", ...flight, polygon: stairFootprint },
];
const upperHall = rooms2.find((r) => r.id === "upper_hall")!;
upperHall.polygon = [[upperHall.polygon[0]![0]!, [...stairFootprint[0]![0]!].reverse()]]; // outer ring + stairwell hole

const vector = {
  plan_id: "habs-ala786-mobile-creole-cottage",
  schema_version: 1,
  units: "m",
  crs: "plan-local, traced from HABS ALA-786 sheet 2: +x right, +y up the sheet (toward the rear); not true north",
  attribution: "Traced by Archibase from HABS ALA-786 (Historic American Buildings Survey, National Park Service, 1964), public domain. https://www.loc.gov/item/al0581/",
  rooms: [...rooms1.map((r) => ({ ...r, level: 1 })), ...rooms2.map((r) => ({ ...r, level: 2 }))],
  doors: [...doors1, ...doors2],
  windows: [...windows1, ...windows2],
  stairs,
};

const ringArea = (r: Pt[]) => Math.abs(r.slice(0, -1).reduce((s, p, i) => s + p[0] * r[i + 1]![1] - r[i + 1]![0] * p[1], 0)) / 2;
for (const r of vector.rooms) {
  const a = r.polygon.reduce((s, poly) => s + ringArea(poly[0]!) - poly.slice(1).reduce((h, ring) => h + ringArea(ring), 0), 0);
  console.log(`${r.id.padEnd(18)} level ${r.level}  ${a.toFixed(2)} m²`);
}
await writeFile(`data/vectors/${vector.plan_id}.json`, JSON.stringify(vector));
console.log(`wrote data/vectors/${vector.plan_id}.json`);
