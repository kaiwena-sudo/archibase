/**
 * Testnet wallet helper for taking a first real x402 payment on Base Sepolia.
 *
 *   npm run wallet -- new <name> [--purpose payee|buyer]   create a Base Sepolia wallet (key stays in .wallets/)
 *   npm run wallet -- list                                  names + addresses (never keys)
 *   npm run wallet -- balance <name|address>                USDC + ETH on Base Sepolia
 *   npm run wallet -- env <payee> [--buyer <buyer>]         .env lines for the server (no keys)
 *   npm run wallet -- pay <buyer> [query]                   run scripts/pay.ts as that buyer
 *   npm run wallet -- check-address <0x...>                 validate any address (mainnet too)
 *
 * Keys live in .wallets/<name>.json (dir 0700, files 0600, git-ignored) and are never
 * printed. This tool only creates TESTNET keys. To receive real money on Base mainnet, use
 * a wallet you control (hardware wallet, Coinbase Wallet, a Safe) and put only its address
 * in WALLET_ADDRESS.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPublicClient, erc20Abi, formatUnits, getAddress, http, isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const TESTNET = "eip155:84532"; // Base Sepolia
export const RPC_URL = "https://sepolia.base.org";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ZERO = /^0x0{40}$/i;

export type Purpose = "payee" | "buyer";

export interface StoredWallet {
  name: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  network: string;
  createdAt: string;
  purpose: Purpose;
}

export class WalletError extends Error {}

export const walletsDir = (env: NodeJS.ProcessEnv = process.env) => resolve(env.WALLETS_DIR ?? ".wallets");

async function readWallet(dir: string, name: string): Promise<StoredWallet> {
  if (!NAME.test(name)) throw new WalletError(`invalid wallet name "${name}"`);
  try {
    return JSON.parse(await readFile(join(dir, `${name}.json`), "utf8")) as StoredWallet;
  } catch {
    throw new WalletError(`no wallet named "${name}" in ${dir} (see: npm run wallet -- list)`);
  }
}

/** Create a Base Sepolia wallet. Returns the public part only. */
export async function newWallet(
  dir: string,
  name: string,
  opts: { purpose?: string; network?: string } = {},
): Promise<{ name: string; address: string; purpose: Purpose; file: string }> {
  const network = opts.network ?? TESTNET;
  if (network !== TESTNET) {
    throw new WalletError(
      `refusing to generate a key for ${network}: this tool only makes testnet (${TESTNET}) keys. ` +
        "To receive real money, use a wallet you control (hardware wallet, Coinbase Wallet, a Safe) " +
        "and set WALLET_ADDRESS to its address. Check it with: npm run wallet -- check-address <0x...>",
    );
  }
  if (!NAME.test(name)) throw new WalletError(`wallet name must be lowercase letters, digits and hyphens (got "${name}")`);
  const purpose = (opts.purpose ?? "payee") as Purpose;
  if (purpose !== "payee" && purpose !== "buyer") throw new WalletError(`--purpose must be payee or buyer`);

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  const record: StoredWallet = { name, address, privateKey, network, createdAt: new Date().toISOString(), purpose };
  const file = join(dir, `${name}.json`);
  try {
    // "wx": never overwrite an existing key.
    await writeFile(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new WalletError(`a wallet named "${name}" already exists`);
    throw err;
  }
  await chmod(file, 0o600);
  return { name, address, purpose, file };
}

export async function listWallets(dir: string): Promise<{ name: string; address: string; purpose: string; network: string }[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    const w = JSON.parse(await readFile(join(dir, f), "utf8")) as StoredWallet;
    out.push({ name: w.name, address: w.address, purpose: w.purpose, network: w.network });
  }
  return out;
}

/** Format checks only (no network). */
export function checkAddressFormat(input: string): { ok: true; address: `0x${string}`; note?: string } | { ok: false; reason: string } {
  if (!isAddress(input, { strict: false })) return { ok: false, reason: "not a 0x-prefixed 20-byte hex address" };
  if (ZERO.test(input)) return { ok: false, reason: "this is the zero address; funds sent there are unrecoverable" };
  const checksummed = getAddress(input);
  const mixedCase = input !== input.toLowerCase() && input !== input.toUpperCase().replace("0X", "0x");
  if (mixedCase && input !== checksummed) return { ok: false, reason: `checksum mismatch (expected ${checksummed}); possible typo` };
  return { ok: true, address: checksummed, ...(!mixedCase && { note: "no checksum to verify (all one case)" }) };
}

const client = () => createPublicClient({ chain: baseSepolia, transport: http(RPC_URL, { timeout: 10_000, retryCount: 0 }) });

function rpcUnreachable(err: unknown): never {
  throw new WalletError(
    `could not reach ${new URL(RPC_URL).host} (${(err as Error).message.split("\n")[0]}). ` +
      "If you are in a sandbox with a network allowlist, allow that host and retry.",
  );
}

export function envLines(payee: StoredWallet | { address: string }): string[] {
  return [`WALLET_ADDRESS=${payee.address}`, `X402_NETWORK=${TESTNET}`, "FACILITATOR_URL=https://x402.org/facilitator"];
}

async function resolveAddress(dir: string, nameOrAddress: string): Promise<`0x${string}`> {
  if (nameOrAddress.startsWith("0x")) {
    const c = checkAddressFormat(nameOrAddress);
    if (!c.ok) throw new WalletError(c.reason);
    return c.address;
  }
  return (await readWallet(dir, nameOrAddress)).address;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (k: string) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1]!.startsWith("--")));
  const dir = walletsDir();

  switch (cmd) {
    case "new": {
      const name = positional[0];
      if (!name) throw new WalletError("usage: new <name> [--purpose payee|buyer]");
      const network = rest.includes("--mainnet") ? "eip155:8453" : flag("--network");
      const w = await newWallet(dir, name, { purpose: flag("--purpose"), network });
      console.log(`Created ${w.purpose} wallet "${w.name}" on Base Sepolia (${TESTNET})`);
      console.log(`  address: ${w.address}`);
      console.log(`  key:     stored in ${w.file} (mode 0600, git-ignored; never printed)`);
      console.log("");
      if (w.purpose === "payee") {
        console.log("Next: put these in .env so the server is paid to this wallet:");
        for (const l of envLines(w)) console.log(`  ${l}`);
      } else {
        console.log("Next: fund it with test USDC at https://faucet.circle.com (choose Base Sepolia, paste the address).");
        console.log("  No ETH needed: x402 'exact' payments are EIP-3009 signatures; the facilitator submits them and pays gas.");
        console.log(`  Then, with the server running:  npm run wallet -- pay ${w.name} "?bedrooms=2"`);
      }
      return 0;
    }
    case "list": {
      const ws = await listWallets(dir);
      if (!ws.length) console.log(`no wallets in ${dir}`);
      for (const w of ws) console.log(`${w.name.padEnd(24)} ${w.address}  ${w.purpose}  ${w.network}`);
      return 0;
    }
    case "balance": {
      const target = positional[0];
      if (!target) throw new WalletError("usage: balance <name|address>");
      const address = await resolveAddress(dir, target);
      const c = client();
      const [eth, usdc] = await Promise.all([
        c.getBalance({ address }),
        c.readContract({ address: USDC_BASE_SEPOLIA, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      ]).catch(rpcUnreachable);
      console.log(`${address} on Base Sepolia`);
      console.log(`  USDC: ${formatUnits(usdc, 6)}`);
      console.log(`  ETH:  ${formatUnits(eth, 18)}`);
      return 0;
    }
    case "env": {
      const payeeName = positional[0];
      if (!payeeName) throw new WalletError("usage: env <payee-name> [--buyer <buyer-name>]");
      const payee = await readWallet(dir, payeeName);
      console.log("# .env for the server (Base Sepolia)");
      for (const l of envLines(payee)) console.log(l);
      const buyerName = flag("--buyer");
      if (buyerName) {
        const buyer = await readWallet(dir, buyerName);
        console.log("");
        console.log(`# test buyer ${buyer.name} (${buyer.address}); its key is never written to .env. Pay with:`);
        console.log(`#   npm run wallet -- pay ${buyer.name} "?bedrooms=2"`);
      }
      return 0;
    }
    case "pay": {
      const buyerName = positional[0];
      if (!buyerName) throw new WalletError('usage: pay <buyer-name> ["?query"]');
      const buyer = await readWallet(dir, buyerName);
      if (buyer.network !== TESTNET) throw new WalletError(`${buyer.name} is not a testnet wallet`);
      const query = positional[1] ?? "?bedrooms=2";
      const base = process.env.API_URL ?? "http://localhost:3000";
      console.log(`Paying as ${buyer.name} (${buyer.address}) for ${query.startsWith("/") ? base + query : `${base}/api/v1/plans/search${query}`}`);
      // The key goes only into the child's environment, never onto a command line or stdout.
      const child = spawn("npm", ["run", "-s", "pay", "--", query], {
        stdio: "inherit",
        env: { ...process.env, BUYER_PRIVATE_KEY: buyer.privateKey },
      });
      return await new Promise((res) => child.on("exit", (code) => res(code ?? 1)));
    }
    case "check-address": {
      const input = positional[0];
      if (!input) throw new WalletError("usage: check-address <0x...>");
      const c = checkAddressFormat(input);
      if (!c.ok) {
        console.log(`✗ ${c.reason}`);
        return 1;
      }
      console.log(`✓ valid address ${c.address}${c.note ? ` (${c.note})` : ""}`);
      try {
        const code = await client().getCode({ address: c.address });
        console.log(code && code !== "0x" ? "  contract on Base Sepolia (e.g. a Safe): fine as a payee" : "  plain account (EOA) on Base Sepolia");
      } catch {
        console.log(`  (could not reach ${new URL(RPC_URL).host} to check contract vs. account)`);
      }
      return 0;
    }
    default:
      console.log("usage: npm run wallet -- <new|list|balance|env|pay|check-address> ...  (see scripts/wallet.ts)");
      return cmd ? 1 : 0;
  }
}

if (process.argv[1]?.endsWith("wallet.ts")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof WalletError ? `error: ${err.message}` : err);
      process.exit(1);
    });
}
