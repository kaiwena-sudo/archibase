# Data and provenance

Where the plans come from, how each source is converted, and which licences apply.

### Repeated layouts and flagged records

Datasets repeat the same apartment on every floor of a building: in Swiss Dwellings, 20,008 of 44,946 apartments are copies of a layout already in the set (one estate has 107 identical flats). Search therefore returns **one plan per layout** by default, and every result carries `layout_copies`, the number of plans sharing that exact layout (1 = unique). Pass `include_duplicates=true` to get every copy.

A layout is identified by a fingerprint of its room graph: room types, sizes to 0.1 m², windows, fixtures and connections, ignoring node ids (`src/db/layout.ts`). Mirrored copies share a fingerprint. The lowest `plan_id` in each group is the one shown.

Records that are probably wrong are flagged and never served. Today the only flag is `multi_unit_suspect`: three or more kitchens in one "apartment", meaning the source merged several units (3 Swiss records).

## Data sources and provenance

Every record carries a `provenance` object, and buyers can filter on it (`built=true`, `source=habs`):

```json
"provenance": { "source": "habs", "built": true, "license": "public-domain",
                "author": "Historic American Buildings Survey", "source_url": "https://www.loc.gov/..." }
```

| `source` | What it is | Rules enforced by the validator |
|---|---|---|
| `synthetic` | Generated test inputs and made-up examples; not production catalogue records | `built: false` |
| `habs` | Library of Congress HABS/HAER/HALS measured drawings | `built: true`, `public-domain`, loc.gov `source_url` |
| `commissioned` | Paid work from students or firms | licence `owned`, `author`, and an internal `rights_ref` (signed agreement) |
| `dataset` | Third-party open dataset | `source_url`; CC-BY needs an `attribution` line |
| `ai_generated` | Output of Archibase's own models | `built: false` |

Only licences that allow resale are accepted: `public-domain`, `CC0-1.0`, `CC-BY-4.0`, and `owned` (Archibase holds the rights through its own work or a written assignment). Non-commercial and share-alike licences are rejected.

`rights_ref` is internal. It is never served: the JSON store strips it and Supabase column grants hide it.

### Loading data

```bash
npm run seed -- incoming/batch.json --dry-run   # validate only
npm run seed -- incoming/batch.json             # merge into DATABASE_URL (file or Supabase)
```

The validator also checks the graph: every edge must reference a real room, there must be no self-loops or duplicate ids, and the bedroom count must match the graph's bedroom rooms. Records must be metric (`total_area_m2`, `adjacency_graph.units: "m2"`). Room areas that don't add up to `total_area_m2` produce a warning. One invalid record aborts the batch unless you pass `--skip-invalid`. Keep imported plans in the ignored `incoming/` directory and include provenance and license details with each record.

### Swiss Dwellings (Archilyse, CC BY 4.0)

The complete imported catalogue is a deployment input and is not included in this repository. The public sample endpoint uses a fixed set of attributed plans in `src/site/sample-data.ts`. The importer supports a deterministic sample of the [Swiss Dwellings v3.0.0](https://zenodo.org/records/7788422) dataset (CC BY 4.0); each imported record carries its attribution and modification note.

```bash
