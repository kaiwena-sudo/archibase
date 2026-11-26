/**
 * /explore: try the data in a browser. A free sample (bundled real plans, drawn client-side), live
 * counts for any query, and paid search and geometry from a browser wallet or an API key.
 * The behaviour lives in src/site/client/explore.js (served at /assets/explore.js).
 */
import { BUILDING_TYPES } from "../db/validate.js";
import { esc, money, networkName, pageEnd, pageStart, type SiteInfo } from "./landing.js";

const CSS = `
.explore-hero{padding-top:44px;padding-bottom:8px}
.explore-hero h1{font-size:clamp(28px,4vw,40px);max-width:24ch}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.chip{font:600 13px ui-sans-serif,system-ui,sans-serif;border:1px solid var(--line);background:var(--paper);color:var(--muted);padding:6px 12px;border-radius:999px;cursor:pointer}
.chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.tile{display:flex;flex-direction:column;gap:2px;text-align:left;cursor:pointer;font:inherit;color:inherit;padding:12px}
.tile:hover{border-color:var(--accent)}
.tile strong{font-size:14px;text-transform:capitalize}
.tile span{font-size:12px;color:var(--muted);line-height:1.4}
.thumb{height:150px;display:flex;align-items:center;justify-content:center;margin-bottom:8px}
.thumb svg{max-width:100%;max-height:150px;width:auto;height:auto}
.btn{font:600 14px ui-sans-serif,system-ui,sans-serif;border:1px solid var(--accent);background:var(--accent);color:#fff;padding:9px 16px;border-radius:8px;cursor:pointer;text-decoration:none;display:inline-block}
:root[data-theme="dark"] .btn,.btn{color:#fff}
@media (prefers-color-scheme:dark){.btn{color:#0b1020}}
.btn.small{padding:5px 10px;font-size:13px}
.btn.ghost{background:transparent;color:var(--accent)}
.qform{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;align-items:end}
.qform label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.qform input,.qform select,.keyrow input{font:15px ui-sans-serif,system-ui,sans-serif;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);min-width:0;width:100%}
.keyrow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end;margin-top:14px}
.keyrow label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
#count{margin:16px 0 4px;font-size:16px}
#status{min-height:1.5em;color:var(--muted);font-size:14px;margin:8px 0}
#pay-note{color:var(--muted);font-size:13px;margin:6px 0 0}
dialog{border:1px solid var(--line);border-radius:14px;background:var(--bg);color:var(--ink);padding:0;width:min(960px,94vw);max-height:92vh}
dialog::backdrop{background:rgba(10,12,16,.55)}
.dhead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding:16px 18px;border-bottom:1px solid var(--line)}
.dhead h2{font-size:18px;margin:0;text-transform:capitalize}
.dhead p{margin:2px 0 0;font-size:13px;color:var(--muted)}
.dbody{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:16px;padding:16px 18px;overflow:auto;max-height:calc(92vh - 70px)}
.dbody pre{max-height:380px;overflow:auto}
.dbody .plan svg{width:100%;height:auto;display:block}
.dtabs{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.dtabs button{font:600 13px ui-sans-serif,system-ui,sans-serif;border:1px solid var(--line);background:var(--paper);color:var(--muted);padding:6px 12px;border-radius:8px;cursor:pointer}
.dtabs button[aria-selected="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.dl{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.small-print{font-size:12px;color:var(--muted);margin-top:10px}
@media (max-width:900px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.qform{grid-template-columns:repeat(2,minmax(0,1fr))}.dbody{grid-template-columns:minmax(0,1fr)}}
`;

export function explorePage(info: SiteInfo, jsVersion: string): string {
  const testnet = info.network !== "eip155:8453";
  const cfg = {
    api: info.baseUrl,
    network: info.network,
    networkName: networkName(info.network),
    price: money(info.price).replace("$", ""),
    vectorPrice: money(info.vectorPrice).replace("$", ""),
    txUrl: testnet ? "https://sepolia.basescan.org/tx/" : "https://basescan.org/tx/",
  };
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  const options = BUILDING_TYPES.map((t) => `<option value="${t}">${esc(t)}</option>`).join("");
  const price = esc(money(info.price));
  const vprice = esc(money(info.vectorPrice));

  const body = `
<div class="wrap explore-hero">
  <div class="eyebrow">Free sample · no signup</div>
  <h1>Try the data before you build on it.</h1>
  <p class="lede">The only structured, license-clean, machine-native floorplan corpus. Open real plans from every source with full geometry, download the exact JSON the API returns, then query the whole corpus from this page or from code.</p>
</div>

<section style="border-top:0;padding-top:20px"><div class="wrap">
  <h2>Free sample</h2>
  <p class="sub">Real plans from each source, in the paid format. Click one to see the room graph, the geometry, and download both.</p>
  <div class="chips" id="chips" aria-label="Filter the sample by building type"></div>
  <div class="tiles" id="grid" aria-live="polite"></div>
  <p class="small-print">Sample data keeps its licences and attribution. See <a href="/docs#terms">data terms</a>.</p>
</div></section>

<section id="query"><div class="wrap">
  <h2>Query the full catalogue</h2>
  <p class="sub">The count is free and live. A search costs ${price} and returns up to 100 plans; one plan's geometry costs ${vprice}.</p>
  <form id="q" class="qform" autocomplete="off">
    <label>Building type<select name="building_type"><option value="">any</option>${options}</select></label>
    <label>Bedrooms<input name="bedrooms" type="number" min="0" max="20" inputmode="numeric" placeholder="any"></label>
    <label>Min m²<input name="m2_min" type="number" min="0" inputmode="decimal" placeholder="any"></label>
    <label>Max m²<input name="m2_max" type="number" min="0" inputmode="decimal" placeholder="any"></label>
    <label>Results<input name="limit" type="number" min="1" max="100" value="10" inputmode="numeric"></label>
  </form>
  <p id="count" aria-live="polite"></p>
  <div class="keyrow">
    <label>API key (optional)<input id="apikey" type="password" placeholder="ak_… leave empty to pay with a wallet" autocomplete="off" spellcheck="false"></label>
    <button class="btn" type="submit" form="q">Run search · ${price}</button>
  </div>
  <p id="pay-note"></p>
  <p id="status" role="status" aria-live="polite"></p>
  <div id="results"></div>
  <p class="small-print">Agents pay per call with <a href="/docs#payment">x402</a>. Need a trial key or the whole corpus? <a href="/docs#credits">Get in touch</a>.</p>
</div></section>

<dialog id="detail" aria-labelledby="d-title">
  <div class="dhead"><div><h2 id="d-title"></h2><p id="d-meta"></p></div><button class="btn small ghost" id="d-close" type="button">Close</button></div>
  <div class="dbody">
    <div class="plan" id="d-plan"></div>
    <div>
      <div class="dtabs"><button type="button" data-tab="record" aria-selected="true">Record</button><button type="button" data-tab="geometry" aria-selected="false">Geometry</button><button type="button" data-tab="curl" aria-selected="false">curl</button></div>
      <div data-panel="record"><pre><code id="d-record"></code></pre></div>
      <div data-panel="geometry" hidden><pre><code id="d-geometry"></code></pre></div>
      <div data-panel="curl" hidden><pre><code id="d-curl"></code></pre></div>
      <div class="dl"><a class="btn small" id="d-dl-record" href="#">Download record</a><a class="btn small ghost" id="d-dl-geometry" href="#">Download geometry</a></div>
      <p class="small-print" id="d-source"></p>
    </div>
  </div>
</dialog>
<script type="application/json" id="cfg">${cfgJson}</script>
<script type="module" src="/assets/explore.js?v=${esc(jsVersion)}"></script>`;

  return (
    pageStart(info, {
      title: "Try the Archibase floorplan corpus: free sample and live counts",
      description: "Browse real floor plans free, download the exact JSON, count matches for any query, and run paid searches from your browser.",
      path: "/explore",
      css: CSS,
    }) +
    `<main>${body}</main>` +
    pageEnd(info)
  );
}
