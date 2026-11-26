import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAddressFormat, listWallets, newWallet, WalletError } from "../scripts/wallet.js";

const tmp = () => mkdtemp(join(tmpdir(), "archibase-wallets-"));

/** Run the CLI as a user would, with no network, and capture all output. */
function cli(dir: string, ...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", "scripts/wallet.ts", ...args], {
      env: { ...process.env, WALLETS_DIR: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

describe("wallet helper", () => {
  it("new writes a 0600 key file in a 0700 dir and returns only public data", async () => {
    const dir = await tmp();
    const w = await newWallet(dir, "payee-1", { purpose: "payee" });
    expect(w).not.toHaveProperty("privateKey");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(w.file)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(w.file, "utf8"));
    expect(stored).toMatchObject({ name: "payee-1", address: w.address, network: "eip155:84532", purpose: "payee" });
    expect(stored.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("never prints the private key (new, list, env)", async () => {
    const dir = await tmp();
    const created = cli(dir, "new", "buyer-1", "--purpose", "buyer");
    expect(created.code).toBe(0);
    cli(dir, "new", "payee-1");
    const keys = await Promise.all(
      ["buyer-1", "payee-1"].map(async (n) => JSON.parse(await readFile(join(dir, `${n}.json`), "utf8")).privateKey as string),
    );
    const outputs = [created.out, cli(dir, "list").out, cli(dir, "env", "payee-1", "--buyer", "buyer-1").out].join("\n");
    for (const k of keys) {
      expect(outputs).not.toContain(k);
      expect(outputs).not.toContain(k.slice(2));
    }
    expect(outputs).toContain("WALLET_ADDRESS=0x");
  }, 30_000);

  it("refuses to create mainnet keys", async () => {
    const dir = await tmp();
    await expect(newWallet(dir, "real", { network: "eip155:8453" })).rejects.toThrow(WalletError);
    const r = cli(dir, "new", "real", "--mainnet");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/refusing.*testnet/);
    expect(await listWallets(dir)).toEqual([]);
  });

  it("refuses to overwrite an existing wallet", async () => {
    const dir = await tmp();
    await newWallet(dir, "w1");
    await expect(newWallet(dir, "w1")).rejects.toThrow(/already exists/);
  });

  it("list shows names and addresses only", async () => {
    const dir = await tmp();
    const a = await newWallet(dir, "a-wallet", { purpose: "buyer" });
    const list = await listWallets(dir);
    expect(list).toEqual([{ name: "a-wallet", address: a.address, purpose: "buyer", network: "eip155:84532" }]);
    expect(JSON.stringify(list)).not.toMatch(/privateKey/);
  });

  it("check-address validates format and checksum and rejects the zero address", () => {
    expect(checkAddressFormat("0x0000000000000000000000000000000000000001")).toEqual({
      ok: true,
      address: "0x0000000000000000000000000000000000000001",
    });
    // EIP-55 example with one checksum character deliberately changed.
    expect(checkAddressFormat("0x5Aeda56215b167893e80B4fE645BA6d5Bab767DE")).toMatchObject({ ok: false, reason: /checksum/ });
    expect(checkAddressFormat("0x" + "0".repeat(40))).toMatchObject({ ok: false, reason: /zero address/ });
    expect(checkAddressFormat("0x1234")).toMatchObject({ ok: false });
    expect(checkAddressFormat("hello")).toMatchObject({ ok: false });
  });

  it("rejects bad names and purposes", async () => {
    const dir = await tmp();
    await expect(newWallet(dir, "../escape")).rejects.toThrow(/name/);
    await expect(newWallet(dir, "ok", { purpose: "admin" })).rejects.toThrow(/purpose/);
  });
});
