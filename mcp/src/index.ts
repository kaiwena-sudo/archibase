#!/usr/bin/env node
/**
 * Archibase MCP server (stdio). Gives an AI assistant three tools:
 *   - search_floor_plans       paid search over real floor plans (room graphs, areas, provenance)
 *   - get_floor_plan_geometry  paid metric geometry for one plan (room polygons, doors, windows, stairs)
 *   - archibase_account        free: prices, wallet, and how much of the session budget is left
 *
 * Configuration (environment):
 *   ARCHIBASE_PRIVATE_KEY    key of a dedicated spending wallet holding a little USDC on Base.
 *                            Without it, paid tools report the price instead of paying.
 *   ARCHIBASE_BUDGET_USD     max total spend per session (default 2)
 *   ARCHIBASE_MAX_PRICE_USD  max price of any single call (default 0.25)
 *   ARCHIBASE_NETWORK        eip155:8453 (Base, default) or eip155:84532 (Base Sepolia testnet)
 *   ARCHIBASE_API_URL        API base URL
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ArchibaseClient, loadConfig, type PaidResult } from "./client.js";

const VERSION = "0.1.0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError && { isError: true }),
});

function describePaid(r: PaidResult, client: ArchibaseClient): ToolResult {
  if (client.cfg.apiKey) {
    const body = r.body as { error?: string; balance_usd?: number } | null;
    if (r.status === 401) return text("The API key was rejected. Check ARCHIBASE_API_KEY.", true);
    if (r.status === 402 && body?.error === "insufficient_credits") {
      return text(`Out of credits (balance $${body.balance_usd}). Nothing was charged. Ask the Archibase contact to top up the key.`, true);
    }
    if (r.status >= 400) return text({ error: `HTTP ${r.status}`, details: r.body }, true);
    return text({ ...(r.body as object), credits: { remaining_usd: r.creditsRemainingUsd } });
  }
  if (r.status === 402 && client.walletAddress) {
    const reason = (r.body as { error?: string } | null)?.error ?? "unknown reason";
    return text(`The payment was not accepted (${reason}). Nothing was charged. Check the wallet's USDC balance and network.`, true);
  }
  if (r.status === 402) {
    const accepts = (r.body as { accepts?: { amount?: string; network?: string }[] } | null)?.accepts ?? [];
    const price = accepts[0]?.amount ? `$${Number(accepts[0].amount) / 1e6} USDC` : "a small USDC payment";
    return text(
      `This call costs ${price} on ${accepts[0]?.network ?? "Base"}, and no wallet is configured, so nothing was bought. ` +
        "Set ARCHIBASE_PRIVATE_KEY to a dedicated spending wallet holding a little USDC on Base (see the archibase-mcp README).",
      true,
    );
  }
  if (r.status >= 400) return text({ error: `HTTP ${r.status}`, details: r.body }, true);
  const out: Record<string, unknown> = { ...(r.body as object) };
  if (r.paid) {
    out.payment = { ...r.paid, session_spent_usd: client.spentUsd, session_remaining_usd: client.remainingUsd };
  }
  return text(out);
}

export function buildServer(client: ArchibaseClient): McpServer {
  const server = new McpServer({ name: "archibase", version: VERSION });

  server.registerTool(
    "search_floor_plans",
    {
      title: "Search floor plans",
      description:
        "Search the Archibase corpus of real, built residential floor plans (about 41,000 distinct layouts: Swiss apartments " +
        "and South Asian homes and apartments, plus historic US houses). Each result has a room adjacency graph (rooms with " +
        "type, m², window count; edges for doors, openings, entrances), bedroom and bathroom counts, provenance and licence. " +
        "Costs $0.02 USDC per call, paid automatically from the configured wallet. Results are sorted by area, smallest first. " +
        "Use get_floor_plan_geometry with a plan_id when you need the actual shapes.",
      inputSchema: {
        bedrooms: z.number().int().min(0).max(20).optional().describe("Exact number of bedrooms"),
        m2_min: z.number().min(0).optional().describe("Minimum net interior area in m²"),
        m2_max: z.number().min(0).optional().describe("Maximum net interior area in m²"),
        built: z.boolean().optional().describe("true = only plans of buildings that were actually built"),
        source: z.enum(["dataset", "habs", "commissioned", "synthetic", "ai_generated"]).optional().describe("Provenance filter; habs = historic US surveys"),
        building_type: z
          .enum(["residential", "office", "retail", "transport", "government", "sports", "hospitality", "healthcare", "cultural", "education", "industrial", "mixed", "other"])
          .optional()
          .describe("What the building is used for. Non-residential plans are one floor each"),
        include_duplicates: z.boolean().optional().describe("Return every copy of repeated layouts (default: one per layout)"),
        units: z.enum(["metric", "imperial"]).optional().describe("imperial returns sqft instead of m²"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 25)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== undefined) q.set(k, String(v));
      try {
        return describePaid(await client.get(`/api/v1/plans/search?${q}`), client);
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  server.registerTool(
    "get_floor_plan_geometry",
    {
      title: "Get floor plan geometry",
      description:
        "Buy one plan's vector geometry: room polygons in metres (ids match the search result's graph), doors, windows and " +
        "stair zones. Costs $0.10 USDC. Only plans whose search result has a non-null vector_schema_url have geometry; " +
        "an unknown plan returns a free 404.",
      inputSchema: {
        plan_id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/).describe("plan_id from search_floor_plans"),
        units: z.enum(["metric", "imperial"]).optional().describe("imperial returns feet"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ plan_id, units }) => {
      try {
        const q = units === "imperial" ? "?units=imperial" : "";
        return describePaid(await client.get(`/api/v1/plans/${plan_id}/vector${q}`), client);
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  server.registerTool(
    "archibase_account",
    {
      title: "Archibase prices and budget",
      description: "Free. Current prices, the network and wallet in use, and how much of this session's spending budget is left.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      let prices: unknown = "unavailable";
      try {
        const d = (await client.discovery()) as { resources?: { resource?: string; price?: unknown }[] };
        prices = (d.resources ?? []).map((r) => ({ resource: r.resource, price: r.price }));
      } catch (err) {
        prices = `could not fetch prices: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (client.cfg.apiKey) {
        // Prepaid credits: the balance, not a session budget, is the spending cap.
        let balance: unknown = "unavailable";
        try {
          const res = await fetch(`${client.cfg.apiUrl}/api/v1/account`, { headers: { "X-API-Key": client.cfg.apiKey }, signal: AbortSignal.timeout(15_000) });
          const body = (await res.json()) as { balance_usd?: number; error?: string };
          balance = res.ok ? body.balance_usd : `error: ${body.error ?? res.status}`;
        } catch (err) {
          balance = `could not fetch balance: ${err instanceof Error ? err.message : String(err)}`;
        }
        return text({ api: client.cfg.apiUrl, mode: "prepaid credits (API key)", credits_balance_usd: balance, prices });
      }
      return text({
        api: client.cfg.apiUrl,
        network: client.cfg.network,
        mode: client.walletAddress ? "wallet (x402)" : "no payment method (paid tools only report prices)",
        wallet: client.walletAddress ?? "not configured (paid tools will only report prices)",
        max_price_per_call_usd: client.cfg.maxPriceUsd,
        session_budget_usd: client.cfg.budgetUsd,
        session_spent_usd: client.spentUsd,
        session_remaining_usd: client.remainingUsd,
        prices,
      });
    },
  );

  return server;
}

async function main() {
  const client = new ArchibaseClient(loadConfig());
  await buildServer(client).connect(new StdioServerTransport());
  // stdout carries the protocol; log to stderr only.
  console.error(`archibase-mcp ${VERSION} on ${client.cfg.network}, wallet ${client.walletAddress ?? "none"}, budget $${client.cfg.budgetUsd}`);
}

if (process.argv[1] && /archibase-mcp|index\.(js|ts)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
