# archibase-mcp

**The only structured, license-clean, machine-native floorplan corpus. Built for spatial AI, generative design, and architecture agents.** 📐🏗️

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude, Cursor, and other MCP clients) search **Archibase**: real floor plans with room adjacency graphs and metric geometry. Calls are paid per use in USDC on Base through [x402](https://x402.org). There is no account, only a small wallet.

| Tool | Price | What it returns |
|---|---|---|
| `search_floor_plans` | $0.02 | Up to 100 plans matching bedrooms, area (m²), built, source. Each has rooms (type, m², windows), connections (door, opening, entrance, window), bathrooms, provenance and licence |
| `get_floor_plan_geometry` | $0.10 | One plan's room polygons in metres, doors, windows and stair zones |
| `archibase_account` | free | Current prices, the wallet in use, and how much of the session budget is left |

The catalogue holds Swiss apartments (Swiss Dwellings, CC BY 4.0), South Asian homes and apartments (ResPlan, CC BY 4.0) and historic US houses (HABS, public domain). Repeated layouts are collapsed, and every result carries its source and the attribution to keep when you use it.

## Setup

1. **Make a dedicated spending wallet.** Don't use your main wallet. Create a fresh one (for example in Coinbase Wallet or MetaMask), export its private key, and send it a few dollars of **USDC on Base**. Gas is not needed: x402 payments are signed authorisations that the facilitator submits.
2. **Add the server to your client.** For Claude Desktop, add this to `claude_desktop_config.json`; other clients take the same command and environment:

```json
{
  "mcpServers": {
    "archibase": {
      "command": "npx",
      "args": ["-y", "archibase-mcp"],
      "env": {
        "ARCHIBASE_PRIVATE_KEY": "0x…your spending wallet's key…",
        "ARCHIBASE_BUDGET_USD": "2",
        "ARCHIBASE_EXPECTED_PAY_TO": "0x…trusted receiver for the selected network…"
      }
    }
  }
}
```

For Claude Code: `claude mcp add archibase -e ARCHIBASE_PRIVATE_KEY=0x… -e ARCHIBASE_EXPECTED_PAY_TO=0x… -- npx -y archibase-mcp`

Without a wallet or key the server still runs: paid tools report what they would cost, and nothing is bought.

**No wallet?** Trials and partners can request an API key from the project maintainers. Set `ARCHIBASE_API_KEY=ak_…` in place of `ARCHIBASE_PRIVATE_KEY` (not both). The credit balance is the spending cap: calls fail with a top-up link when it runs out, and errors cost nothing.

## Spending limits

The assistant can't spend more than you allow:

| Variable | Default | Meaning |
|---|---|---|
| `ARCHIBASE_API_KEY` | none | Prepaid-credits key instead of a wallet (see above) |
| `ARCHIBASE_EXPECTED_PAY_TO` | none | Trusted receiver address for wallet payments. Required when using a wallet; the client fails closed if it is missing or does not match the API challenge. Verify it through a trusted project channel. |
| `ARCHIBASE_BUDGET_USD` | `2` | Total spend per session with a wallet (each time the client starts the server) |
| `ARCHIBASE_MAX_PRICE_USD` | `0.25` | Refuse any single call priced above this |
| `ARCHIBASE_NETWORK` | `eip155:8453` | Base. Use `eip155:84532` with testnet USDC to try it free |
| `ARCHIBASE_API_URL` | Archibase mainnet | Point at another deployment |
| `ARCHIBASE_DEBUG` | off | `1` logs each request and status to stderr (never keys or signatures) |

The server checks the price before paying. Bad queries and unknown plans are answered free (400/404), and only USDC on the configured network can be paid.

## Development

```bash
npm install && npm run build && npm test
# end-to-end on Base Sepolia with a funded test wallet file ({"privateKey": "0x…"}):
NODE_USE_ENV_PROXY=1 ARCHIBASE_NETWORK=eip155:84532 node scripts/e2e.mjs path/to/test-wallet.json
```

## Publishing (maintainers)

1. `npm publish` (the package name is `archibase-mcp`; `package.json` carries `mcpName`).
2. List it in the official MCP Registry with [`mcp-publisher`](https://github.com/modelcontextprotocol/registry): authenticate with the GitHub account that owns the `mcpName` namespace in `package.json`, then run `mcp-publisher publish` from this folder. The command reads `server.json`; directories such as Glama, PulseMCP and mcp.so pick up registry entries.
