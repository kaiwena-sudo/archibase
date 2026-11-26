# Self-hosting and operations

Run the API yourself, load data, set up payments and deploy to Cloudflare Workers.

## Code layout

```
src/index.ts            routes, query validation, discovery document, server entry
src/middleware/x402.ts  x402 gateway: config, facilitator client, X-PAYMENT alias, JSON 402 body, dev mock facilitator
src/db/client.ts        PlanStore: JSON file (default) or Supabase PostgREST
src/db/vectors.ts       VectorStore: geometry files (default data/vectors) or an https bucket
src/db/validate.ts      record + rights validation used by the seed script
src/units.ts            metric storage, imperial presentation
db/schema.sql           Supabase table + RLS policy
scripts/demo.ts         end-to-end walkthrough (simulated payment)
scripts/pay.ts          real paying client (signed EIP-3009 USDC, Base Sepolia)
```

## Setup

```bash
npm install
cp .env.example .env      # set WALLET_ADDRESS at minimum
npm run dev               # tsx watch; or: npm run build && npm start
```

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `WALLET_ADDRESS` | (required) | Receives USDC |
| `X402_NETWORK` | `eip155:84532` | Base Sepolia. Set `eip155:8453` for Base mainnet |
| `PRICE_USD` | `0.02` | Search price; converted to USDC atomic units (`20000`) |
| `VECTOR_PRICE_USD` | `0.10` | Price of one plan's geometry |
| `VECTOR_STORE_URL` | `file:data/vectors` | `file:<dir>`, `https://<bucket>` (with `index.json`), or `none`. Workers default to `none` |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | `mock` = local dev stub. Refused when `NODE_ENV=production`, and on mainnet unless `ALLOW_MOCK_FACILITATOR=true` |
| `FACILITATOR_API_KEY` | (none) | Optional bearer token for the facilitator |
| `DATABASE_URL` | `file:data/plans.json` | or `https://<project>.supabase.co` (+ `SUPABASE_KEY`) |
| `PUBLIC_BASE_URL` | request origin | Used in discovery and `resource.url`. Required when `NODE_ENV=production` |

**Choosing a facilitator.** The public `x402.org` facilitator only settles on **Base Sepolia**. For Base mainnet (`eip155:8453`), point `FACILITATOR_URL` at a mainnet facilitator, such as Coinbase CDP. CDP authenticates with signed JWTs, so for CDP replace `createFacilitatorClient` in `src/middleware/x402.ts` with `new HTTPFacilitatorClient(facilitator)` from `@coinbase/x402`.

## Trying it

### Local, with simulated payments

```bash
FACILITATOR_URL=mock WALLET_ADDRESS=0xYourTestnetReceivingWallet npm run dev
npm run demo     # discovery → 402 → 400 → wrong-payee 402 → paid 200 with receipt
```

### curl

```bash

## Wallets

`scripts/wallet.ts` sets up the two wallets for a first real payment on **Base Sepolia (testnet)**: a payee that receives USDC, and a test buyer that pays.

```bash
npm run wallet -- new archibase-payee --purpose payee   # prints the .env lines for the server
npm run wallet -- new test-buyer --purpose buyer
npm run wallet -- list                                   # names + addresses
npm run wallet -- balance test-buyer                     # USDC + ETH (needs sepolia.base.org)
npm run wallet -- env archibase-payee --buyer test-buyer # .env lines, no keys
```

1. Get test USDC for the buyer at [faucet.circle.com](https://faucet.circle.com). Choose **Base Sepolia** and paste the buyer's address.
2. The buyer needs **no ETH**. x402 `exact` payments are EIP-3009 `transferWithAuthorization` signatures: the buyer only signs, and the facilitator submits the transaction and pays the gas.
3. Run the server with the `env` lines in `.env`, then pay: `npm run wallet -- pay test-buyer "?bedrooms=2"`. This runs `scripts/pay.ts` with the buyer's key injected into that process only.

Keys are stored in `.wallets/<name>.json` (directory 0700, files 0600, git-ignored) and are never printed. They exist only on the machine that created them, so back up anything you care about, or recreate the wallets locally.

**Mainnet:** the tool refuses to create mainnet keys. To receive real money, use a wallet you control (a hardware wallet, Coinbase Wallet, or a Safe) and set only its **address** as `WALLET_ADDRESS`. Check it first with `npm run wallet -- check-address <0x...>`, which validates the checksum, rejects the zero address, and reports whether it is a contract (e.g. a Safe) or a plain account. Mainnet also needs a mainnet facilitator; see [Setup](#setup).

## Supabase

Plans live in `floor_plans` and geometry in `floor_plan_vectors` (`db/schema.sql`, safe to re-run).

**Access model.** The data is the product, so neither table is readable with Supabase's public `anon` or `publishable` key. Row-level security is on, with no policies for `anon` or `authenticated`. The API reads with the project's **secret** key (`sb_secret_...`, or the legacy `service_role` key), which stays on the server. To check: as `anon` or `authenticated` both tables return "permission denied"; as `service_role` they're readable.

**Loading** uses the Management API with a personal access token (`sbp_...`, from Account preferences → Access Tokens), so no service key is needed:

```bash
export SUPABASE_PROJECT_REF=<ref> SUPABASE_ACCESS_TOKEN=sbp_...
npm run supabase:load -- incoming/plans.json --vectors incoming/vectors --exclude-source synthetic --dry-run   # validate only
npm run supabase:load -- incoming/plans.json --vectors incoming/vectors --exclude-source synthetic

## Deploy to Cloudflare Workers

The same app runs on Workers via `src/worker.ts`. The Worker requires your own Supabase catalogue; the production catalogue is not included here. `WALLET_ADDRESS`, `DATABASE_URL`, and `SUPABASE_KEY` must be configured as Worker secrets. Wrangler checks for them before deployment, and the Worker returns a configuration error if they are missing.

```bash

## Development

```bash
npm test              # vitest: unit + in-process HTTP/payment flow tests
npm run typecheck     # Node + Worker type-check
npm run typecheck:tests
```
CI (`.github/workflows/ci.yml`) runs type-check, tests and build on every push and PR.
