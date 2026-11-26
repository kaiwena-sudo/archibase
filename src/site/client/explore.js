// Archibase explorer (browser script, served at /assets/explore.js).
// Plain ES module with no dependencies. The pure functions (planSvg, paymentTypedData, buildPayment,
// parseChallenge) are exported and unit-tested in Node; the UI starts only when a document exists.
// A copy is embedded in src/site/client-bundle.ts by scripts/build-client.ts: edit here, then rebuild.

/* ---------------------------------------------------------------- drawing */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Colour class for a room type; the page stylesheet defines .r-bedroom, .r-bathroom, .r-kitchen, .r-living, .r-balcony. */
export function colourClass(type) {
  if (type === "bedroom" || type === "room") return "bedroom";
  if (/^(unit|office|space|classroom|retail|food_service|meeting_room)$/.test(type)) return "bedroom";
  if (/^(corridor|lobby|platform|concourse)$/.test(type)) return "living";
  if (type === "restroom" || type === "bathroom" || type === "toilet") return "bathroom";
  if (type === "kitchen") return "kitchen";
  if (/living|dining|lounge|parlor|parlour/.test(type)) return "living";
  if (/balcony|loggia|terrace|porch|veranda|garden|stairs|elevator|escalator|steps|ramp|non_public|void/.test(type)) return "balcony";
  return "other";
}

/** Dominant wall direction in radians (0 to 90 degrees), weighted by edge length; used to straighten drawings. */
export function dominantAngle(polys) {
  const bins = new Map();
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const dx = ring[i + 1][0] - ring[i][0];
        const dy = ring[i + 1][1] - ring[i][1];
        let a = Math.atan2(dy, dx) % (Math.PI / 2);
        if (a < 0) a += Math.PI / 2;
        const bin = Math.round((a * 180) / Math.PI) % 90;
        bins.set(bin, (bins.get(bin) || 0) + Math.hypot(dx, dy));
      }
    }
  }
  let best = 0;
  let w = -1;
  for (const [bin, len] of bins) if (len > w) { best = bin; w = len; }
  return (best * Math.PI) / 180;
}

const ringArea = (r) => {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
};

function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const f = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    a += f;
    cx += (ring[i][0] + ring[i + 1][0]) * f;
    cy += (ring[i][1] + ring[i + 1][1]) * f;
  }
  return Math.abs(a) < 1e-9 ? ring[0] : [cx / (3 * a), cy / (3 * a)];
}

/**
 * Draw one level of a plan as an SVG string. `v` is the geometry response, `plan` the search record (for
 * room areas). Shows the level with the most rooms, rotated to the dominant wall direction, y up.
 */
export function planSvg(v, plan, opts = {}) {
  const labels = opts.labels !== false;
  const counts = new Map();
  for (const r of v.rooms) counts.set(r.level, (counts.get(r.level) || 0) + 1);
  const level = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const rooms = v.rooms.filter((r) => r.level === level);
  const doors = (v.doors || []).filter((d) => d.level === level);
  const wins = (v.windows || []).filter((w) => w.level === level);
  const theta = -dominantAngle(rooms.flatMap((r) => r.polygon));
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const rot = (p) => [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos];
  const tf = (polys) => polys.map((poly) => poly.map((ring) => ring.map(rot)));
  const R = rooms.map((r) => ({ id: r.id, type: r.type, polys: tf(r.polygon) }));
  const D = doors.map((d) => ({ type: d.type, polys: tf(d.polygon) }));
  const W = wins.map((w) => ({ polys: tf(w.polygon) }));
  const pts = R.flatMap((r) => r.polys.flat(2)).concat(W.flatMap((w) => w.polys.flat(2)));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const k = 40, pad = 20;
  const width = Math.max((maxX - minX) * k + pad * 2, pad + 5 * k + 48);
  const height = (maxY - minY) * k + pad * 2 + 28;
  const P = (p) => (pad + (p[0] - minX) * k).toFixed(1) + " " + (pad + (maxY - p[1]) * k).toFixed(1);
  const path = (polys) => polys.map((poly) => poly.map((ring) => "M" + ring.map(P).join("L") + "Z").join("")).join("");
  const areas = new Map(((plan && plan.adjacency_graph && plan.adjacency_graph.nodes) || []).map((n) => [n.id, n.area]));
  let svg = "";
  for (const r of R) svg += '<path class="room r-' + colourClass(r.type) + '" d="' + path(r.polys) + '"/>';
  for (const d of D) svg += '<path class="' + (d.type === "entrance_door" ? "entrance" : "door") + '" d="' + path(d.polys) + '"/>';
  for (const w of W) svg += '<path class="window" d="' + path(w.polys) + '"/>';
  if (labels) {
    for (const r of R) {
      const biggest = r.polys.slice().sort((a, b) => Math.abs(ringArea(b[0])) - Math.abs(ringArea(a[0])))[0];
      if (Math.abs(ringArea(biggest[0])) < 4) continue;
      const c = P(centroid(biggest[0])).split(" ");
      svg += '<text x="' + c[0] + '" y="' + (c[1] - 2) + '" class="lbl">' + esc(r.type.replace(/_/g, " ")) + "</text>";
      if (areas.get(r.id)) svg += '<text x="' + c[0] + '" y="' + (+c[1] + 12) + '" class="area">' + esc(areas.get(r.id)) + " m²</text>";
    }
    const barY = height - 12;
    svg += '<path class="scale" d="M' + pad + " " + barY + "h" + 5 * k + '"/><text x="' + (pad + 5 * k + 6) + '" y="' + (barY + 4) + '" class="area" style="text-anchor:start">5 m</text>';
  }
  return '<svg viewBox="0 0 ' + width.toFixed(0) + " " + height.toFixed(0) + '" role="img" aria-label="Floor plan ' + esc((plan && plan.plan_id) || v.plan_id) + '">' + svg + "</svg>";
}

/* ---------------------------------------------------------------- x402 payment (EIP-3009, "exact" scheme) */

/** Parse the PAYMENT-REQUIRED header (base64 JSON) of a 402 response. */
export function parseChallenge(header) {
  const json = typeof atob === "function" ? atob(header) : Buffer.from(header, "base64").toString("utf8");
  return JSON.parse(json);
}

const hex32 = (bytes) => "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The EIP-3009 authorisation the payer signs: pay `amount` USDC to the seller within the timeout. */
export function makeAuthorization(accepted, from, nowSec, nonceBytes) {
  return {
    from,
    to: accepted.payTo,
    value: String(accepted.amount),
    validAfter: "0",
    validBefore: String(nowSec + Number(accepted.maxTimeoutSeconds || 60)),
    nonce: hex32(nonceBytes),
  };
}

/** Typed data for eth_signTypedData_v4 (the USDC contract's own EIP-712 domain). */
export function paymentTypedData(accepted, authorization) {
  const extra = accepted.extra || {};
  return {
    domain: { name: extra.name, version: extra.version, chainId: Number(String(accepted.network).split(":")[1]), verifyingContract: accepted.asset },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  };
}

/** The payment object a server accepts in the PAYMENT-SIGNATURE header (after base64 JSON encoding). */
export function buildPayment(challenge, accepted, authorization, signature) {
  const payment = {
    x402Version: challenge.x402Version,
    payload: { authorization, signature },
    resource: challenge.resource,
    accepted,
  };
  if (challenge.extensions) payment.extensions = challenge.extensions;
  return payment;
}

export const encodePayment = (payment) => (typeof btoa === "function" ? btoa(JSON.stringify(payment)) : Buffer.from(JSON.stringify(payment)).toString("base64"));

const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** A browser wallet (MetaMask, Coinbase Wallet, Rabby...): window.ethereum. */
export function browserWallet(ethereum) {
  return {
    async connect() {
      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      if (!accounts || !accounts[0]) throw new Error("No account was shared by the wallet");
      return accounts[0];
    },
    async ensureChain(chainId) {
      const current = parseInt(await ethereum.request({ method: "eth_chainId" }), 16);
      if (current === chainId) return;
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + chainId.toString(16) }] });
    },
    async signTypedData(from, td) {
      const data = { types: { EIP712Domain: EIP712_DOMAIN, ...td.types }, domain: td.domain, primaryType: td.primaryType, message: td.message };
      return ethereum.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(data)] });
    },
  };
}

/**
 * Fetch a paid URL. With an API key: send it. Otherwise: if the server answers 402, sign the payment with the
 * wallet and retry. `maxUsd` refuses any price above it, so a misbehaving server can't ask for more.
 */
export async function fetchPaid(url, { apiKey, wallet, network, maxUsd = 0.5, onStatus = () => {}, now = () => Math.floor(Date.now() / 1000), random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  if (apiKey) return fetch(url, { headers: { "X-API-Key": apiKey } });
  const first = await fetch(url);
  if (first.status !== 402) return first;
  if (!wallet) throw new Error("Payment needed: connect a wallet or enter an API key");
  const header = first.headers.get("payment-required");
  if (!header) throw new Error("The server asked for payment but sent no terms");
  const challenge = parseChallenge(header);
  const accepted = (challenge.accepts || []).find((a) => a.scheme === "exact" && a.network === network);
  if (!accepted) throw new Error("This server doesn't accept USDC on " + network);
  const usd = Number(accepted.amount) / 1e6;
  if (usd > maxUsd) throw new Error("Price $" + usd + " is above the $" + maxUsd + " limit; nothing was signed");
  onStatus("Connecting wallet…");
  const from = await wallet.connect();
  await wallet.ensureChain(Number(network.split(":")[1]));
  onStatus("Confirm the $" + usd.toFixed(2) + " payment in your wallet…");
  const authorization = makeAuthorization(accepted, from, now(), random(32));
  const signature = await wallet.signTypedData(from, paymentTypedData(accepted, authorization));
  onStatus("Paying…");
  return fetch(url, { headers: { "PAYMENT-SIGNATURE": encodePayment(buildPayment(challenge, accepted, authorization, signature)) } });
}

/* ---------------------------------------------------------------- page */

function startUi() {
  const $ = (s, el = document) => el.querySelector(s);
  const cfg = JSON.parse($("#cfg").textContent);
  const api = cfg.api;
  const fmt = (n) => Number(n).toLocaleString("en-US");

  const state = { sample: [], vectors: new Map(), type: "all", last: [] };

  /* ---- free sample ---- */
  const grid = $("#grid");
  const chips = $("#chips");
  const typeLabel = (t) => (t || "residential").replace(/_/g, " ");

  async function vectorOf(id, base = api + "/api/v1/sample/") {
    if (!state.vectors.has(id)) state.vectors.set(id, fetch(base + id + "/vector").then((r) => r.json()));
    return state.vectors.get(id);
  }

  function drawGrid() {
    const list = state.sample.filter((p) => state.type === "all" || (p.building_type || "residential") === state.type);
    grid.innerHTML = list.map((p) =>
      '<button class="tile card plan" data-id="' + esc(p.plan_id) + '" aria-label="Open ' + esc(p.plan_id) + '"><div class="thumb" data-thumb="' + esc(p.plan_id) + '"></div>' +
      "<strong>" + esc(typeLabel(p.building_type)) + "</strong><span>" + summary(p) + "</span></button>").join("");
    for (const p of list) vectorOf(p.plan_id).then((v) => { const el = grid.querySelector('[data-thumb="' + p.plan_id + '"]'); if (el) el.innerHTML = planSvg(v, p, { labels: false }); });
  }

  function summary(p) {
    const g = p.adjacency_graph || {};
    const where = g.source_ids && g.source_ids.venue_name ? esc(g.source_ids.venue_name) + (g.level_name ? " " + esc(g.level_name) : "") : esc(p.plan_id);
    const beds = p.bedrooms > 0 ? p.bedrooms + " bed · " : "";
    return esc(beds) + esc(p.total_area_m2) + " m²<br>" + where;
  }

  function drawChips() {
    const types = ["all", ...new Set(state.sample.map((p) => p.building_type || "residential"))];
    chips.innerHTML = types.map((t) => '<button type="button" class="chip" aria-pressed="' + (t === state.type) + '" data-type="' + esc(t) + '">' + esc(typeLabel(t === "all" ? "all types" : t)) + "</button>").join("");
  }
  chips.addEventListener("click", (e) => { const b = e.target.closest("[data-type]"); if (!b) return; state.type = b.dataset.type; drawChips(); drawGrid(); });

  /* ---- detail dialog ---- */
  const dlg = $("#detail");
  async function openDetail(plan, { free, vector }) {
    const v = vector || (await vectorOf(plan.plan_id));
    $("#d-title").textContent = typeLabel(plan.building_type) + " · " + plan.plan_id;
    $("#d-meta").innerHTML = summary(plan);
    $("#d-plan").innerHTML = planSvg(v, plan);
    const record = JSON.stringify(plan, null, 2);
    const geometry = JSON.stringify(v, null, 2);
    $("#d-record").textContent = record;
    $("#d-geometry").textContent = geometry;
    const base = free ? api + "/api/v1/sample" : api + "/api/v1/plans";
    $("#d-curl").textContent = free
      ? "curl " + api + "/api/v1/sample/" + plan.plan_id + "/vector\n\n# the same plan from the paid API (the sample is free; the full catalogue is $" + cfg.vectorPrice + " per plan):\ncurl -i " + api + "/api/v1/plans/" + plan.plan_id + "/vector   # answers 402 with the price"
      : "curl -H 'X-API-Key: YOUR_KEY' " + api + "/api/v1/plans/" + plan.plan_id + "/vector";
    for (const [id, text, name] of [["#d-dl-record", record, plan.plan_id + ".record.json"], ["#d-dl-geometry", geometry, plan.plan_id + ".geometry.json"]]) {
      const a = $(id);
      if (a.dataset.url) URL.revokeObjectURL(a.dataset.url);
      a.dataset.url = a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = name;
    }
    $("#d-source").innerHTML = plan.provenance ? "<strong>" + esc(plan.provenance.license) + "</strong> · " + esc((plan.provenance.attribution || "").slice(0, 220)) : "";
    if (!dlg.open) dlg.showModal();
  }
  grid.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-id]");
    if (!b) return;
    const plan = state.sample.find((p) => p.plan_id === b.dataset.id);
    openDetail(plan, { free: true });
  });
  $("#d-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  for (const tab of document.querySelectorAll("[data-tab]")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll("[data-tab]")) t.setAttribute("aria-selected", t === tab);
      for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== tab.dataset.tab;
    });
  }

  /* ---- live count + paid search ---- */
  const form = $("#q");
  const countEl = $("#count");
  const resultsEl = $("#results");
  const statusEl = $("#status");
  const keyEl = $("#apikey");
  // The API key lives in this page view only; it is never written to browser storage (SEC-10).
  keyEl.value = "";

  function queryString() {
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (String(v).trim() !== "") q.set(k, String(v).trim());
    return q;
  }
  let timer;
  async function updateCount() {
    const q = queryString();
    countEl.textContent = "Counting…";
    try {
      const res = await fetch(api + "/api/v1/count?" + q);
      const body = await res.json();
      if (!res.ok) { countEl.textContent = (body.details || [body.error]).join(", "); return; }
      countEl.innerHTML = "<strong>" + fmt(body.count) + "</strong> plans match. A search returns up to <strong>" + fmt(body.search_returns) + "</strong> for <strong>$" + esc(cfg.price) + "</strong>" +
        (body.searches_to_read_all > 1 ? " (" + fmt(body.searches_to_read_all) + " searches to read them all)." : ".");
    } catch { countEl.textContent = "Couldn't reach the server."; }
  }
  form.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(updateCount, 350); });

  const walletAvailable = typeof window.ethereum !== "undefined";
  const wallet = walletAvailable ? browserWallet(window.ethereum) : null;
  $("#pay-note").textContent = walletAvailable
    ? "Pays from your browser wallet in USDC on " + cfg.networkName + ". Or paste an API key."
    : "No browser wallet detected. Use an API key, or pay from code with any x402 client.";

  function receiptLink(res) {
    const h = res.headers.get("payment-response");
    if (!h) return "";
    try { const r = JSON.parse(atob(h)); return r.transaction ? ' · <a href="' + cfg.txUrl + esc(r.transaction) + '" target="_blank" rel="noopener">transaction</a>' : ""; } catch { return ""; }
  }
  const remaining = (res) => { const c = res.headers.get("x-archibase-credits-remaining"); return c ? " · credits left: $" + esc(c) : ""; };

  async function paid(url, label) {
    statusEl.textContent = "";
    try {
      const res = await fetchPaid(url, { apiKey: keyEl.value.trim(), wallet, network: cfg.network, onStatus: (t) => (statusEl.textContent = t) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error === "insufficient_credits" ? "Not enough credits on this key. Contact us to top it up" : body.error === "invalid_api_key" ? "That API key isn't valid" : (body.error || "HTTP " + res.status) + (res.status === 402 ? ": payment wasn't accepted, nothing was charged" : ""));
      statusEl.innerHTML = esc(label) + " paid" + receiptLink(res) + remaining(res);
      return body;
    } catch (err) {
      statusEl.textContent = err && err.code === 4001 ? "Cancelled in the wallet. Nothing was charged." : (err && err.message) || String(err);
      return null;
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = queryString();
    q.set("limit", q.get("limit") || "10");
    const body = await paid(api + "/api/v1/plans/search?" + q, "Search");
    if (!body) return;
    state.last = body.results;
    resultsEl.innerHTML = body.results.length
      ? '<div class="card" style="padding:0 6px;overflow-x:auto"><table><thead><tr><th>Plan</th><th>Type</th><th class="num">m²</th><th class="num">Spaces</th><th></th></tr></thead><tbody>' +
        body.results.map((p, i) => "<tr><td><code>" + esc(p.plan_id) + "</code></td><td>" + esc(typeLabel(p.building_type)) + '</td><td class="num">' + esc(p.total_area_m2) + '</td><td class="num">' + p.adjacency_graph.nodes.length + "</td><td>" +
          (p.vector_schema_url ? '<button type="button" class="btn small" data-buy="' + i + '">Geometry · $' + esc(cfg.vectorPrice) + "</button> " : "") + '<button type="button" class="btn small ghost" data-rec="' + i + '">Record</button></td></tr>').join("") +
        "</tbody></table></div>" +
        '<p><a id="dl-all" class="btn small ghost" download="archibase-search.json">Download results (JSON)</a></p>'
      : "<p>No plans match.</p>";
    const dl = $("#dl-all");
    if (dl) dl.href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  });
  resultsEl.addEventListener("click", async (e) => {
    const buy = e.target.closest("[data-buy]");
    const rec = e.target.closest("[data-rec]");
    if (buy) {
      const plan = state.last[Number(buy.dataset.buy)];
      const v = await paid(plan.vector_schema_url, "Geometry");
      if (v) openDetail(plan, { free: false, vector: v });
    } else if (rec) {
      const plan = state.last[Number(rec.dataset.rec)];
      const dummy = { rooms: [], doors: [], windows: [] };
      $("#d-title").textContent = plan.plan_id;
      $("#d-plan").innerHTML = "<p>Buy the geometry to draw this plan.</p>";
      $("#d-record").textContent = JSON.stringify(plan, null, 2);
      $("#d-geometry").textContent = "(not bought)";
      $("#d-meta").innerHTML = summary(plan);
      $("#d-source").textContent = "";
      if (!dlg.open) dlg.showModal();
      void dummy;
    }
  });

  /* ---- start ---- */
  fetch(api + "/api/v1/sample").then((r) => r.json()).then((body) => {
    state.sample = body.results;
    drawChips();
    drawGrid();
  });
  updateCount();
}

if (typeof document !== "undefined" && document.getElementById("cfg")) startUi();
