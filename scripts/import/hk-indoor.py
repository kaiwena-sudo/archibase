"""
Convert the Hong Kong Lands Department 3D Indoor Map (IMDF, via the CSDI Portal) into Archibase
floor plans: one plan per building floor, with a room graph and metric geometry.

    python3 -m venv .venv-geo && .venv-geo/bin/pip install shapely
    .venv-geo/bin/python -I scripts/import/hk-indoor.py <out-dir> [--limit N] [--types a,b] [--sample N] [--workers 6]

Downloads the building index from the CSDI FeatureServer, then each building's GeoJSON zip from
download.map.gov.hk. Zips are read in memory (never extracted) and discarded. Writes
<out-dir>/plans-0001.json ... and <out-dir>/vectors/<plan_id>.json for `npm run supabase:load`.

Terms (https://portal.csdi.gov.hk/csdi-webpage/doc/TNC): commercial and non-commercial use free of
charge, provided the Government and the CSDI Portal are identified as the source and their IP
ownership acknowledged; the data is provided as is. Every record carries that attribution.

Mapping notes:
- Coordinates are WGS84 lon/lat; they are projected to local metres around each building's centre
  (equirectangular: error well under 0.1% at building scale). +x east, +y north: orientation is true.
- IMDF "room" is a tenancy unit (an office suite, a shop, a market stall, a whole flat), so it
  becomes type "unit", not "room" (which Archibase reserves for unlabelled rooms inside a home).
  "unspecified" becomes "space". Voids ("opentobelow") carry no floor area.
- Doors: each IMDF opening links the units whose outlines it touches. A principal opening that
  touches one unit is the entrance. Circulation spaces (corridors, lobbies) that touch are linked
  as "opening". Windows are matched to units by the dataset's own unit ids.
- Vertical links between floors are not modelled; each floor is its own plan.
- Floors identical to a lower floor of the same building (same spaces and outlines to 0.1 m) are stored
  once; the kept floor lists the others in adjacency_graph.identical_levels.
- Skipped: floors with fewer than 3 spaces or under 20 m², and floors whose spaces overlap by more than
  10% (their areas would double count).
"""
import hashlib
import io
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

from shapely.geometry import LineString, MultiPolygon, Polygon, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

INDEX_URL = (
    "https://portal.csdi.gov.hk/server/rest/services/common/landsd_rcd_1671437329821_60808/FeatureServer/0/query"
    "?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=5000"
)
SOURCE_URL = "https://portal.csdi.gov.hk/csdi-webpage/dataset/landsd_rcd_1671437329821_60808"
ATTRIBUTION = (
    "3D Indoor Map by the Lands Department, the Government of the Hong Kong Special Administrative Region, "
    "via the CSDI Portal (portal.csdi.gov.hk). The Government and the relevant organisations own the "
    "intellectual property rights in the data. Modified: converted by Archibase into floor plans and room graphs."
)
DERIVATION = (
    "Derived from the Lands Department 3D Indoor Map (IMDF). One plan per building floor. IMDF units become "
    "nodes (IMDF 'room' = a tenancy unit such as an office, shop, stall or flat, typed 'unit'; 'unspecified' = "
    "'space'); openings link the units they touch (door), principal openings touching one unit are entrances, "
    "touching circulation spaces are linked as 'opening'; windows are matched by the dataset's unit ids. "
    "Coordinates projected from WGS84 to local metres; +y is north. Vertical links between floors are not modelled. "
    "Floors identical to a lower floor of the same building are stored once and listed in identical_levels."
)
CRS = "local metres around the building centre; +x east, +y north (true orientation); projected from WGS84"
CHUNK = 5000
MIN_UNITS, MIN_AREA_M2 = 3, 20.0
MAX_OVERLAP = 1.10  # sum of space areas / area of their union; above this, areas would double count
DOOR_REACH_M = 0.35

TYPE_MAP = {
    "room": "unit", "unspecified": "space", "walkway": "corridor", "lobby": "lobby", "stairs": "stairs",
    "elevator": "elevator", "escalator": "escalator", "steps": "steps", "ramp": "ramp", "office": "office",
    "foodservice": "food_service", "nonpublic": "non_public", "parking": "parking", "opentobelow": "void",
    "vegetation": "planting", "storage": "storage", "kitchen": "kitchen", "classroom": "classroom",
    "conferenceroom": "meeting_room", "auditorium": "auditorium", "retail": "retail",
}
CIRCULATION = {"corridor", "lobby", "space", "steps", "ramp"}
EXTERIOR = {"planting"}
NO_AREA = {"void"}
STAIR_TYPES = {"stairs", "escalator"}


def building_type(venue_type: str, name: str) -> str:
    if venue_type == "businesscampus":
        return "industrial" if re.search(r"industrial|factory|godown|warehouse|workshop|cold storage|logistics", name, re.I) else "office"
    return {
        "trainstation": "transport", "shoppingcenter": "retail", "governmentfacility": "government",
        "stadium": "sports", "hotel": "hospitality", "healthcarefacility": "healthcare", "museum": "cultural",
        "conventioncenter": "other",
        # LandsD's "resort" venues are residential and mixed-use towers; their units are whole flats and shops.
        "resort": "mixed",
    }.get(venue_type, "other")


def node_type(category: str) -> tuple[str, dict]:
    if category.startswith("restroom"):
        kind = category.split(".", 1)[1] if "." in category else None
        return "restroom", ({"restroom_kind": kind} if kind else {})
    return TYPE_MAP.get(category, re.sub(r"[^a-z0-9]+", "_", category.lower()).strip("_") or "space"), {}


def fetch(url: str, timeout=180) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "archibase-importer/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def read_zip(blob: bytes) -> dict:
    """Return {basename: features} for the GeoJSON layers we use, reading in memory only."""
    out = {}
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for info in z.infolist():
            base = os.path.basename(info.filename)
            if base in ("level.geojson", "unit.geojson", "opening.geojson", "3D Windows.geojson") and info.file_size < 200_000_000:
                out[base] = json.loads(z.read(info))["features"]
    return out


class Projector:
    def __init__(self, lon0: float, lat0: float):
        self.lon0, self.lat0 = lon0, lat0
        self.kx = 111_320.0 * math.cos(math.radians(lat0))
        self.ky = 110_540.0

    def pt(self, c):
        return (round((c[0] - self.lon0) * self.kx, 3), round((c[1] - self.lat0) * self.ky, 3))


def to_shape(geom, proj: Projector):
    """GeoJSON Polygon/MultiPolygon/LineString (possibly 3D, lon/lat) to a 2D shapely geometry in metres."""
    t = geom["type"]
    if t == "Polygon":
        rings = [[proj.pt(c) for c in r] for r in geom["coordinates"]]
        return Polygon(rings[0], rings[1:]) if len(rings[0]) >= 4 else None
    if t == "MultiPolygon":
        polys = [Polygon([proj.pt(c) for c in p[0]], [[proj.pt(c) for c in r] for r in p[1:]]) for p in geom["coordinates"] if len(p[0]) >= 4]
        return MultiPolygon(polys) if polys else None
    if t == "LineString":
        pts = [proj.pt(c) for c in geom["coordinates"]]
        return LineString(pts) if len(pts) >= 2 else None
    if t == "MultiLineString":
        pts = [proj.pt(c) for line in geom["coordinates"] for c in line]
        return LineString(pts) if len(pts) >= 2 else None
    return None


SIMPLIFY_M = 0.005  # drop vertices that move an outline by under 5 mm (curves are densely sampled)


def ring(coords) -> list:
    return [[round(x, 3), round(y, 3)] for x, y in coords]


def polys_of(g) -> list:
    """Archibase polygon list: [[outer, ...holes], ...] with closed rings, mm precision.

    Outlines are simplified by 5 mm and rounded to the millimetre: files shrink to about 42% while the
    typical room area changes by under 0.01% (worst case seen 0.7%). Node areas are computed before this.
    """
    geoms = list(g.geoms) if isinstance(g, MultiPolygon) else [g]
    out = []
    for p in geoms:
        if p.is_empty:
            continue
        q = p.simplify(SIMPLIFY_M, preserve_topology=True)
        if q.is_empty:
            q = p
        out.append([ring(q.exterior.coords)] + [ring(r.coords) for r in q.interiors])
    return out


def reslim(vectors_dir: str) -> None:
    """Apply polys_of's precision rules to vector files written by an older run, in place."""
    n = before = after = 0
    for name in os.listdir(vectors_dir):
        path = os.path.join(vectors_dir, name)
        before += os.path.getsize(path)
        v = json.load(open(path))
        for key in ("rooms", "doors", "windows", "stairs"):
            for item in v.get(key, []):
                slim = []
                for poly in item["polygon"]:
                    shell = Polygon(poly[0], poly[1:])
                    slim += polys_of(shell) if not shell.is_empty else [poly]
                item["polygon"] = slim
        with open(path, "w") as f:
            json.dump(v, f, separators=(",", ":"))
        after += os.path.getsize(path)
        n += 1
    print(json.dumps({"files": n, "mb_before": round(before / 1e6, 1), "mb_after": round(after / 1e6, 1)}))


def strip(line: LineString, width=0.15):
    """A door or window line as a thin polygon, the shape our vector format uses."""
    return line.buffer(width / 2, cap_style=2)


def norm_ordinal(v) -> float | int:
    """Some buildings store ordinals as floats (23.0); keep integers as int, real fractions (mezzanines) as float."""
    try:
        f = float(v if v is not None else 0)
    except (TypeError, ValueError):
        return 0
    return int(f) if f.is_integer() else round(f, 2)


def ordinal_tag(o) -> str:
    """Plan-id safe: 3 -> l3, -1 -> lm1, 2.5 -> l2p5."""
    s = (f"m{-o}" if o < 0 else f"{o}").replace(".", "p")
    return f"l{s}"


def convert_venue(attrs: dict, layers: dict, stats: Counter | None = None) -> list:
    stats = stats if stats is not None else Counter()
    venue_id = attrs["Venue_ID"]
    name = (attrs.get("Venue_Eng_name") or "").strip()
    btype = building_type(attrs.get("Type", ""), name)
    levels = {l["id"]: l["properties"] for l in layers.get("level.geojson", [])}
    units = [u for u in layers.get("unit.geojson", []) if u.get("geometry") and u["properties"].get("level_id") in levels]
    if not units:
        return []
    coords = []
    for u in units:
        g = u["geometry"]
        rings = g["coordinates"] if g["type"] == "Polygon" else [r for p in g["coordinates"] for r in p]
        coords += rings[0]
    proj = Projector(sum(c[0] for c in coords) / len(coords), sum(c[1] for c in coords) / len(coords))

    by_ordinal = defaultdict(list)
    for u in units:
        by_ordinal[norm_ordinal(levels[u["properties"]["level_id"]].get("ordinal"))].append(u)
    level_ord = {lid: norm_ordinal(p.get("ordinal")) for lid, p in levels.items()}
    level_name = {}
    for p in levels.values():
        sn = (p.get("short_name") or {}).get("en") or (p.get("name") or {}).get("en")
        if sn:
            level_name.setdefault(norm_ordinal(p.get("ordinal")), sn)

    openings = defaultdict(list)
    for o in layers.get("opening.geojson", []):
        lid = o["properties"].get("level_id")
        if lid in level_ord and o.get("geometry"):
            g = to_shape(o["geometry"], proj)
            if g is not None and g.length > 0:
                openings[level_ord[lid]].append((g, o["properties"].get("category") or ""))
    windows_by_unit = defaultdict(list)
    for w in layers.get("3D Windows.geojson", []):
        if w.get("geometry"):
            g = to_shape(w["geometry"], proj)
            if g is not None and g.length > 0:
                windows_by_unit[w["properties"].get("UnitPolyID")].append(g)

    results = []
    for ordinal, floor_units in sorted(by_ordinal.items()):
        shapes, nodes, counters = [], [], Counter()
        for u in floor_units:
            g = to_shape(u["geometry"], proj)
            if g is None or g.is_empty:
                continue
            if not g.is_valid:
                g = g.buffer(0)
            if g.is_empty or g.area < 0.05:
                continue
            ntype, extra = node_type(u["properties"].get("category") or "unspecified")
            counters[ntype] += 1
            nid = f"{ntype}_{counters[ntype]}"
            node = {"id": nid, "type": ntype, **extra}
            if ntype in NO_AREA:
                node["void"] = True
            else:
                node["area"] = round(g.area, 2)
            if ntype in EXTERIOR:
                node["exterior"] = True
            unit_windows = windows_by_unit.get(u["properties"].get("UnitPolyID"), [])
            node["windows"] = len(unit_windows)
            nodes.append(node)
            shapes.append((nid, ntype, g, unit_windows))
        interior_area = sum(n.get("area", 0) for n in nodes if not n.get("exterior"))
        if len(shapes) < MIN_UNITS or interior_area < MIN_AREA_M2:
            stats["skipped_small"] += 1
            continue
        floor_shapes = [g for _, t, g, _ in shapes if t not in NO_AREA and t not in EXTERIOR]
        union = unary_union(floor_shapes).area if floor_shapes else 0
        if union and sum(g.area for g in floor_shapes) / union > MAX_OVERLAP:
            stats["skipped_overlap"] += 1
            continue

        tree = STRtree([s[2] for s in shapes])
        edges, seen, has_outside = [], set(), False

        def add(a, b, conn):
            key = tuple(sorted((a, b)))
            if a != b and key not in seen:
                seen.add(key)
                edges.append({"from": a, "to": b, "connection": conn})

        door_polys = []
        for line, category in openings.get(ordinal, []):
            near = [shapes[i] for i in tree.query(line.buffer(DOOR_REACH_M))]
            near = sorted(((s[2].distance(line), s[0]) for s in near if s[2].distance(line) <= DOOR_REACH_M))
            ids = [nid for _, nid in near]
            if len(ids) >= 2:
                add(ids[0], ids[1], "door")
            elif len(ids) == 1 and category.startswith("pedestrian.principal"):
                add("outside", ids[0], "entrance_door")
                has_outside = True
            door_polys.append(("entrance_door" if category.startswith("pedestrian.principal") else "door", strip(line)))
        circ = [s for s in shapes if s[1] in CIRCULATION]
        for i, a in enumerate(circ):
            for b in circ[i + 1:]:
                if a[2].distance(b[2]) < 0.05:
                    shared = a[2].buffer(0.05).intersection(b[2].buffer(0.05))
                    if shared.area / 0.1 >= 0.6:  # shared boundary of at least ~0.6 m
                        add(a[0], b[0], "opening")
        if has_outside:
            nodes.append({"id": "outside", "type": "outside", "exterior": True})

        plan_id = f"hk-{venue_id.replace('-', '')[:12].lower()}-{ordinal_tag(ordinal)}"
        plan = {
            "plan_id": plan_id,
            "style": "unspecified",
            "building_type": btype,
            "total_area_m2": round(interior_area, 2),
            "bedrooms": 0,
            "bedrooms_inferred": 0,
            "bathrooms": 0,
            "adjacency_graph": {
                "units": "m2",
                "nodes": nodes,
                "edges": edges,
                "level": ordinal,
                "level_name": level_name.get(ordinal),
                "derivation": DERIVATION,
                "source_ids": {"venue_id": venue_id, "venue_name": name, "venue_type": attrs.get("Type")},
            },
            "provenance": {
                "source": "dataset",
                "built": True,
                "license": "HK-CSDI-TOU",
                "author": "Lands Department, Government of the Hong Kong SAR",
                "source_url": SOURCE_URL,
                "attribution": ATTRIBUTION,
            },
        }
        vector = {
            "plan_id": plan_id,
            "schema_version": 1,
            "units": "m",
            "crs": CRS,
            "attribution": ATTRIBUTION,
            "rooms": [{"id": nid, "type": t, "level": ordinal, "polygon": polys_of(g)} for nid, t, g, _ in shapes],
            "doors": [{"type": t, "level": ordinal, "polygon": polys_of(p)} for t, p in door_polys],
            "windows": [{"level": ordinal, "polygon": polys_of(strip(w))} for _, _, _, ws in shapes for w in ws],
            "stairs": [{"id": nid, "level": ordinal, "room": nid, "polygon": polys_of(g)} for nid, t, g, _ in shapes if t in STAIR_TYPES],
        }
        results.append((plan, vector))
    return merge_repeated_floors(results, stats)


def floor_signature(vector: dict) -> str:
    """Identity of a floor's layout: its spaces' types and outlines to 0.1 m (same building, same frame)."""
    parts = sorted(
        r["type"] + ":" + ";".join(f"{x:.1f},{y:.1f}" for poly in r["polygon"] for ring in poly for x, y in ring)
        for r in vector["rooms"]
    )
    return hashlib.sha1("|".join(parts).encode()).hexdigest()


def merge_repeated_floors(results: list, stats: Counter) -> list:
    """Towers repeat the same floor many times. Keep the lowest one and list the others on it."""
    kept, by_sig = [], {}
    for plan, vector in results:
        sig = floor_signature(vector)
        if sig in by_sig:
            first = by_sig[sig]
            g = first["adjacency_graph"]
            g.setdefault("identical_levels", []).append(plan["adjacency_graph"].get("level_name") or plan["adjacency_graph"]["level"])
            stats["merged_identical_floors"] += 1
            continue
        by_sig[sig] = plan
        kept.append((plan, vector))
    return kept


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit("usage: hk-indoor.py <out-dir> [--limit N] [--types a,b] [--sample N] [--venues 'A|B'] [--workers N]\n"
                 "       hk-indoor.py --reslim <vectors-dir>   (apply current precision rules to older output)")
    if args[0] == "--reslim":
        return reslim(args[1])
    out = args[0]
    opt = lambda k: args[args.index(k) + 1] if k in args else None
    limit = int(opt("--limit")) if opt("--limit") else None
    workers = int(opt("--workers") or 6)
    sample = int(opt("--sample")) if opt("--sample") else None
    types = set(opt("--types").split(",")) if opt("--types") else None
    venue_names = set(opt("--venues").split("|")) if opt("--venues") else None

    venues = [f["attributes"] for f in json.loads(fetch(INDEX_URL))["features"]]
    if types:
        venues = [v for v in venues if v.get("Type") in types]
    if venue_names:  # e.g. retry buildings whose download failed: --venues "Name A|Name B"
        venues = [v for v in venues if (v.get("Venue_Eng_name") or "").strip() in venue_names]
    if sample:  # spread across types: round-robin
        by_type = defaultdict(list)
        for v in venues:
            by_type[v.get("Type")].append(v)
        picked, i = [], 0
        while len(picked) < sample and any(by_type.values()):
            t = sorted(by_type)[i % len(by_type)]
            if by_type[t]:
                picked.append(by_type[t].pop(0))
            i += 1
            by_type = {k: v for k, v in by_type.items() if v} or by_type
        venues = picked
    if limit:
        venues = venues[:limit]

    os.makedirs(os.path.join(out, "vectors"), exist_ok=True)
    plans, chunk, stats = [], 0, Counter()

    def flush():
        nonlocal plans, chunk
        if plans:
            chunk += 1
            with open(os.path.join(out, f"plans-{chunk:04d}.json"), "w") as f:
                json.dump(plans, f, separators=(",", ":"))
            plans = []

    def work(v):
        """Download and convert one building (runs in a worker thread)."""
        url = v.get("GeoJSON") or ""
        if not url.startswith("https://download.map.gov.hk/"):
            return v, None, "bad_url"
        local = Counter()
        try:
            return v, (convert_venue(v, read_zip(fetch(url)), local), local), None
        except Exception as e:  # one bad building shouldn't stop the run
            return v, None, f"{type(e).__name__}: {e}"

    with ThreadPoolExecutor(max_workers=workers) as pool:
        done_iter = pool.map(work, venues)
        for i, (v, ok, err) in enumerate(done_iter, 1):
            if err:
                stats["failed" if err != "bad_url" else "bad_url"] += 1
                print(f"  ! {v.get('Venue_Eng_name')}: {err}", file=sys.stderr)
                continue
            results, local = ok
            stats.update(local)
            stats["venues"] += 1
            for plan, vector in results:
                plans.append(plan)
                stats["floors"] += 1
                stats[plan["building_type"]] += 1
                with open(os.path.join(out, "vectors", f"{plan['plan_id']}.json"), "w") as f:
                    json.dump(vector, f, separators=(",", ":"))
                if len(plans) >= CHUNK:
                    flush()
            print(f"[{i}/{len(venues)}] {v.get('Venue_Eng_name')}: {len(results)} floors", file=sys.stderr, flush=True)
    flush()
    print(json.dumps(dict(stats)))


if __name__ == "__main__":
    main()
