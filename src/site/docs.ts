/**
 * /docs: human-readable API reference and data terms. Machine-readable equivalents are the
 * x402 discovery document (/.well-known/x402.json) and /llms.txt.
 */
import { esc, fmt, money, networkList, pageEnd, pageStart, type SiteInfo } from "./landing.js";

const DOCS_CSS = `
.docs{display:grid;grid-template-columns:200px minmax(0,1fr);gap:40px;padding-top:40px;padding-bottom:56px}
.docs nav.toc{display:block;height:auto;position:sticky;top:20px;align-self:start;font-size:14px}
.toc a{display:block;color:var(--muted);text-decoration:none;padding:4px 0}
.toc a:hover{color:var(--ink)}
.docs h1{font-size:34px;margin:0 0 8px;max-width:none}
.docs h2{margin-top:44px;padding-top:8px}
.docs h3{font-size:16px;margin:24px 0 8px}
.docs p,.docs li{max-width:75ch}
.docs table{margin:8px 0 4px}
.docs td code,.docs th code{white-space:nowrap}
.docs .card{padding:0 6px;overflow-x:auto}
.docs pre{margin:8px 0}
.docs main{min-width:0}
.docs p code,.docs li code{overflow-wrap:anywhere}
@media (max-width:820px){.docs{grid-template-columns:minmax(0,1fr);gap:0}.docs nav.toc{position:static;display:flex;flex-wrap:wrap;justify-content:flex-start;gap:2px 18px;margin-bottom:20px}.docs table{min-width:600px}}
`;

const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const table = (head: string[], rows: string[][]) =>
  `<div class="card"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div>`;

export function docsPage(info: SiteInfo): string {
  const base = esc(info.baseUrl);
  const price = esc(money(info.price));
  const vprice = esc(money(info.vectorPrice));
  const net = esc(networkList(info, true));
  const contact = info.contactEmail
    ? `<a href="mailto:${esc(info.contactEmail)}">${esc(info.contactEmail)}</a>`
    : "the project maintainers";

  const body = `
<div class="wrap docs">
<nav class="toc" aria-label="Contents">
  <a href="#overview">Overview</a><a href="#payment">Payment</a><a href="#credits">Credits</a><a href="#free">Free sample</a><a href="#search">Search</a><a href="#geometry">Geometry</a>
  <a href="#records">Record format</a><a href="#errors">Errors</a><a href="#terms">Data terms</a>
</nav>
<main>
<h1>API documentation</h1>
<p class="sub">The only structured, license-clean, machine-native floorplan corpus. Built for spatial AI, generative design, and architecture agents. 📐🏗️ ${fmt(info.catalogue.distinctLayouts)} real layouts as room graphs and metric geometry, behind two paid endpoints.</p>

<h2 id="overview">Overview</h2>
<p>Base URL: <code>${base}</code>. Responses are JSON. Areas are in square metres and coordinates in metres unless you ask for <code>units=imperial</code>.</p>
${table(["Endpoint", "Price", "Returns"], [
    [`<code>GET /api/v1/plans/search</code>`, price, "Up to 100 plans with room graphs, counts and provenance"],
    [`<code>GET /api/v1/plans/{plan_id}/vector</code>`, vprice, "One plan's room polygons, doors, windows and stairs"],
    [`<code>GET /.well-known/x402.json</code>`, "free", "Machine-readable discovery: prices, payment terms, JSON Schemas"],
    [`<code>GET /api/v1/sample</code>`, "free", "A fixed sample of real plans in the same format, with free geometry at <code>/api/v1/sample/{plan_id}/vector</code>"],
    [`<code>GET /api/v1/count</code>`, "free", "How many plans a search would match (same filters as search), so you can size a query before paying"],
    [`<code>GET /api/v1/account</code>`, "free", "Balance of an API key"],
    [`<code>GET /llms.txt</code>`, "free", "Plain-text summary for AI tools"],
  ])}
<p>Want to contribute or convert your own plans? The free <a href="/skills">agent skill</a> teaches any agent to turn a drawing into this format and validate it.</p>
<p>For AI assistants, the <code>archibase-mcp</code> server wraps both endpoints with spending limits. See the quick start on the <a href="/#start">home page</a>.</p>

<h2 id="payment">Payment (x402)</h2>
<p>Archibase uses <a href="https://x402.org">x402</a> v2. Paid calls settle in USDC on ${net}. The payment is a signed USDC authorisation that the facilitator submits, so the paying wallet needs no ETH for gas.</p>
<ol>
  <li>Call an endpoint without payment. A valid request returns <code>402 Payment Required</code> with a <code>PAYMENT-REQUIRED</code> header (base64 JSON) and the same terms in the body: amount in USDC base units (6 decimals), asset, network and recipient.</li>
  <li>Sign the payment with an x402 client and repeat the request with the <code>PAYMENT-SIGNATURE</code> header (<code>X-PAYMENT</code> is also accepted).</li>
  <li>The response carries the data and a <code>PAYMENT-RESPONSE</code> header with the settlement transaction.</li>
</ol>
<p>Queries are validated <em>before</em> payment: a malformed query (400) or an unknown plan (404) is never charged. If the payment service is unreachable you get a retryable 503 and nothing is charged.</p>

<h3 id="credits">API keys</h3>
<p>Trials and partners can be issued an API key (${contact}). Send it on the same endpoints as <code>X-API-Key: ak_…</code> or <code>Authorization: Bearer ak_…</code>; calls are spent from the key's balance at the same prices (${price} per search, ${vprice} per plan's geometry) and refunded if the request fails.</p>
<pre><code>curl -H "X-API-Key: ak_…" "${base}/api/v1/plans/search?bedrooms=3&amp;m2_max=90"</code></pre>
<ul>
  <li>Balance: <code>GET /api/v1/account</code> with the key returns <code>balance_usd</code>. Every successful paid response carries <code>X-Archibase-Credits-Remaining</code>.</li>
  <li>An unknown or disabled key gets <code>401 invalid_api_key</code>. An empty balance gets <code>402 insufficient_credits</code> with the balance. Keys go in headers, never in URLs.</li>
</ul>

<h3 id="free">Free sample and counts</h3>
<p><code>GET ${base}/api/v1/sample</code> accepts the same filters as search and returns a fixed set of real plans, each with a free geometry link, so you can write and test your parser before paying. <code>GET ${base}/api/v1/count</code> returns how many plans a search would match, with the price. Both are free and cached; the sample never grows beyond its fixed set. Or just <a href="/explore">try it in the browser</a>.</p>

<h2 id="search">Search</h2>
<p><code>GET ${base}/api/v1/plans/search</code>: ${price} per call. Results are sorted by area, smallest first.</p>
${table(["Parameter", "Type", "Meaning"], [
    ["<code>bedrooms</code>", "integer 0–20", "Exact bedroom count (labelled plus inferred; see <code>bedrooms_inferred</code>)"],
    ["<code>m2_min</code>, <code>m2_max</code>", "number", "Net interior area bounds in m², inclusive"],
    ["<code>sqft_min</code>, <code>sqft_max</code>", "number", "Same in square feet. Don't mix with the m² bounds"],
    ["<code>built</code>", "true / false", "Only plans of constructed buildings, or only unbuilt designs"],
    ["<code>source</code>", "string", "<code>dataset</code>, <code>habs</code>, <code>commissioned</code>, <code>synthetic</code>, <code>ai_generated</code>"],
    ["<code>building_type</code>", "string", "<code>residential</code>, <code>office</code>, <code>retail</code>, <code>transport</code>, <code>government</code>, <code>sports</code>, <code>hospitality</code>, <code>healthcare</code>, <code>cultural</code>, <code>education</code>, <code>industrial</code>, <code>mixed</code>, <code>other</code>"],
    ["<code>style</code>", "string", "Architectural style where known (most records are <code>unspecified</code>)"],
    ["<code>include_duplicates</code>", "true / false", "Default false: one plan per layout. True returns every copy"],
    ["<code>units</code>", "metric / imperial", "imperial returns <code>total_sqft</code> and room areas in sqft"],
    ["<code>limit</code>", "integer 1–100", "Maximum results (default 25)"],
  ])}
<pre><code>curl -i "${base}/api/v1/plans/search?bedrooms=2&amp;m2_min=60&amp;m2_max=80&amp;limit=10"</code></pre>
<p>The response is <code>{ count, units, filters, results: [record, …] }</code>. Each record's <code>vector_schema_url</code> is the paid geometry URL for that plan, or <code>null</code> when it has no geometry.</p>

<h2 id="geometry">Geometry</h2>
<p><code>GET ${base}/api/v1/plans/{plan_id}/vector</code>: ${vprice} per plan. Optional <code>units=imperial</code> for feet.</p>
${table(["Field", "Meaning"], [
    ["<code>rooms[]</code>", "<code>{ id, type, level, polygon }</code>. Ids match the search record's graph nodes"],
    ["<code>doors[]</code>", "<code>{ type, level, polygon }</code>; <code>type</code> is <code>door</code> or <code>entrance_door</code>"],
    ["<code>windows[]</code>", "<code>{ level, polygon }</code>"],
    ["<code>stairs[]</code>", "Stair zones: <code>{ id, level, polygon }</code>, plus <code>to_level</code>/<code>from_level</code>, risers, start/end, run and rise where known"],
    ["<code>polygon</code>", "A list of polygons; each is <code>[outer ring, …holes]</code>, each ring a closed list of <code>[x, y]</code> points"],
    ["<code>crs</code>", "How coordinates are framed. Plan-local; compass orientation is not always known"],
  ])}

<h2 id="records">Record format</h2>
${table(["Field", "Meaning"], [
    ["<code>plan_id</code>", "Stable id. The prefix shows the source: <code>sd-</code> Swiss Dwellings, <code>rp-</code> ResPlan, <code>habs-</code> HABS, <code>hk-</code> Hong Kong 3D Indoor Map"],
    ["<code>building_type</code>", "What the building is used for (absent means residential). Non-residential plans are one floor each, with <code>level</code> and <code>level_name</code> in the graph"],
    ["<code>total_area_m2</code>", "Net interior area (balconies and other exterior spaces excluded)"],
    ["<code>bedrooms</code>, <code>bedrooms_inferred</code>", "Bedrooms, and how many of them were inferred rather than labelled by the source"],
    ["<code>bathrooms</code>", "Full bathrooms count 1, toilet-only rooms 0.5 where the source distinguishes them"],
    ["<code>layout_copies</code>", "How many plans in the catalogue share this exact layout, this one included"],
    ["<code>adjacency_graph.nodes[]</code>", "Rooms: <code>id</code>, <code>type</code>, <code>area</code> (m²), <code>windows</code>, and where known <code>fixtures</code>, <code>exterior</code>, <code>stairwell</code>, <code>inferred_use</code>"],
    ["<code>adjacency_graph.edges[]</code>", "Undirected links <code>{ from, to, connection }</code>"],
    ["<code>provenance</code>", "<code>source</code>, <code>built</code>, <code>license</code>, <code>author</code>, <code>source_url</code> and <code>attribution</code> text"],
  ])}
<h3>Connections</h3>
${table(["connection", "Meaning"], [
    ["<code>door</code>", "A door between the two spaces"],
    ["<code>opening</code>", "Open connection with no wall between (e.g. an open kitchen)"],
    ["<code>entrance_door</code>", "The front door, linking the dwelling to an exterior or shared-circulation node"],
    ["<code>window</code>", "A window between two spaces, e.g. a room looking onto a balcony"],
    ["<code>stair</code>", "A stair linking rooms on different levels"],
    ["<code>adjacent</code>", "The spaces touch, but the source records no door or opening"],
  ])}
<h3>Rooms the source didn't label</h3>
<p>Some sources mark private rooms only as <code>room</code>. These are never relabelled. They keep <code>type: "room"</code> with an <code>inferred_use</code> of <code>bedroom</code>, <code>entry</code> or <code>unknown</code>, based on daylight, size and connections, and inferred bedrooms are counted in <code>bedrooms_inferred</code>.</p>

<h2 id="errors">Errors</h2>
${table(["Status", "Body", "Charged?"], [
    ["400", "<code>{ error: \"invalid_query\", details, schema }</code>", "No"],
    ["401", "<code>{ error: \"invalid_api_key\" }</code> (API key requests only)", "No"],
    ["402 (credits)", "<code>{ error: \"insufficient_credits\", balance_usd, price_usd, contact }</code>", "No"],
    ["402", "Payment terms (unpaid request, or a payment that was not accepted)", "No"],
    ["404", "<code>{ error: \"vector_not_found\", plan_id }</code>", "No"],
    ["503", "<code>{ error: \"payment_facilitator_unavailable\", retryable: true }</code>; retry after the <code>Retry-After</code> seconds", "No"],
    ["500", "<code>{ error: \"internal_error\" }</code>", "Payment is only settled after the data is ready"],
  ])}

<h2 id="terms">Data terms</h2>
<p>These terms describe how the data may be used. They summarise the licences of the underlying sources, so read the licence named in each record for the full conditions.</p>
<ul>
  <li><b>Licences.</b> Every record names its licence. Only licences that allow commercial use are accepted: public domain, CC0, CC BY 4.0, the Hong Kong Government's CSDI Portal terms (<code>HK-CSDI-TOU</code>), and data Archibase owns.</li>
  <li><b>Attribution.</b> CC BY 4.0 records (Swiss Dwellings, ResPlan) and Hong Kong records require attribution; Hong Kong records also acknowledge the Government's ownership of the source data. Keep the record's <code>attribution</code> text with the data or anything you publish from it. Records also note that Archibase modified the source data.</li>
  <li><b>Derived and inferred fields.</b> Room graphs, window counts and inferred room uses are derived by Archibase from the source geometry. They are checked but may contain errors. The data is provided as is, without warranty of fitness for any purpose, and is not a substitute for surveyed or professional drawings.</li>
  <li><b>Payments.</b> Each paid request is settled on-chain and is final. Requests that fail before the data is returned are not charged.</li>
  <li><b>Removal requests.</b> Some source plans were recovered from public listings. If you hold rights in a plan and want it removed, write to ${contact} with the <code>plan_id</code>. Removed plans are deleted from the catalogue.</li>
  <li><b>Dataset licences.</b> For bulk access to the full catalogue (training, benchmarks, products), write to ${contact}.</li>
</ul>
<h3>Sources</h3>
${table(["Source", "Distinct layouts", "Licence"], info.catalogue.sources.map((s) => [`${esc(s.name)}<span>${esc(s.detail)}</span>`, `${fmt(s.layouts)}`, `${esc(s.license)}<span>${esc(s.by)}</span>`]))}
</main>
</div>`;

  return (
    pageStart(info, {
      title: "Archibase API documentation: the floorplan corpus for spatial AI",
      description: "Archibase API reference: search and geometry endpoints, x402 payment, record format, errors and data terms.",
      path: "/docs",
      css: DOCS_CSS,
    }) +
    body +
    pageEnd(info)
  );
}
