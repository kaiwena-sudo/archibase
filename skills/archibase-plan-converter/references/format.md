# Archibase format reference

Two files describe one plan. Both are produced by `scripts/archibase.mjs build`; read this when you need to write or edit them by hand.

## The trace (your input)

```jsonc
{
  "plan_id": "my-plan-0001",            // 3-80 chars: lowercase letters, digits, hyphens
  "style": "unspecified",               // lowercase letters/spaces/hyphens, e.g. "craftsman"
  "building_type": "residential",       // residential, office, retail, transport, government, sports,
                                        // hospitality, healthcare, cultural, education, industrial, mixed, other
  "provenance": {                        // required; see Licences below
    "source": "habs",                    // habs | commissioned | dataset | synthetic | ai_generated
    "built": true,                       // true only for buildings that were actually constructed
    "license": "public-domain",          // public-domain | CC0-1.0 | CC-BY-4.0 | owned
    "author": "Historic American Buildings Survey",
    "source_url": "https://www.loc.gov/...",
    "attribution": "..."                 // required for CC-BY-4.0
  },
  "rights_ref": "agreement-2026-014",   // commissioned work only: your reference for the signed agreement
  "transcription": { "method": "...", "scale_basis": "printed scale bar, 1/4 in = 1 ft", "confidence": "high|medium|low", "notes": "..." },
  "rooms":   [ { "id": "bedroom_1", "type": "bedroom", "level": 1, "polygon": [[x,y], ...], "holes": [[[x,y], ...]],
                 "fixtures": ["toilet"], "inferred_use": "bedroom", "stairwell": false } ],
  "doors":   [ { "type": "door", "level": 1, "from": [x,y], "to": [x,y] } ],     // type "entrance_door" for the way in
  "windows": [ { "level": 1, "from": [x,y], "to": [x,y] } ],
  "stairs":  [ { "room": "stairs_1", "arrival_room": "stairwell_2", "to_level": 2,
                 "risers": 14, "start": [x,y], "end": [x,y], "run": 3.2, "rise": 2.8 } ]
}
```

Coordinates are metres. `level` defaults to 1 and must be an integer (negative for basements).

## What the script derives

| Field | Rule |
|---|---|
| node `area` | polygon area in m² (outline minus holes), 2 decimals |
| `total_area_m2` | sum of room areas, **excluding** exterior rooms (balcony, terrace, loggia, porch, veranda, garden, parking, planting, yard) and stairwell openings |
| `bedrooms` | rooms of type `bedroom`/`primary_bedroom`, plus rooms of type `room` whose `inferred_use` is `bedroom` (`bedrooms_inferred` counts those) |
| `bathrooms` | 1 per `bathroom` + 0.5 per `toilet`/`wc`/`powder_room` |
| edge `door` | the two rooms nearest a door line's centre, each within 0.35 m |
| edge `entrance_door` | an `entrance_door` line near one room: that room to a node `outside` |
| edge `opening` | two same-level rooms whose outlines touch along 0.6 m or more (no wall between) |
| edge `stair` | a `stairs` entry with `arrival_room` links the two rooms |
| node `windows` | each window line is sampled at 5 points; every room within 0.35 m of a point (interior rooms before balconies) gets +1, so a long window spanning two rooms counts for both |

## The record (search result shape)

```jsonc
{ "plan_id": "...", "style": "...", "building_type": "...", "total_area_m2": 55.56, "bedrooms": 2, "bedrooms_inferred": 0, "bathrooms": 1,
  "adjacency_graph": { "units": "m2",
    "nodes": [ { "id": "living_1", "type": "living", "area": 18.72, "windows": 2 }, { "id": "balcony_1", "type": "balcony", "area": 4.2, "windows": 0, "exterior": true } ],
    "edges": [ { "from": "living_1", "to": "hallway_1", "connection": "door" } ],
    "derivation": "...", "transcription": { } },
  "provenance": { }, "rights_ref": "..." }
```

Records are **metric only** (`total_sqft` is rejected). Connection names: `door`, `opening`, `entrance_door`, `stair`, `window` (a room seen through a window, such as a bathroom onto a balcony), `adjacent` (touching, no door recorded).

## The geometry (vector) file

```jsonc
{ "plan_id": "...", "schema_version": 1, "units": "m", "crs": "plan-local metres; +x right, +y up", "attribution": "...",
  "rooms":   [ { "id": "living_1", "type": "living", "level": 1, "polygon": [ [ [x,y], ..., [x0,y0] ] ] } ],   // [outer ring, ...hole rings], closed
  "doors":   [ { "type": "door", "level": 1, "polygon": [ [ [x,y], ... ] ] } ],
  "windows": [ { "level": 1, "polygon": [ [ [x,y], ... ] ] } ],
  "stairs":  [ { "id": "stairs_1", "level": 1, "to_level": 2, "room": "stairs_1", "polygon": [...], "risers": 14, "start": [x,y], "end": [x,y], "run": 3.2, "rise": 2.8 } ] }
```

Each `polygon` is a list of polygons; each polygon is `[outer ring, ...hole rings]`; each ring is a closed list of `[x, y]` (first point repeated at the end). Room ids match graph node ids. The script makes doors and windows thin rectangles (0.12 m) around your lines.

## Stairs and levels

Draw the staircase as a room of type `stairs` on the level it starts, and where it arrives draw the opening as a room with `"stairwell": true` (it has no floor area). Link them with a `stairs` entry (`room` = the lower footprint, `arrival_room` = the upper opening). `start`/`end` are the bottom and top of the flight's centreline, `run` its horizontal length and `rise` the height climbed, all in metres; give what the drawing states (a count of risers is usually printed) and omit the rest. Do not draw individual treads.

## Licences and sources (enforced by the validator)

| `provenance.license` | Means | Needs |
|---|---|---|
| `public-domain` | no copyright (US government works, old published works) | nothing |
| `CC0-1.0` | dedicated to the public domain | nothing |
| `CC-BY-4.0` | reuse with credit | `attribution` text |
| `owned` | the requester holds the rights or has a written assignment | for `commissioned`: `rights_ref` and `author` |

Anything else (CC BY-NC, share-alike, "all rights reserved", unknown) is rejected.

| `provenance.source` | Rules |
|---|---|
| `habs` | US Library of Congress HABS/HAER/HALS drawings: `built: true`, `public-domain`, `source_url` = the loc.gov item |
| `commissioned` | paid work: `license: "owned"`, `rights_ref`, `author` |
| `dataset` | an open dataset: `source_url` pointing at it and its licence |
| `synthetic` / `ai_generated` | invented plans: `built: false` |
