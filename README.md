# archibase

**The only structured, license-clean, machine-native floorplan corpus. Built for spatial AI, generative design, and architecture agents.** 📐🏗️

Agents get real floor plans as room graphs and metric geometry, and pay per call in USDC with [x402](https://x402.org). Payment works on Base, Polygon and Arbitrum One.

| | Price per call |
|---|---|
| Floor-plan search | **$0.02 USDC** |
| One plan's geometry | **$0.10 USDC** |

## Endpoints

| Method | Path | Paid | What it returns |
|---|---|---|---|
| GET | `/api/v1/plans/search` | $0.02 | Matching plans as room graphs with areas, windows and provenance |
| GET | `/api/v1/plans/{plan_id}/vector` | $0.10 | One plan's room polygons, doors and windows, in metres |
| GET | `/api/v1/sample` | free | A fixed set of real plans in the paid format |
| GET | `/api/v1/count` | free | How many plans a search would match |
| GET | `/.well-known/x402.json` | free | Discovery: prices, schemas, networks and payee |

Full details are in [docs/api.md](docs/api.md).

## Try it

```bash
# Discovery: prices, schemas and accepted networks
curl -s https://api.archibase.dev/.well-known/x402.json

# Without payment you get HTTP 402 and the terms to pay
curl -si "https://api.archibase.dev/api/v1/plans/search?bedrooms=3&style=modern"
```

Browse the free sample at [archibase.dev/explore](https://archibase.dev/explore).

## For AI agents

- **MCP server:** `npx -y archibase-mcp` gives Claude, Cursor and other assistants search and geometry tools. See [mcp/README.md](mcp/README.md).
- **Agent skill:** [`skills/archibase-plan-converter`](skills/archibase-plan-converter/) turns a drawing or description into the Archibase format, and checks the result against the same rules as the server.

## Data

Every record carries its licence and source. Only licences that allow resale are accepted: public domain, CC0, CC BY, and the owner's own rights. Hong Kong records carry the government's attribution terms. Sources and rules are in [docs/data.md](docs/data.md).

## Running it yourself

Setup, wallets, Supabase and Cloudflare deployment are in [docs/self-hosting.md](docs/self-hosting.md).

## Development

```bash
npm install
npm test              # unit and HTTP payment tests
npm run typecheck     # app and Worker type-checks
npm run typecheck:tests
```

CI (`.github/workflows/ci.yml`) runs the type-checks, tests and build on every push and pull request.

## Contact

Questions and dataset licence enquiries: kaizim@archibase.dev. Security reports: see [SECURITY.md](SECURITY.md).

## Licence

Code: MIT, see [LICENSE](LICENSE). Floor-plan data is not covered by that licence; each record carries its own.
