/**
 * Browser test of /explore against the in-process app (mock facilitator) with a fake wallet that signs
 * like MetaMask. Needs Playwright's Chromium (present in cloud sessions).
 *
 *   npx tsx scripts/e2e-explore.ts [screenshot-dir]
 */
import { createRequire } from "node:module";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { makeApp } from "../tests/helpers.js";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const outDir = process.argv[2];
const account = privateKeyToAccount(generatePrivateKey());
const app = makeApp();
const ORIGIN = "http://test.local";
let failures = 0;
const check = (ok: boolean, what: string) => { console.log(ok ? "  ok " : "  FAIL", what); if (!ok) failures++; };

const browser = await chromium.launch();
for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  console.log(name);
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/status of 402/.test(m.text()) && errors.push(m.text())); // 402 is the expected first step of x402

  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const res = await app.request(req.url(), { method: req.method(), headers: req.headers() });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
  const signed: unknown[] = [];
  await page.exposeFunction("__sign", async (json: string) => {
    const d = JSON.parse(json);
    signed.push(d);
    const { EIP712Domain: _omit, ...types } = d.types;
    return account.signTypedData({ domain: d.domain, types, primaryType: d.primaryType, message: { ...d.message, value: BigInt(d.message.value), validAfter: BigInt(d.message.validAfter), validBefore: BigInt(d.message.validBefore) } } as any);
  });
  // A string, not a function: the TypeScript runner rewrites functions in a way that breaks when sent to a page.
  await page.addInitScript(`window.ethereum = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts") return [${JSON.stringify(account.address)}];
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_signTypedData_v4") return window.__sign(params[1]);
      throw new Error("unexpected " + method);
    },
  };`);

  await page.goto(`${ORIGIN}/explore`);
  await page.waitForSelector("#grid .tile");
  const nTiles = (await page.locator("#grid .tile").count());
  check(nTiles >= 18, `${nTiles} sample tiles`);
  await page.waitForFunction((n) => document.querySelectorAll("#grid .thumb svg").length === n, nTiles, { timeout: 15000 });
  check(true, "all thumbnails drawn");
  const chipCount = await page.locator("#chips .chip").count();
  check(chipCount > 5, `type chips (${chipCount})`);

  await page.locator('#chips [data-type="industrial"]').click();
  const industrial = await page.locator("#grid .tile").count();
  check(industrial > 0 && industrial < nTiles, `industrial filter shows ${industrial}`);
  await page.locator('#chips [data-type="all"]').click();

  await page.locator("#grid .tile").first().click();
  await page.waitForSelector("#detail[open] #d-plan svg");
  check((await page.locator("#d-record").textContent())!.includes('"plan_id"'), "detail shows the record JSON");
  check((await page.locator("#d-plan svg path.room").count()) > 3, "detail draws the rooms");
  if (outDir) await page.screenshot({ path: `${outDir}/explore-detail-${name}.png` });
  const href = await page.locator("#d-dl-geometry").getAttribute("href");
  check(!!href && href.startsWith("blob:"), "download link is a blob");
  await page.locator("#d-close").click();

  await page.waitForFunction(() => /plans match/.test(document.getElementById("count")!.textContent || ""));
  const before = await page.locator("#count").textContent();
  await page.locator('#q [name="bedrooms"]').fill("3");
  await page.waitForFunction((b) => /plans match/.test(document.getElementById("count")!.textContent || "") && document.getElementById("count")!.textContent !== b, before, { timeout: 10000 });
  const countText = (await page.locator("#count").textContent())!;
  check(/^2 plans match.*\$0\.02/.test(countText), `live count updates with the filter: "${countText}"`);

  check((await page.locator("#pay-note").textContent())!.startsWith("Pays from your browser wallet"), "wallet detected");
  await page.locator('button[type="submit"][form="q"]').click();
  await page.waitForSelector("#results table tbody tr", { timeout: 8000 }).catch(async () => {
    console.log("  status text:", JSON.stringify(await page.locator("#status").textContent()), "| errors:", errors, "| signed:", signed.length);
    throw new Error("search results never appeared");
  });
  check(signed.length === 1, "wallet was asked to sign exactly once");
  check(/paid/.test((await page.locator("#status").textContent())!), `status: "${await page.locator("#status").textContent()}"`);
  const rows = await page.locator("#results tbody tr").count();
  check(rows > 0, `${rows} result rows`);

  await page.locator("#results [data-buy]").first().click();
  await page.waitForSelector("#detail[open] #d-plan svg", { timeout: 15000 });
  check(signed.length === 2, "geometry purchase signed a second payment");
  if (outDir) await page.screenshot({ path: `${outDir}/explore-bought-${name}.png` });
  await page.locator("#d-close").click();

  if (outDir) await page.screenshot({ path: `${outDir}/explore-${name}.png`, fullPage: true });
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "no horizontal scroll");
  check(errors.length === 0, "no browser errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await ctx.close();
}
await browser.close();
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
