#!/usr/bin/env node
// Archibase plan converter: turn a traced floor plan into an Archibase record + geometry, check it,
// and draw it. Zero dependencies; needs Node 18 or newer.
//
//   node archibase.mjs build    trace.json [--out DIR]          trace -> record + vector (+ report)
//   node archibase.mjs validate record.json [vector.json]       check files made by anyone
//   node archibase.mjs render   vector.json [--record record.json] [--out plan.svg] [--level N] [--ascii]
//
// Exit code 0 = no errors (warnings are fine to ship only if you've looked at them), 1 = errors, 2 = bad usage.
// Rules mirror the server's validator (src/db/validate.ts in the Archibase repo), so a file that passes
// here passes there. Format reference: ../references/format.md.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ vocabulary */

export const PLAN_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
export const BUILDING_TYPES = ["residential", "office", "retail", "transport", "government", "sports", "hospitality", "healthcare", "cultural", "education", "industrial", "mixed", "other"];
/** Licences a plan may be sold under; the value says whether an attribution line is required. */
export const LICENSES = { "public-domain": false, "CC0-1.0": false, "CC-BY-4.0": true, owned: false };
export const SOURCES = ["synthetic", "habs", "commissioned", "dataset", "ai_generated"];
const EXTERIOR = new Set(["balcony", "terrace", "loggia", "porch", "veranda", "garden", "parking", "outside", "planting", "yard"]);
const BEDROOM_TYPES = new Set(["bedroom", "primary_bedroom"]);
const HALF_BATH = new Set(["toilet", "wc", "powder_room"]);
const INFERRED_USES = new Set(["bedroom", "entry", "unknown"]);

// Geometry thresholds (metres). Traces draw rooms as the inside faces of walls, so rooms in
// different spaces are separated by a wall-thickness gap and doors sit in that gap.
const DOOR_REACH = 0.35; // a door links the rooms whose outline is within this of its centre
const WINDOW_REACH = 0.35;
const OPEN_TOUCH = 0.06; // outlines closer than this touch (no wall between)
const OPEN_MIN_SHARED = 0.6; // touching along at least this much = an open connection
const DOOR_THICK = 0.12;

/* ------------------------------------------------------------------ geometry */

const closeRing = (r) => {
  const a = r.map((p) => [Number(p[0]), Number(p[1])]);
  const f = a[0], l = a[a.length - 1];
  if (f && l && (f[0] !== l[0] || f[1] !== l[1])) a.push([f[0], f[1]]);
  return a;
};
const ringArea = (r) => {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(a / 2);
};
const roomArea = (room) => ringArea(room.outer) - room.holes.reduce((s, h) => s + ringArea(h), 0);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const distRing = (p, ring) => {
  let d = Infinity;
  for (let i = 0; i < ring.length - 1; i++) d = Math.min(d, segDist(p, ring[i], ring[i + 1]));
  return d;
};
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inRoom = (p, room) => inRing(p, room.outer) && !room.holes.some((h) => inRing(p, h));
/** 0 if the point is inside the room, else the distance to its outline. */
const distRoom = (p, room) => (inRoom(p, room) ? 0 : Math.min(distRing(p, room.outer), ...room.holes.map((h) => distRing(p, h))));

function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function selfIntersects(ring) {
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
  }
  return false;
}
const bbox = (rings) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
};
/** Area (m²) where two rooms overlap, estimated on a 0.1 m grid. */
function overlapArea(a, b) {
  const A = bbox([a.outer]), B = bbox([b.outer]);
  const x0 = Math.max(A[0], B[0]), x1 = Math.min(A[2], B[2]), y0 = Math.max(A[1], B[1]), y1 = Math.min(A[3], B[3]);
  if (x0 >= x1 || y0 >= y1) return 0;
  let n = 0;
  for (let x = x0 + 0.05; x < x1; x += 0.1) for (let y = y0 + 0.05; y < y1; y += 0.1) if (inRoom([x, y], a) && inRoom([x, y], b)) n++;
  return n * 0.01;
}
/** Length (m) of a's outline that lies within `tol` of b's outline. */
function sharedLength(a, b, tol) {
  let len = 0;
  for (let i = 0; i < a.outer.length - 1; i++) {
    const p = a.outer[i], q = a.outer[i + 1];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const steps = Math.max(1, Math.round(L / 0.05));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      if (distRing([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])], b.outer) <= tol) len += L / steps;
    }
  }
  return len;
}
/** A door or window line as a thin rectangle, the shape the geometry format uses. */
function stripRing(a, b, thick) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * (thick / 2), ny = (dx / L) * (thick / 2);
  return closeRing([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]].map(([x, y]) => [r3(x), r3(y)]));
}
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const isPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));

/* ------------------------------------------------------------------ validation (mirrors the server) */

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v, max = 200) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isHttps = (v) => { try { return new URL(v).protocol === "https:"; } catch { return false; } };

/** Check a record (the search-result shape). Returns { errors, warnings }. */
export function validateRecord(r) {
  const errors = [], warnings = [];
  if (!isObj(r)) return { errors: ["record must be an object"], warnings };
  if (typeof r.plan_id !== "string" || !PLAN_ID.test(r.plan_id)) errors.push("plan_id must be 3-80 chars of lowercase letters, digits and hyphens");
  if (typeof r.style !== "string" || !/^[a-z][a-z \-]{0,63}$/.test(r.style)) errors.push("style must be lowercase letters, spaces or hyphens");
  if (r.building_type !== undefined && !BUILDING_TYPES.includes(r.building_type)) errors.push(`building_type must be one of ${BUILDING_TYPES.join(", ")}`);
  if (typeof r.total_area_m2 !== "number" || !(r.total_area_m2 > 0) || r.total_area_m2 > 100000) errors.push("total_area_m2 must be a positive number of square metres <= 100000");
  if ("total_sqft" in r) errors.push("total_sqft is not stored; records are metric (total_area_m2)");
  if (!Number.isInteger(r.bedrooms) || r.bedrooms < 0 || r.bedrooms > 20) errors.push("bedrooms must be an integer 0-20");
  if (typeof r.bathrooms !== "number" || r.bathrooms < 0 || r.bathrooms > 20 || !Number.isInteger(r.bathrooms * 2)) errors.push("bathrooms must be a multiple of 0.5 between 0 and 20");
  if ("vector_schema_url" in r) errors.push("vector_schema_url is assigned by the API; don't store it");

  const g = r.adjacency_graph;
  if (!isObj(g) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    errors.push("adjacency_graph must have nodes[] and edges[]");
  } else {
    if (g.units !== "m2") errors.push('adjacency_graph.units must be "m2"');
    const ids = new Set();
    let bedroomNodes = 0, inferredBedrooms = 0, areaSum = 0;
    g.nodes.forEach((n, i) => {
      if (!isObj(n) || !nonEmpty(n.id, 64) || !nonEmpty(n.type, 64)) return errors.push(`adjacency_graph.nodes[${i}] needs string id and type`);
      if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
      ids.add(n.id);
      if (BEDROOM_TYPES.has(n.type)) bedroomNodes++;
      if (n.inferred_use !== undefined) {
        if (n.type !== "room") errors.push(`node "${n.id}": inferred_use is only for type "room" (unlabelled rooms)`);
        else if (!INFERRED_USES.has(n.inferred_use)) errors.push(`node "${n.id}": inferred_use must be one of ${[...INFERRED_USES].join(", ")}`);
        else if (n.inferred_use === "bedroom") inferredBedrooms++;
      }
      if (n.windows !== undefined && !(Number.isInteger(n.windows) && n.windows >= 0)) errors.push(`node "${n.id}": windows must be a non-negative integer`);
      if (n.area !== undefined) {
        if (typeof n.area !== "number" || n.area <= 0) errors.push(`node "${n.id}" area must be a positive number`);
        else if (!n.exterior) areaSum += n.area;
      }
    });
    if (ids.size === 0) errors.push("adjacency_graph has no rooms");
    g.edges.forEach((e, i) => {
      if (!isObj(e) || typeof e.from !== "string" || typeof e.to !== "string" || !nonEmpty(e.connection, 64)) return errors.push(`adjacency_graph.edges[${i}] needs from, to and connection`);
      if (!ids.has(e.from)) errors.push(`edge ${i} references unknown room "${e.from}"`);
      if (!ids.has(e.to)) errors.push(`edge ${i} references unknown room "${e.to}"`);
      if (e.from === e.to) errors.push(`edge ${i} connects "${e.from}" to itself`);
    });
    if (Number.isInteger(r.bedrooms) && bedroomNodes + inferredBedrooms !== r.bedrooms) {
      errors.push(`bedrooms is ${r.bedrooms} but the graph has ${bedroomNodes} bedroom node(s)` + (inferredBedrooms ? ` + ${inferredBedrooms} room(s) inferred as bedrooms` : ""));
    }
    if ((r.bedrooms_inferred ?? 0) !== inferredBedrooms) errors.push(`bedrooms_inferred is ${r.bedrooms_inferred ?? 0} but ${inferredBedrooms} room(s) have inferred_use "bedroom"`);
    if (areaSum > 0 && typeof r.total_area_m2 === "number") {
      const ratio = areaSum / r.total_area_m2;
      if (ratio < 0.7 || ratio > 1.15) warnings.push(`room areas sum to ${r2(areaSum)} m² vs total_area_m2 ${r.total_area_m2} (${Math.round(ratio * 100)}%)`);
    }
  }

  const p = r.provenance;
  if (!isObj(p)) {
    errors.push("provenance is required (source, built, license)");
  } else {
    if (!SOURCES.includes(p.source)) errors.push(`provenance.source must be one of ${SOURCES.join(", ")}`);
    if (typeof p.built !== "boolean") errors.push("provenance.built must be true or false");
    if (!(p.license in LICENSES)) errors.push(`provenance.license "${String(p.license)}" does not allow resale; accepted: ${Object.keys(LICENSES).join(", ")}`);
    else if (LICENSES[p.license] && !nonEmpty(p.attribution, 500)) errors.push(`provenance.attribution is required for ${p.license}`);
    if (p.author !== undefined && !nonEmpty(p.author)) errors.push("provenance.author must be a non-empty string");
    if (p.source_url !== undefined && !isHttps(p.source_url)) errors.push("provenance.source_url must be an https URL");
    if ((p.source === "synthetic" || p.source === "ai_generated") && p.built) errors.push(`a ${p.source} plan cannot be built: true`);
    if (p.source === "habs") {
      if (p.built !== true) errors.push("HABS/HAER/HALS drawings document built structures; built must be true");
      if (p.license !== "public-domain") errors.push('habs records must use license "public-domain"');
      if (!isHttps(p.source_url)) errors.push("habs records need source_url (the loc.gov item)");
    }
    if (p.source === "commissioned") {
      if (p.license !== "owned") errors.push('commissioned records must use license "owned" (rights assigned in writing)');
      if (!nonEmpty(r.rights_ref)) errors.push("commissioned records need rights_ref (the signed agreement)");
      if (!nonEmpty(p.author)) errors.push("commissioned records need provenance.author");
    }
    if (p.source === "dataset" && !isHttps(p.source_url)) errors.push("dataset records need source_url pointing at the dataset and its licence");
  }
  return { errors, warnings };
}

/** Check a geometry file against its record (ids match, rings closed, no overlaps, plausible scale). */
export function validateVector(v, record) {
  const errors = [], warnings = [];
  if (!isObj(v)) return { errors: ["vector must be an object"], warnings };
  if (v.units !== "m") errors.push('vector.units must be "m"');
  if (record && v.plan_id !== record.plan_id) errors.push(`vector.plan_id "${v.plan_id}" doesn't match the record's "${record.plan_id}"`);
  if (!Array.isArray(v.rooms) || !v.rooms.length) return { errors: [...errors, "vector.rooms must be a non-empty array"], warnings };
  const checkPolys = (polys, label) => {
    if (!Array.isArray(polys) || !polys.length) return errors.push(`${label}: polygon must be a non-empty list`), false;
    for (const poly of polys) for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4) return errors.push(`${label}: a ring needs at least 4 points (closed)`), false;
      if (!ring.every(isPt)) return errors.push(`${label}: ring has a non-numeric point`), false;
      const f = ring[0], l = ring[ring.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) return errors.push(`${label}: ring is not closed (first point must equal last)`), false;
    }
    return true;
  };
  const rooms = [];
  const seen = new Set();
  v.rooms.forEach((r, i) => {
    const label = `rooms[${i}] "${r && r.id}"`;
    if (!isObj(r) || !nonEmpty(r.id, 64) || !nonEmpty(r.type, 64) || !Number.isInteger(r.level)) return errors.push(`${label}: needs id, type and integer level`);
    if (seen.has(r.id)) errors.push(`${label}: duplicate id`);
    seen.add(r.id);
    if (!checkPolys(r.polygon, label)) return;
    rooms.push({ id: r.id, type: r.type, level: r.level, outer: r.polygon[0][0], holes: r.polygon[0].slice(1) });
  });
  for (const key of ["doors", "windows"]) (v[key] || []).forEach((d, i) => { if (!Number.isInteger(d.level)) errors.push(`${key}[${i}]: needs integer level`); checkPolys(d.polygon, `${key}[${i}]`); });
  if (record && isObj(record.adjacency_graph) && Array.isArray(record.adjacency_graph.nodes)) {
    const nodeIds = new Set(record.adjacency_graph.nodes.filter((n) => n.type !== "outside" && !n.virtual).map((n) => n.id));
    for (const id of nodeIds) if (!seen.has(id)) errors.push(`graph node "${id}" has no room in the geometry`);
    for (const id of seen) if (!nodeIds.has(id)) errors.push(`geometry room "${id}" has no node in the graph`);
  }

  // Shape and scale sanity. These catch the usual mistakes: a wrong scale, a skipped room, a bad trace.
  for (const r of rooms) {
    if (selfIntersects(r.outer)) errors.push(`room "${r.id}": its outline crosses itself`);
    const a = roomArea(r);
    if (!(a > 0)) errors.push(`room "${r.id}": zero area`);
    else if (!EXTERIOR.has(r.type) && a < 1 && r.type !== "closet" && r.type !== "storage") warnings.push(`room "${r.id}" is only ${r2(a)} m²: a sliver, or a wrong scale?`);
    if (BEDROOM_TYPES.has(r.type) && (a < 4 || a > 60)) warnings.push(`bedroom "${r.id}" is ${r2(a)} m²: implausible, check the scale`);
  }
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
    if (rooms[i].level !== rooms[j].level) continue;
    const o = overlapArea(rooms[i], rooms[j]);
    const small = Math.min(roomArea(rooms[i]), roomArea(rooms[j]));
    if (o > 0.1 * small && o > 0.3) errors.push(`rooms "${rooms[i].id}" and "${rooms[j].id}" overlap by ${r2(o)} m² (${Math.round((o / small) * 100)}% of the smaller): trace each room as the inside of its walls`);
    else if (o > 0.02 * small && o > 0.15) warnings.push(`rooms "${rooms[i].id}" and "${rooms[j].id}" overlap by ${r2(o)} m²`);
  }
  const doorLens = (v.doors || []).filter((d) => d.type !== "entrance_door" || true).map((d) => {
    const ring = d.polygon[0]?.[0];
    if (!ring || ring.length < 4) return 0;
    const sides = [Math.hypot(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]), Math.hypot(ring[2][0] - ring[1][0], ring[2][1] - ring[1][1])];
    return Math.max(...sides);
  }).filter((x) => x > 0).sort((a, b) => a - b);
  if (doorLens.length >= 2) {
    const med = doorLens[Math.floor(doorLens.length / 2)];
    if (med < 0.6 || med > 1.4) warnings.push(`median door width is ${r2(med)} m (normal is 0.7-1.1 m): the scale is probably wrong`);
  }
  return { errors, warnings };
}

/* ------------------------------------------------------------------ build: trace -> record + vector */

/**
 * Trace format (all coordinates in metres, +x right, +y up, any origin):
 *  plan_id, style?, building_type?, provenance{source,built,license,author?,source_url?,attribution?}, rights_ref?,
 *  transcription{method,scale_basis,confidence,notes}?, rooms[{id,type,level?,polygon,holes?,fixtures?,inferred_use?,stairwell?}],
 *  doors[{type?:"door"|"entrance_door",level?,from:[x,y],to:[x,y]}], windows[{level?,from,to}],
 *  stairs[{room, arrival_room?, to_level?, from_level?, risers?, start?, end?, run?, rise?}]
 */
export function build(trace) {
  const errors = [], warnings = [];
  const fail = (m) => (errors.push(m), null);
  if (!isObj(trace)) return { errors: ["trace must be an object"], warnings };
  if (!Array.isArray(trace.rooms) || !trace.rooms.length) return { errors: ["trace.rooms must list at least one room"], warnings };

  const rooms = [];
  const seen = new Set();
  trace.rooms.forEach((t, i) => {
    const label = `rooms[${i}] "${t && t.id}"`;
    if (!isObj(t) || !nonEmpty(t.id, 64) || !nonEmpty(t.type, 64)) return fail(`${label}: needs a string id and type`);
    if (seen.has(t.id)) return fail(`${label}: duplicate id`);
    seen.add(t.id);
    if (!Array.isArray(t.polygon) || t.polygon.length < 3 || !t.polygon.every(isPt)) return fail(`${label}: polygon needs at least 3 [x, y] points`);
    const holes = (t.holes || []).map(closeRing);
    rooms.push({
      id: t.id, type: t.type, level: Number.isInteger(t.level) ? t.level : 1, outer: closeRing(t.polygon).map(([x, y]) => [r3(x), r3(y)]), holes,
      fixtures: Array.isArray(t.fixtures) ? t.fixtures : undefined, inferred_use: t.inferred_use, stairwell: t.stairwell === true,
    });
  });
  if (errors.length) return { errors, warnings };

  const levels = [...new Set(rooms.map((r) => r.level))];
  const outsideLevel = (d) => (Number.isInteger(d.level) ? d.level : levels[0]);
  const edgeKey = (a, b) => [a, b].sort().join("|");
  const edges = new Map();
  const addEdge = (from, to, connection, strong = false) => {
    if (from === to) return;
    const k = edgeKey(from, to);
    const e = edges.get(k);
    if (!e || (strong && e.connection === "opening")) edges.set(k, { from, to, connection });
  };

  // Doors: link the two rooms nearest the door centre (within reach). One room + entrance_door = the way in.
  const doors = [];
  let hasOutside = false;
  (trace.doors || []).forEach((d, i) => {
    if (!isPt(d && d.from) || !isPt(d && d.to)) return fail(`doors[${i}]: needs from and to points`);
    const level = outsideLevel(d), type = d.type === "entrance_door" ? "entrance_door" : "door";
    const c = mid(d.from, d.to);
    const near = rooms.filter((r) => r.level === level).map((r) => ({ r, d: distRoom(c, r) })).filter((x) => x.d <= DOOR_REACH).sort((a, b) => a.d - b.d);
    doors.push({ type, level, ring: stripRing(d.from, d.to, DOOR_THICK), width: Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) });
    if (type === "entrance_door" && near[0]) { addEdge("outside", near[0].r.id, "entrance_door", true); hasOutside = true; }
    else if (near.length >= 2) addEdge(near[0].r.id, near[1].r.id, "door", true);
    else warnings.push(`doors[${i}] at (${r2(c[0])}, ${r2(c[1])}) level ${level}: found ${near.length} room within ${DOOR_REACH} m, expected 2 (or 1 for an entrance). Is it drawn across the wall between two rooms?`);
  });

  // Open connections: outlines that touch along 0.6 m or more, with no wall between.
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
    const a = rooms[i], b = rooms[j];
    if (a.level !== b.level || a.stairwell || b.stairwell) continue;
    if (sharedLength(a, b, OPEN_TOUCH) >= OPEN_MIN_SHARED) addEdge(a.id, b.id, "opening");
  }

  // Windows: sample 5 points along each; each point lights the nearest room within reach (interior rooms first).
  const windowCount = new Map(rooms.map((r) => [r.id, 0]));
  const windows = [];
  (trace.windows || []).forEach((w, i) => {
    if (!isPt(w && w.from) || !isPt(w && w.to)) return fail(`windows[${i}]: needs from and to points`);
    const level = outsideLevel(w);
    const lit = new Set();
    for (let s = 0; s < 5; s++) {
      const t = (s + 0.5) / 5;
      const p = [w.from[0] + t * (w.to[0] - w.from[0]), w.from[1] + t * (w.to[1] - w.from[1])];
      const near = rooms.filter((r) => r.level === level && !r.stairwell).map((r) => ({ r, d: distRoom(p, r) })).filter((x) => x.d <= WINDOW_REACH);
      const indoor = near.filter((x) => !EXTERIOR.has(x.r.type));
      const pick = (indoor.length ? indoor : near).sort((a, b) => a.d - b.d)[0];
      if (pick) lit.add(pick.r.id);
    }
    if (!lit.size) warnings.push(`windows[${i}] on level ${level} isn't within ${WINDOW_REACH} m of any room: it was drawn but counts for nothing`);
    for (const id of lit) windowCount.set(id, windowCount.get(id) + 1);
    windows.push({ level, ring: stripRing(w.from, w.to, DOOR_THICK) });
  });

  // Stairs: link the footprint to the room it arrives in, and record the climb.
  const stairs = [];
  (trace.stairs || []).forEach((s, i) => {
    const low = rooms.find((r) => r.id === s.room);
    if (!low) return fail(`stairs[${i}]: room "${s.room}" is not a room id`);
    const upper = s.arrival_room ? rooms.find((r) => r.id === s.arrival_room) : undefined;
    if (s.arrival_room && !upper) return fail(`stairs[${i}]: arrival_room "${s.arrival_room}" is not a room id`);
    const base = { room: low.id, ...(s.risers !== undefined && { risers: s.risers }), ...(isPt(s.start) && { start: s.start }), ...(isPt(s.end) && { end: s.end }), ...(s.run !== undefined && { run: s.run }), ...(s.rise !== undefined && { rise: s.rise }) };
    stairs.push({ id: low.id, level: low.level, to_level: Number.isInteger(s.to_level) ? s.to_level : upper ? upper.level : low.level + 1, polygon: [[low.outer, ...low.holes]], ...base });
    if (upper) {
      stairs.push({ id: `${low.id}-arrival`, level: upper.level, from_level: low.level, room: upper.id, polygon: [[upper.outer, ...upper.holes]] });
      addEdge(low.id, upper.id, "stair", true);
    }
  });
  if (errors.length) return { errors, warnings };

  const nodes = rooms.map((r) => {
    const exterior = EXTERIOR.has(r.type);
    const n = { id: r.id, type: r.type };
    if (!r.stairwell) n.area = r2(roomArea(r));
    n.windows = windowCount.get(r.id) || 0;
    if (r.fixtures) n.fixtures = r.fixtures;
    if (exterior) n.exterior = true;
    if (r.stairwell) n.stairwell = true;
    if (r.inferred_use) n.inferred_use = r.inferred_use;
    return n;
  });
  if (hasOutside) nodes.push({ id: "outside", type: "outside", exterior: true });

  const interior = rooms.filter((r) => !EXTERIOR.has(r.type) && !r.stairwell);
  const total = r2(interior.reduce((s, r) => s + roomArea(r), 0));
  const inferredBedrooms = rooms.filter((r) => r.type === "room" && r.inferred_use === "bedroom").length;
  const bedrooms = rooms.filter((r) => BEDROOM_TYPES.has(r.type)).length + inferredBedrooms;
  const bathrooms = rooms.filter((r) => r.type === "bathroom").length + 0.5 * rooms.filter((r) => HALF_BATH.has(r.type)).length;

  const prov = isObj(trace.provenance) ? { ...trace.provenance } : undefined;
  const record = {
    plan_id: trace.plan_id,
    style: trace.style ?? "unspecified",
    building_type: trace.building_type ?? "residential",
    total_area_m2: total,
    bedrooms,
    bedrooms_inferred: inferredBedrooms,
    bathrooms,
    adjacency_graph: {
      units: "m2",
      nodes,
      edges: [...edges.values()],
      derivation: "Traced by hand into metres; rooms are the inside faces of walls. Door lines link the two rooms nearest their centre, an entrance_door links one room to the outside, rooms whose outlines touch for 0.6 m or more are linked as 'opening', and each window counts for every room within 0.35 m of its line. Areas are polygon areas; total_area_m2 excludes balconies and stairwell openings.",
      ...(isObj(trace.transcription) && { transcription: trace.transcription }),
    },
    provenance: prov,
    ...(trace.rights_ref !== undefined && { rights_ref: trace.rights_ref }),
  };
  const attribution = prov && prov.attribution;
  const vector = {
    plan_id: trace.plan_id,
    schema_version: 1,
    units: "m",
    crs: "plan-local metres; +x right, +y up (as drawn); traced by hand",
    ...(attribution && { attribution }),
    rooms: rooms.map((r) => ({ id: r.id, type: r.type, level: r.level, polygon: [[r.outer, ...r.holes]] })),
    doors: doors.map((d) => ({ type: d.type, level: d.level, polygon: [[d.ring]] })),
    windows: windows.map((w) => ({ level: w.level, polygon: [[w.ring]] })),
    stairs,
  };

  const a = validateRecord(record), b = validateVector(vector, record);
  return { record, vector, errors: [...errors, ...a.errors, ...b.errors], warnings: [...warnings, ...a.warnings, ...b.warnings] };
}

/* ------------------------------------------------------------------ render */

const COLOUR = { bedroom: "#dce8fb", bathroom: "#dcf1e4", toilet: "#dcf1e4", kitchen: "#fbe9d0", living: "#efe4f6", dining: "#efe4f6", hallway: "#f7f3e3", corridor: "#f7f3e3", balcony: "#ececec", stairs: "#cfcfcf", storage: "#e8e1d6" };
const LETTER = { bedroom: "B", primary_bedroom: "B", bathroom: "T", toilet: "t", wc: "t", kitchen: "K", living: "L", living_dining: "L", dining: "D", hallway: "h", corridor: "c", balcony: "b", terrace: "b", storage: "s", closet: "s", stairs: "S", entry: "e", office: "O", room: "R" };

/** Draw one level as SVG (rooms, doors, windows, labels, 5 m scale bar). */
export function renderSvg(vector, record, level) {
  const lv = level ?? vector.rooms[0].level;
  const rooms = vector.rooms.filter((r) => r.level === lv);
  const [x0, y0, x1, y1] = bbox(rooms.flatMap((r) => r.polygon[0]));
  const k = 40, pad = 24, W = Math.max((x1 - x0) * k + pad * 2, pad + 5 * k + 50), H = (y1 - y0) * k + pad * 2 + 28;
  const P = ([x, y]) => `${(pad + (x - x0) * k).toFixed(1)} ${(pad + (y1 - y) * k).toFixed(1)}`;
  const d = (poly) => poly.map((ring) => "M" + ring.map(P).join("L") + "Z").join("");
  const areas = new Map(((record && record.adjacency_graph.nodes) || []).map((n) => [n.id, n.area]));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let s = `<rect width="100%" height="100%" fill="#fff"/>`;
  for (const r of rooms) s += `<path d="${d(r.polygon[0])}" fill="${COLOUR[r.type] ?? "#f2f2f2"}" stroke="#2a2d33" stroke-width="2"/>`;
  for (const o of (vector.doors || []).filter((x) => x.level === lv)) s += `<path d="${d(o.polygon[0])}" fill="${o.type === "entrance_door" ? "#d0402b" : "#9a6a3a"}"/>`;
  for (const o of (vector.windows || []).filter((x) => x.level === lv)) s += `<path d="${d(o.polygon[0])}" fill="#1f4fd1"/>`;
  for (const r of rooms) {
    const ring = r.polygon[0][0];
    const c = P([(Math.min(...ring.map((p) => p[0])) + Math.max(...ring.map((p) => p[0]))) / 2, (Math.min(...ring.map((p) => p[1])) + Math.max(...ring.map((p) => p[1]))) / 2]).split(" ");
    s += `<text x="${c[0]}" y="${c[1] - 2}" font-size="12" font-family="sans-serif" text-anchor="middle" font-weight="600">${esc(r.id)}</text>`;
    if (areas.get(r.id)) s += `<text x="${c[0]}" y="${+c[1] + 12}" font-size="11" font-family="monospace" text-anchor="middle" fill="#555">${areas.get(r.id)} m²</text>`;
  }
  s += `<path d="M${pad} ${H - 12}h${5 * k}" stroke="#000" stroke-width="3"/><text x="${pad + 5 * k + 6}" y="${H - 8}" font-size="11" font-family="monospace">5 m</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}">${s}</svg>`;
}

/** A text picture for agents that can't look at images: one letter per room, + doors, @ entrance, = windows. */
export function renderAscii(vector, level, cols = 88) {
  const lv = level ?? vector.rooms[0].level;
  const rooms = vector.rooms.filter((r) => r.level === lv).map((r) => ({ ...r, outer: r.polygon[0][0], holes: r.polygon[0].slice(1) }));
  const [x0, y0, x1, y1] = bbox(rooms.map((r) => r.outer));
  const dx = Math.max((x1 - x0) / cols, 0.05), dy = dx * 2;
  const nx = Math.ceil((x1 - x0) / dx) + 1, ny = Math.ceil((y1 - y0) / dy) + 1;
  const grid = Array.from({ length: ny }, () => Array(nx).fill(" "));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = [x0 + (i + 0.5) * dx, y1 - (j + 0.5) * dy];
    const r = rooms.find((q) => inRoom(p, q));
    if (r) grid[j][i] = LETTER[r.type] ?? r.type[0];
  }
  const mark = (poly, ch) => {
    const ring = poly[0][0];
    const [a, b, c, e] = bbox([ring]);
    const i = Math.min(nx - 1, Math.max(0, Math.round(((a + c) / 2 - x0) / dx - 0.5))), j = Math.min(ny - 1, Math.max(0, Math.round((y1 - (b + e) / 2) / dy - 0.5)));
    grid[j][i] = ch;
  };
  for (const o of (vector.doors || []).filter((x) => x.level === lv)) mark(o.polygon, o.type === "entrance_door" ? "@" : "+");
  for (const o of (vector.windows || []).filter((x) => x.level === lv)) mark(o.polygon, "=");
  const legend = rooms.map((r) => `${LETTER[r.type] ?? r.type[0]} = ${r.id}`).join("   ");
  return `${grid.map((row) => row.join("").replace(/\s+$/, "")).join("\n")}\n\n${legend}\n+ door   @ entrance   = window   (one column ≈ ${r2(dx)} m, one row ≈ ${r2(dy)} m, north is up)`;
}

/* ------------------------------------------------------------------ command line */

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const opt = (args, k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
function report(errors, warnings) {
  for (const e of errors) console.error("  ERROR  " + e);
  for (const w of warnings) console.error("  warn   " + w);
  console.error(errors.length ? `${errors.length} error(s), ${warnings.length} warning(s): fix the errors and run again.` : warnings.length ? `OK, with ${warnings.length} warning(s): look at each one before you ship.` : "OK: no errors, no warnings.");
}

function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || !file) {
    console.error("usage: archibase.mjs build trace.json [--out DIR] | validate record.json [vector.json] | render vector.json [--record record.json] [--out plan.svg] [--level N] [--ascii]");
    return 2;
  }
  if (cmd === "build") {
    const out = build(readJson(file));
    if (out.record) {
      const dir = opt(rest, "--out") ?? ".";
      fs.mkdirSync(dir, { recursive: true });
      const id = out.record.plan_id;
      fs.writeFileSync(path.join(dir, `${id}.record.json`), JSON.stringify(out.record, null, 2));
      fs.writeFileSync(path.join(dir, `${id}.vector.json`), JSON.stringify(out.vector));
      const g = out.record.adjacency_graph;
      console.log(`${id}: ${out.record.total_area_m2} m², ${out.record.bedrooms} bed, ${out.record.bathrooms} bath, ${g.nodes.length} nodes, ${g.edges.length} edges, ${out.vector.windows.length} windows, ${out.vector.doors.length} doors`);
      console.log(g.edges.map((e) => `  ${e.from} -${e.connection}- ${e.to}`).join("\n"));
      console.log(`wrote ${path.join(dir, id + ".record.json")} and ${path.join(dir, id + ".vector.json")}`);
    }
    report(out.errors, out.warnings);
    return out.errors.length ? 1 : 0;
  }
  if (cmd === "validate") {
    const rec = readJson(file);
    const a = validateRecord(rec);
    const b = rest[0] && !rest[0].startsWith("--") ? validateVector(readJson(rest[0]), rec) : { errors: [], warnings: [] };
    report([...a.errors, ...b.errors], [...a.warnings, ...b.warnings]);
    return a.errors.length + b.errors.length ? 1 : 0;
  }
  if (cmd === "render") {
    const vector = readJson(file);
    const recordPath = opt(rest, "--record");
    const record = recordPath ? readJson(recordPath) : undefined;
    const level = opt(rest, "--level") !== undefined ? Number(opt(rest, "--level")) : undefined;
    if (level !== undefined && !(vector.rooms || []).some((r) => r.level === level)) { console.error(`error: no rooms on level ${level}. Levels present: ${[...new Set((vector.rooms || []).map((r) => r.level))].join(", ")}`); return 1; }
    if (rest.includes("--ascii")) { console.log(renderAscii(vector, level)); return 0; }
    const out = opt(rest, "--out") ?? file.replace(/\.json$/, "") + ".svg";
    fs.writeFileSync(out, renderSvg(vector, record, level));
    console.log(`wrote ${out}. Open it in a browser or convert it to PNG to look at it (or use --ascii for a text picture).`);
    return 0;
  }
  console.error(`unknown command "${cmd}"`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
