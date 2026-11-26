/**
 * The public landing page (served at / to browsers) and /llms.txt (for AI tools).
 * Plain strings, no framework: the Worker returns them directly.
 */
import type { Catalogue } from "./catalogue.js";
import { EXAMPLE_JSON, EXAMPLE_PLAN_ID, EXAMPLE_SVG, GALLERY } from "./example.js";

export interface SiteInfo {
  baseUrl: string;
  network: string;
  /** Further networks the 402 terms accept (X402_EXTRA_NETWORKS). */
  extraNetworks?: readonly string[];
  /** e.g. "$0.02" */
  price: string;
  vectorPrice: string;
  /** Shown for dataset-licence enquiries when set (CONTACT_EMAIL). */
  contactEmail?: string;
  /** Canonical site origin, e.g. https://archibase.dev (SITE_URL). Enables canonical/share tags. */
  siteUrl?: string;
  /** Live catalogue figures (src/site/catalogue.ts). */
  catalogue: Catalogue;
}



export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
export const fmt = (n: number) => n.toLocaleString("en-US");
/** "$0.1" -> "$0.10"; keeps extra decimals when the price has them ("$0.005"). */
export const money = (p: string): string => {
  const n = Number(p.replace(/^\$/, ""));
  if (!Number.isFinite(n)) return p;
  const decimals = (String(n).split(".")[1] ?? "").length;
  return `$${n.toFixed(Math.max(2, decimals))}`;
};
export const networkName = (n: string) =>
  ({ "eip155:8453": "Base", "eip155:84532": "Base Sepolia (testnet)", "eip155:137": "Polygon", "eip155:42161": "Arbitrum One" })[n] ?? n;
/** Every accepted network as prose, e.g. "Base, Polygon or Arbitrum One"; `ids` appends each CAIP-2 id. */
export const networkList = (info: Pick<SiteInfo, "network" | "extraNetworks">, ids = false) => {
  const names = [info.network, ...(info.extraNetworks ?? [])].map((n) => (ids ? `${networkName(n)} (${n})` : networkName(n)));
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0]!;
};
/** schema.org Dataset markup, so dataset search engines can index the catalogue. */
const datasetJsonLd = (info: SiteInfo) =>
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Archibase floor plans",
    description: `${fmt(info.catalogue.distinctLayouts)} distinct real floor plans (floorplans) as room adjacency graphs and metric vector geometry, with a licence and attribution on every record.`,
    url: `${info.siteUrl}/`,
    keywords: ["floor plans", "floorplans", "architecture", "room adjacency graph", "spatial AI"],
    isAccessibleForFree: false,
    license: `${info.siteUrl}/docs#terms`,
    creator: { "@type": "Organization", name: "Archibase", url: `${info.siteUrl}/` },
    isBasedOn: info.catalogue.sources.map((s) => ({ "@type": "CreativeWork", name: s.name, creditText: s.by })),
  }).replace(/</g, "\\u003c");

/** Shared stylesheet for every page. */
const CSS = `
:root{--bg:#f7f6f2;--paper:#fff;--ink:#1b1d21;--muted:#5d6370;--line:#d9d6cc;--accent:#1f4fd1;--accent-soft:#e7edfc;--code:#f0eee8;
--bed:#dce8fb;--bath:#dcf1e4;--kit:#fbe9d0;--liv:#efe4f6;--bal:#ececec;--wall:#2a2d33}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121417;--paper:#1a1d22;--ink:#e8e6e1;--muted:#9aa0ab;--line:#2c3038;--accent:#7ea2ff;--accent-soft:#1d2740;--code:#20242b;
--bed:#24344f;--bath:#203d2e;--kit:#47361f;--liv:#3a2c45;--bal:#2b2e33;--wall:#c9ccd2}}
:root[data-theme="dark"]{--bg:#121417;--paper:#1a1d22;--ink:#e8e6e1;--muted:#9aa0ab;--line:#2c3038;--accent:#7ea2ff;--accent-soft:#1d2740;--code:#20242b;
--bed:#24344f;--bath:#203d2e;--kit:#47361f;--liv:#3a2c45;--bal:#2b2e33;--wall:#c9ccd2}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
header{border-bottom:1px solid var(--line)}
nav{display:flex;align-items:center;justify-content:space-between;height:60px;gap:16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.01em;color:var(--ink);text-decoration:none}
.brand svg{width:22px;height:22px}
nav .links{display:flex;gap:18px;font-size:14px}
nav .links a{color:var(--muted);text-decoration:none}
nav .links a:hover{color:var(--ink)}
a{color:var(--accent)}
.hero{padding-top:64px;padding-bottom:40px}
.eyebrow{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
h1{font-size:clamp(32px,5vw,52px);line-height:1.08;letter-spacing:-.02em;margin:14px 0 18px;max-width:20ch}
.lede{font-size:19px;color:var(--muted);max-width:60ch;margin:0}
.cta{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin:26px 0 0}
.cta-btn{font:600 16px ui-sans-serif,system-ui,sans-serif;background:var(--accent);color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none}
@media (prefers-color-scheme:dark){.cta-btn{color:#0b1020}}
.cta-link{font-weight:600;text-decoration:none}
.facts{display:flex;flex-wrap:wrap;gap:10px;margin:26px 0 0;padding:0;list-style:none}
.facts li{background:var(--paper);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:14px}
.facts b{font-variant-numeric:tabular-nums}
.banner{background:#fff4d6;color:#5c4400;border-bottom:1px solid #f0d98c;font-size:14px;padding:8px 0}
section{padding:44px 0;border-top:1px solid var(--line)}
h2{font-size:24px;letter-spacing:-.01em;margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 24px;max-width:70ch}
.example{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:20px;align-items:start}
.card{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;min-width:0}
.card h3{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.plan svg{width:100%;height:auto;display:block}
.plan .room{stroke:var(--wall);stroke-width:2;fill:var(--paper)}.plan .r-balcony{fill:var(--bal)}
.plan .r-bedroom{fill:var(--bed)}.plan .r-bathroom{fill:var(--bath)}.plan .r-kitchen{fill:var(--kit)}.plan .r-living{fill:var(--liv)}
.plan .door{fill:#9a6a3a}.plan .entrance{fill:#d0402b}.plan .window{fill:var(--accent)}
.plan .lbl{font:600 12px ui-sans-serif,system-ui,sans-serif;fill:var(--ink);text-anchor:middle}
.plan .area{font:11px ui-monospace,Menlo,monospace;fill:var(--muted);text-anchor:middle}
.plan .scale{stroke:var(--ink);stroke-width:3}
.gallery{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;align-items:start}
.gallery figure{margin:0;display:flex;flex-direction:column;justify-content:space-between;height:100%}
.gallery svg{max-height:340px}
.gallery figcaption{margin-top:12px;font-size:14px}
.gallery figcaption span{display:block;color:var(--muted);font-size:13px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-top:10px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
pre{margin:0;background:var(--code);border-radius:8px;padding:14px;overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
code{font:0.92em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:4px}
pre code{background:none;padding:0}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;counter-reset:s;margin:0;padding:0;list-style:none}
.steps li{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:18px;counter-increment:s}
.steps li::before{content:counter(s);display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:13px;margin-bottom:10px}
.steps h3{margin:0 0 6px;font-size:16px}
.steps p{margin:0;color:var(--muted);font-size:15px}
.tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.tabs button{font:600 13px ui-sans-serif,system-ui,sans-serif;border:1px solid var(--line);background:var(--paper);color:var(--muted);padding:6px 12px;border-radius:8px;cursor:pointer}
.tabs button[aria-selected="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.panel[hidden]{display:none}
.price{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.price .card p{margin:4px 0 0;color:var(--muted);font-size:15px}
.price .amt{font-size:30px;font-weight:700;letter-spacing:-.02em}
.price .amt small{font-size:14px;color:var(--muted);font-weight:500}
table{width:100%;border-collapse:collapse;font-size:15px}
td,th{text-align:left;padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
td span{display:block;color:var(--muted);font-size:13px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.problems{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.problems .card h3{margin:0 0 6px;font:600 17px/1.3 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}
.problems p{margin:0;color:var(--muted);font-size:15px}
.fix{margin-top:16px;border-left:4px solid var(--accent);font-size:16px;line-height:1.6}
.fix strong{color:var(--accent)}
.notes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 28px;margin:0;padding:0;list-style:none}
.notes li{padding-left:16px;position:relative;color:var(--muted);font-size:15px}
.notes li::before{content:"";position:absolute;left:0;top:.6em;width:6px;height:6px;border-radius:50%;background:var(--accent)}
.notes b{color:var(--ink)}
footer{border-top:1px solid var(--line);padding:28px 0 48px;color:var(--muted);font-size:14px}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}
footer a{color:var(--muted)}
@media (max-width:820px){.example,.price,.notes,.gallery,.problems{grid-template-columns:1fr}.steps{grid-template-columns:1fr}.hero{padding-top:40px;padding-bottom:28px}nav .links a.opt{display:none}}
`;

export interface PageMeta {
  title: string;
  description: string;
  /** Path on the site, e.g. "/" or "/docs". */
  path: string;
  /** Extra CSS for this page. */
  css?: string;
}

/** Document head, testnet banner and site header. */
export function pageStart(info: SiteInfo, page: PageMeta): string {
  const testnet = info.network !== "eip155:8453";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
${info.siteUrl ? `<link rel="canonical" href="${esc(info.siteUrl + page.path)}">` : ""}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Archibase">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
${info.siteUrl ? `<meta property="og:url" content="${esc(info.siteUrl + page.path)}">\n<meta property="og:image" content="${esc(info.siteUrl)}/og.png">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">` : ""}
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M4 4h24v24H4z' fill='none' stroke='%231f4fd1' stroke-width='3'/%3E%3Cpath d='M4 16h12v12M16 4v8' fill='none' stroke='%231f4fd1' stroke-width='3'/%3E%3C/svg%3E">
${info.siteUrl && page.path === "/" ? `<script type="application/ld+json">${datasetJsonLd(info)}</script>\n` : ""}<style>${CSS}${page.css ?? ""}</style>
</head>
<body>
${testnet ? `<div class="banner"><div class="wrap">This is the <strong>testnet</strong> deployment: payments use test USDC on Base Sepolia.</div></div>` : ""}
<header><div class="wrap"><nav>
<a class="brand" href="/"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 4h24v24H4z" fill="none" stroke="currentColor" stroke-width="3"/><path d="M4 16h12v12M16 4v8" fill="none" stroke="var(--accent)" stroke-width="3"/></svg>Archibase</a>
<div class="links"><a href="/#why" class="opt">Why</a><a href="/explore"><strong>Try it free</strong></a><a href="/#pricing" class="opt">Pricing</a><a href="/docs">Docs</a></div>
</nav></div></header>`;
}

/** Site footer and closing tags. */
export function pageEnd(info: SiteInfo): string {
  return `<footer><div class="wrap">
  <span>Archibase · floor plan data for AI agents</span>
  <span><a href="/docs">Docs</a> · <a href="/skills">Agent skills</a> · <a href="/docs#terms">Terms</a> · <a href="/.well-known/x402.json">x402 discovery</a> · <a href="/llms.txt">llms.txt</a> · <a href="/health">status</a>${info.contactEmail ? ` · <a href="mailto:${esc(info.contactEmail)}">${esc(info.contactEmail)}</a>` : ""}</span>
</div></footer>
<script>
(function(){var tabs=document.querySelectorAll('[role=tab]');tabs.forEach(function(t){t.addEventListener('click',function(){tabs.forEach(function(o){o.setAttribute('aria-selected',o===t?'true':'false');document.getElementById(o.getAttribute('aria-controls')).hidden=o!==t;});});});})();
</script>
</body>
</html>`;
}

export function landingPage(info: SiteInfo): string {
  const base = esc(info.baseUrl);
  const net = esc(networkList(info));
  const price = esc(money(info.price));
  const vprice = esc(money(info.vectorPrice));
  const testnet = info.network !== "eip155:8453";
  const sources = info.catalogue.sources
    .map((s) => `<tr><td><strong>${esc(s.name)}</strong><span>${esc(s.detail)}</span></td><td class="num">${fmt(s.layouts)}</td><td>${esc(s.license)}<span>${esc(s.by)}</span></td></tr>`)
    .join("");

  return pageStart(info, {
    title: "Archibase: the structured, license-clean floorplan corpus",
    description: `The only structured, license-clean, machine-native floorplan corpus. Built for spatial AI, generative design, and architecture agents. ${fmt(info.catalogue.distinctLayouts)} real layouts, paid per call with x402.`,
    path: "/",
  }) + `

<main>
<div class="wrap hero">
  <div class="eyebrow">Floorplan corpus · spatial AI</div>
  <h1>The only structured, license-clean, machine-native floorplan corpus.</h1>
  <p class="lede">Built for spatial AI, generative design, and architecture agents. 📐🏗️ ${fmt(info.catalogue.distinctLayouts)} real layouts as room graphs and metric geometry, every record under a commercial-use licence. Agents search and buy per call: no account, no subscription.</p>
  <p class="cta"><a class="cta-btn" href="/explore">Try the free sample</a><a class="cta-link" href="/docs">Read the docs</a></p>
  <ul class="facts">
    <li><b>${fmt(info.catalogue.distinctLayouts)}</b> real layouts</li>
    <li><b>${price}</b> per search</li>
    <li><b>${vprice}</b> per plan's geometry</li>
    <li>Commercial-use licences only</li>
  </ul>
</div>

<section id="why"><div class="wrap">
  <h2>Why a corpus, and why this one</h2>
  <p class="sub">Anything that reasons about buildings needs real layouts: generative design, valuation, furnishing, robotics, benchmarks. Getting them is the hard part.</p>
  <div class="problems">
    <div class="card"><h3>Plans are pictures, not data</h3><p>Most floor plans exist only as images or PDFs. A model can't reliably read from a picture which room connects to which, how big each one is, or where the windows are.</p></div>
    <div class="card"><h3>Open datasets are raw</h3><p>Every dataset has its own format, units and labels. In Swiss Dwellings, 45% of apartments repeat a layout already in the set. In ResPlan, coordinates aren't in metres and about a third of plans have no usable floor area. Teams spend weeks cleaning before they can start.</p></div>
    <div class="card"><h3>Licences are a minefield</h3><p>Many of the best-known floor plan datasets are licensed for research only, not for products. Building on one means rebuilding later.</p></div>
    <div class="card"><h3>Agents can't sign contracts</h3><p>Data vendors expect accounts, API keys and subscriptions. An AI agent in the middle of a task can't sign up, but it can pay a few cents for exactly the data it needs.</p></div>
  </div>
  <div class="fix card"><strong>Archibase fixes this.</strong> One consistent format across every source, in metres. Repeats collapsed, room labels kept honest, every record checked on import. Only licences that allow commercial use, with attribution included. Paid per call over HTTP with <a href="https://x402.org">x402</a>, so agents can buy without a human in the loop.</div>
</div></section>

<section id="who"><div class="wrap">
  <h2>Who it's for</h2>
  <ul class="notes">
    <li><b>AI design tools.</b> Real precedents to retrieve, train on and check generated plans against.</li>
    <li><b>Proptech and valuation.</b> Layout features such as room mix, window counts and an open or closed kitchen, as numbers.</li>
    <li><b>Interior, furnishing and AR apps.</b> Real rooms with sizes, doors and windows to place things in.</li>
    <li><b>Robotics and simulation.</b> Realistic indoor layouts with metric geometry for virtual environments.</li>
    <li><b>Researchers and benchmarks.</b> Consistent graphs with stated provenance, at the scale of the whole catalogue.</li>
    <li><b>AI assistants.</b> An MCP server lets Claude and other assistants look up real plans when someone asks.</li>
  </ul>
</div></section>

<section id="example"><div class="wrap">
  <h2>What one plan looks like</h2>
  <p class="sub">A search returns each plan as a graph: rooms with type, area and windows, linked by doors and openings. Buy the geometry and you get the shapes in metres. This is plan <code>${EXAMPLE_PLAN_ID}</code>, drawn from the data the API returns.</p>
  <div class="example">
    <div class="card plan"><h3>GET /api/v1/plans/${EXAMPLE_PLAN_ID}/vector</h3>${EXAMPLE_SVG}
      <div class="legend"><span><i style="background:#9a6a3a"></i>door</span><span><i style="background:#d0402b"></i>entrance</span><span><i style="background:var(--accent)"></i>window</span></div>
    </div>
    <div class="card"><h3>GET /api/v1/plans/search?bedrooms=3</h3><pre><code>${esc(EXAMPLE_JSON)}</code></pre></div>
  </div>
</div></section>

<section id="gallery"><div class="wrap">
  <h2>Every source, one format</h2>
  <p class="sub">Swiss apartments, South Asian homes, Hong Kong offices, factories and stations, and historic US houses all come back with the same room types, units and fields, so one parser handles the whole catalogue.</p>
  <div class="gallery">${GALLERY.map(
    (g) => `<figure class="card plan">${g.svg}<figcaption><strong>${esc(g.caption)}</strong><span>${esc(g.summary)} · <code>${esc(g.plan_id)}</code></span></figcaption></figure>`,
  ).join("")}</div>
</div></section>

<section><div class="wrap">
  <h2>How paying works</h2>
  <p class="sub">Archibase uses <a href="https://x402.org">x402</a>, the HTTP standard for machine payments. Payments are signed USDC authorisations, so your wallet needs no ETH for gas.</p>
  <ol class="steps">
    <li><h3>Ask</h3><p>Your agent calls the endpoint. Bad queries and unknown plans get a free 400 or 404.</p></li>
    <li><h3>See the price</h3><p>A valid request gets <code>402 Payment Required</code> with the exact amount, asset and network.</p></li>
    <li><h3>Pay and receive</h3><p>An x402 client signs the payment and retries. The data comes back with a settlement receipt.</p></li>
  </ol>
</div></section>

<section id="start"><div class="wrap">
  <h2>Quick start</h2>
  <p class="sub">Use the MCP server with Claude and other assistants, any x402 client in code, or look at the payment terms with curl.</p>
  <div class="tabs" role="tablist">
    <button role="tab" aria-selected="true" aria-controls="t-mcp" id="b-mcp">MCP (Claude, Cursor)</button>
    <button role="tab" aria-selected="false" aria-controls="t-ts" id="b-ts">TypeScript</button>
    <button role="tab" aria-selected="false" aria-controls="t-curl" id="b-curl">curl</button>
  </div>
  <div class="panel" id="t-mcp" role="tabpanel" aria-labelledby="b-mcp"><pre><code>{
  "mcpServers": {
    "archibase": {
      "command": "npx",
      "args": ["-y", "archibase-mcp"],
      "env": {
        "ARCHIBASE_PRIVATE_KEY": "0x… a dedicated spending wallet with a little USDC on Base",
        "ARCHIBASE_BUDGET_USD": "2"
      }
    }
  }
}</code></pre><p class="sub" style="margin:10px 0 0">The server caps spending per call and per session, and only reports prices if no wallet is set.</p></div>
  <div class="panel" id="t-ts" role="tabpanel" aria-labelledby="b-ts" hidden><pre><code>import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "${esc(info.network)}", client: new ExactEvmScheme(privateKeyToAccount(KEY)) }],
});
const res = await pay("${base}/api/v1/plans/search?bedrooms=3&amp;m2_min=80&amp;m2_max=110");
const { results } = await res.json();</code></pre></div>
  <div class="panel" id="t-curl" role="tabpanel" aria-labelledby="b-curl" hidden><pre><code># Payment terms (free)
curl ${base}/.well-known/x402.json

# A search without payment returns 402 with the price
curl -i "${base}/api/v1/plans/search?bedrooms=2&amp;m2_max=70"</code></pre></div>
</div></section>

<section id="pricing"><div class="wrap">
  <h2>Pricing</h2>
  <p class="sub">Pay only for what you use, settled per request in USDC on ${net}.</p>
  <div class="price">
    <div class="card"><div class="amt">${price} <small>per search</small></div><p>Up to 100 plans per call, filtered by bedrooms, area, provenance and built status. Results include the room graph of every plan.</p></div>
    <div class="card"><div class="amt">${vprice} <small>per plan</small></div><p>Full geometry for one plan: room polygons in metres (ids match the graph), doors, windows and stair zones.</p></div>
  </div>
  <div class="price" style="margin-top:16px">
    <div class="card"><div class="amt">Free <small>to try</small></div><p>A sample of real plans with full geometry, and live counts for any query. <a href="/explore">Open the sample</a>.</p></div>
    <div class="card"><div class="amt">Dataset <small>licence</small></div><p>The whole corpus for training, evaluation and products${info.contactEmail ? `: <a href="mailto:${esc(info.contactEmail)}?subject=Archibase%20dataset%20licence">${esc(info.contactEmail)}</a>` : ""}.</p></div>
  </div>
</div></section>

<section><div class="wrap">
  <h2>The catalogue</h2>
  <p class="sub">Every record carries its source, licence and the attribution to keep. Only licences that allow commercial use are accepted.</p>
  <div class="card" style="padding:0 6px;overflow-x:auto"><table>
    <thead><tr><th>Source</th><th class="num">Distinct layouts</th><th>Licence</th></tr></thead>
    <tbody>${sources}</tbody>
  </table></div>
  <p class="sub" style="margin:14px 0 0">By building type: ${info.catalogue.byBuildingType.map((b) => `${esc(b.type)} <b>${fmt(b.layouts)}</b>`).join(" · ")}. Figures are live from the database.</p>
  <ul class="notes" style="margin-top:26px">
    <li><b>Repeats collapsed.</b> The same apartment or office floor repeated ten times is returned once, with <code>layout_copies</code> or <code>identical_levels</code> saying how many exist.</li>
    <li><b>Honest labels.</b> Rooms the source didn't label are never presented as bedrooms. Inferred ones are counted separately.</li>
    <li><b>Metric throughout.</b> Areas in m², geometry in metres. Add <code>units=imperial</code> for square feet and feet.</li>
    <li><b>Checked on import.</b> Implausible scales, overlapping rooms and merged units are rejected or flagged, not served.</li>
  </ul>
</div></section>
</main>

` + pageEnd(info);
}

export function llmsTxt(info: SiteInfo): string {
  return `# Archibase

> The only structured, license-clean, machine-native floorplan corpus. Built for spatial AI, generative design, and architecture agents. Homes plus offices, industrial buildings, stations, shops and public buildings as room adjacency graphs (rooms with type, m², window count; door/opening/entrance edges), building type, provenance and metric vector geometry. ${fmt(info.catalogue.distinctLayouts)} distinct layouts. Paid per request with x402 in USDC on ${networkList(info, true)}: no account needed.

## API

- [Discovery (x402)](${info.baseUrl}/.well-known/x402.json): resources, prices, input/output JSON Schemas, payment terms
- Search: GET ${info.baseUrl}/api/v1/plans/search, ${money(info.price)} per call. Query: bedrooms, m2_min, m2_max (or sqft_min, sqft_max), building_type (residential|office|retail|transport|government|sports|hospitality|healthcare|cultural|education|industrial|mixed|other), built, source, include_duplicates, units (metric|imperial), limit (<= 100)
- Geometry: GET ${info.baseUrl}/api/v1/plans/{plan_id}/vector, ${money(info.vectorPrice)} per plan. Room polygons in metres (ids match the search graph), doors, windows, stairs. Follow vector_schema_url from search results; null means no geometry
- Unpaid requests get HTTP 402 with a PAYMENT-REQUIRED header; retry with PAYMENT-SIGNATURE (x402 v2). Invalid queries (400) and unknown plans (404) are free

## Using it

- Free: GET ${info.baseUrl}/api/v1/sample (a fixed set of real plans, same format, free geometry at /api/v1/sample/{plan_id}/vector) and GET ${info.baseUrl}/api/v1/count (matches for any search filters, with the price). Browser: ${info.baseUrl}/explore
- MCP server: npx -y archibase-mcp (env ARCHIBASE_PRIVATE_KEY = a dedicated spending wallet with ARCHIBASE_BUDGET_USD capping spend, or ARCHIBASE_API_KEY = a key issued on request, no wallet)
- API keys (prepaid credits) are issued on request for trials and partners: send as X-API-Key on the same endpoints; GET /api/v1/account shows the balance. Write to the contact address on the site
- Agent skill (free, MIT): teaches any agent to convert a floor plan into this format and validate it. Zip: ${info.baseUrl}/skills/archibase-plan-converter.zip; index of files: ${info.baseUrl}/skills/index.json; page: ${info.baseUrl}/skills
- Any x402 client, e.g. @x402/fetch with @x402/evm

## Data

${info.catalogue.sources.map((s) => `- ${s.name}: ${s.detail}; ${fmt(s.layouts)} layouts; ${s.license} (${s.by})`).join("\n")}
- Repeated layouts are collapsed by default (layout_copies gives the count). Rooms a source left unlabelled stay type "room" with an inferred_use; bedrooms_inferred counts the inferred bedrooms
- Every record includes provenance with licence and attribution text to keep
`;
}
