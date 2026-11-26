// Manual end-to-end check on Base Sepolia: node scripts/e2e.mjs <wallet.json> [budget]. Spawns the server over stdio and calls each tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
const key = JSON.parse(readFileSync(process.argv[2], "utf8")).privateKey;
const env = { ...process.env, ARCHIBASE_PRIVATE_KEY: key, ARCHIBASE_NETWORK: "eip155:84532",
  ARCHIBASE_API_URL: process.env.E2E_API ?? "https://archibase.archibase-api.workers.dev", ARCHIBASE_BUDGET_USD: process.argv[3] ?? "0.15", ARCHIBASE_DEBUG: "1" };
const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname], env }));
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const show = (r) => { const t = r.content[0].text; console.log(r.isError ? "ERROR:" : "ok:", t.length > 300 ? t.slice(0, 300) + ` …(${t.length} chars)` : t); return t; };
show(await client.callTool({ name: "archibase_account", arguments: {} }));
const s = show(await client.callTool({ name: "search_floor_plans", arguments: { bedrooms: 2, m2_min: 60, m2_max: 61, limit: 3 } }));
const body = JSON.parse(s); console.log("payment:", JSON.stringify(body.payment), "ids:", body.results.map((r) => r.plan_id));
show(await client.callTool({ name: "get_floor_plan_geometry", arguments: { plan_id: "zz-does-not-exist" } }));
const g = show(await client.callTool({ name: "get_floor_plan_geometry", arguments: { plan_id: body.results[0].plan_id } }));
console.log("geometry payment:", JSON.stringify(JSON.parse(g).payment));
show(await client.callTool({ name: "search_floor_plans", arguments: { bedrooms: 3 } })); // should exceed the $0.15 budget
await client.close();
