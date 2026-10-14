<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Where the documentation lives

This file is the entry point for agents: what the other documents don't say, plus where to find them.
Read the relevant one before changing that area — none of them are summaries of the code, they carry decisions the code can't show.

| Document | What it answers | Read it before |
|---|---|---|
| [`README.md`](README.md) | The product: features, wallets, networks, Blake2b/XBT, `.env` reference, desktop app, security model | Any change that touches user-visible behavior |
| [README → Security model](README.md#security-model) | What the backend refuses to sign and why | Touching `lib/server/sign-core.ts` or `lib/tx.ts` |
| [README → Blake2b (XBT)](README.md#blake2b-xbt) | Replay protection, `SIGHASH_UNIFIED`, OP_RETURN limits | Any cross-chain or consensus-rule work |
| [README → Configuration](README.md#configuration) + [`.env.example`](.env.example) | Every environment variable and its default | Adding config of any kind |
| [README → Desktop app](README.md#desktop-app) · [→ Releasing](README.md#releasing) | Tauri bundle, per-OS builds, release flow | Touching `src-tauri/` or `scripts/desktop.mjs` |
| [`docs/CLI.md`](docs/CLI.md) *(Spanish)* | The `gorila` CLI: every command, secrets handling, regtest, `forward` rules | Changing `lib/cli/**` or `scripts/gorila.ts` |
| [`prisma/schema.prisma`](prisma/schema.prisma) | The data model — every model carries a `///` comment explaining its role | Any database change |
| [`lib/chains.ts`](lib/chains.ts) | The chain registry and what each feature flag means | Adding a chain or a chain-specific rule |
| [`scripts/vectors/unified_sighash.json`](scripts/vectors/) | 166 reference vectors for `SIGHASH_UNIFIED` | Touching `lib/unified-sighash.ts` |

## Commands

```bash
nvm use                 # Node 24 (hard requirement, enforced by bin/gorila.mjs)
pnpm install            # also runs `prisma generate`
pnpm dev                # migrate + next dev on :3000
pnpm lint               # ESLint (the only linter; no Prettier config)
npx tsc --noEmit        # typecheck (no package script for it)
pnpm check              # unit suite
pnpm check:cli          # CLI + core suite (isolated SQLite, simulated Electrum/mempool)
pnpm check:cli:regtest  # end-to-end against Docker bitcoind + electrs (compose.regtest.yml)
```

### Production operations with real BTC

For user-requested production operations involving real BTC, prefer the installed `gorila` binary,
including balance queries, sends and transaction-status checks. It preserves the operational wrapper's
runtime and certificate configuration. Reserve `mise` and direct execution of `.js`, `.mjs` or `.ts`
files (including `node bin/gorila.mjs` and inline scripts) for code development and testing, not as the
default path for production wallet operations.

#### CLI operational checklist

- Read `docs/CLI.md` and use `gorila --help` to confirm current options before preparing an operation.
- Resolve wallet names with `gorila wallet list --json`; do not silently substitute a similarly named wallet.
  Query fresh BTC and XBT balances with `gorila balance --wallet NAME --chain all --json`; keep currencies separate.
- For BTC forwarding from the whole wallet, use `forward add --chain btc --from-wallet` with explicit
  `--wallet`, `--to`, `--every` (minutes), and `--max-fee-rate` (sat/vB). The CLI installs its own cron block.
- `--amount-sats` pays a fixed amount with the fee charged in addition; omitting it sweeps eligible funds minus
  the fee. `--balance-above-sats` is a strict eligible-wallet-balance trigger, not a retained reserve or an
  instruction to send only the excess. Keep amounts and fee limits specific to the user's current request.
- `--message` supplies the UTF-8 OP_RETURN text. `--min-conf` controls eligible confirmations (default: one).
- Encrypted wallets require `--password-file`. For the local workflow, use `--password-file pass.txt` when
  requested; it resolves against the caller's working directory, not the CLI checkout. The file must have
  permissions `600` and remain available for cron; never print or persist its contents in docs or memory.
- Preparing a command is not authorization to install a rule or send funds. Preserve the interactive
  confirmation unless the user explicitly requests unattended creation with `--yes`.
- Inspect rules with `gorila forward list` / `gorila forward show ID`; preview with
  `gorila forward run ID --dry-run`, which does not sign or broadcast.

### Running one check

There is no test framework and no per-test filter. The suites are plain `node:assert` scripts
run by `tsx --conditions=react-server` (that condition is what lets a script import `server-only` modules).
To run a single one:

```bash
DATABASE_URL=file:./data/check.db pnpm exec tsx --conditions=react-server scripts/check.ts
DATABASE_URL=file:/tmp/x.db pnpm exec prisma migrate deploy
DATABASE_URL=file:/tmp/x.db pnpm exec tsx --conditions=react-server scripts/check-wallet-core.ts
```

`scripts/check.ts` refuses to run unless `DATABASE_URL` contains `check.db` — never point a check at `data/wallet.db`.
`scripts/check-cli-all.mjs` orchestrates `check-cli-args`, `check-wallet-core`, `check-regtest-core`,
`check-sync-session`, `check-cli`, each against a throwaway database in `$TMPDIR`.
`scripts/check-cli-regtest.mjs` drives `scripts/regtest/*.mjs` (harness, scenarios, edges, interactive, forward)
and needs Docker; it prints `EVIDENCE_RECORDED: <dir>` with a `result.json`.

Running the suites on anything below Node 24 fails inside Prisma with
`Module did not self-register` / `ERR_DLOPEN_FAILED` on `better-sqlite3`. That is the Node version, not your change.

New non-trivial logic gets an assertion in the matching `scripts/check*.ts`, not a new framework.

## Architecture

### Chains are data, not branches

`lib/chains.ts` is the registry: address family, colors, default Electrum/mempool sources, and feature flags
(`unifiedSighash`, `maxDataScript`, `maxScript`, `noDataOutputs`, `replayPair`). Adding a chain is adding an entry to
`CHAINS` plus its id to `Chain`. **Never scatter `if (chain === "xbt")` through the code** — add a field to `ChainDef`
and read it. Chains of a `Family` (`main` / `test` / `regtest`) share keys; a wallet has one account per family
(`m/84'/<coinType>'/0'`).

### Three consumers, one core

`lib/` is shared by the browser, the API routes, and the CLI:

- `lib/tx.ts` — coin selection, fee policies (`feeAt`, `rbfFee`, `cpfpFee`), PSBT building, per-chain output rules.
  The browser builds the PSBT; the server re-validates everything with the same module.
- `lib/wallet.ts` — shared types (`WalletInfo`, `Snapshot`, `Utxo`, `Tx`, `StreamMessage`) and address derivation.
- `lib/server/**` — server-only (`import "server-only"` at the top of every file). Never import these from a client component.
- `lib/cli/**` + `scripts/gorila.ts` — the `gorila` binary, launched by `bin/gorila.mjs`
  (chdirs to the repo root, loads `.env` with Next's loader, applies pending migrations, then spawns tsx).
  Secret file paths resolve against `GORILA_CALLER_CWD`, SQLite paths against the repo root. Details in `docs/CLI.md`.

### Sync: one Electrum connection per chain

`lib/server/watcher.ts` is the engine. A `ChainClient` owns a single `Electrum` connection (`lib/server/electrum.ts`,
a hand-rolled JSON-RPC client with ordered failover) plus chain-wide caches (raw txs, block headers, fee estimates),
and routes scripthash notifications to the `WalletSync` instances that own them. The selected chain and its
`replayPair` sync together. Changing sources in Settings restarts the client (keyed by `ChainClient.key`).

`app/api/stream/route.ts` is the only live channel: one SSE connection, one NIP-98 signature, pushing wallet list,
settings and per-wallet/per-chain `Snapshot`s. `components/wallet-provider.tsx` consumes it and is the client-side
source of truth; switching wallets does not reconnect.

### Signing boundary

Keys never leave the server. `lib/server/sign-core.ts` is the trust boundary: it re-derives every input from the
wallet's own key, checks script/fingerprint/path **against the real parent transaction fetched from the chain**
(never against the PSBT's claims), rejects frozen coins and chain-rule violations, and caps fee rate at
`MAX_FEE_RATE`. `lib/server/signer.ts` only supplies the context (account, prevouts, frozen set).
Blake signs with `SIGHASH_UNIFIED` (`0x21`) from `lib/unified-sighash.ts`, verified against the vectors in
`scripts/vectors/`. Touching sign-core without extending `scripts/check.ts` is a no.

### Auth

Every API route starts with `await requireNostr(req, body?)` (`lib/server/auth.ts`) and returns the `Response` it
yields when non-null. Without `ALLOWED_PUBKEYS` there is no login at all: the app only answers requests addressed to
localhost, checking `Host` and `Origin`. With it, NIP-98 plus the allowlist, POST bodies bound to the signature via
the `payload` tag, and used event ids persisted in `AuthEvent` so a write can't be replayed.

### Persistence

Prisma + better-sqlite3 (WAL), schema in `prisma/schema.prisma`. The client is generated into **`lib/generated/prisma`**,
not `node_modules` — import `PrismaClient` / `Prisma` from `@/lib/generated/prisma/client`, and `db` from
`@/lib/server/db` (a global singleton). Amounts are satoshis as `BigInt`. The DB is a warm cache; Electrum stays the
source of truth. Migrations are additive and applied by `prisma migrate deploy` on `dev`, `start`, and every CLI call.

### Where secrets live

`.env` (gitignored) holds `SEED_PHRASE` and friends and is only ever read, never written — `lib/server/config.ts` is
getters over `process.env`. `data/wallet.db` (gitignored) holds everything else, including `Wallet.encSeed`: the BIP39
words sealed with scrypt N=2¹⁶ + AES-256-GCM (`lib/server/secret.ts`), or stored **in clear** (`kdf: "none"`) when the
wallet has no password. The desktop app keeps its database and `server.log` in the OS app-data folder instead.
`forward` rules write logs to `$XDG_STATE_HOME/gorila/` (mode 0700) and reference a `--password-file` that the CLI
refuses unless it is `chmod 600`.

## Conventions

- `@/*` resolves to the repo root (`@/lib/...`, `@/components/...`).
- No semicolons, double quotes in `.ts`/`.tsx`, single quotes in `.mjs` scripts, long lines are fine.
- Comments explain *why* (a consensus rule, a protocol constraint), not *what*. Match the existing density.
- `// ponytail:` comments mark deliberate shortcuts with their ceiling and upgrade path. Keep that format.
- UI is shadcn/ui in `components/ui/` (`components.json`); Tailwind v4 via the Turbopack loader in `next.config.ts`.
- `pnpm-workspace.yaml` pins `nodeLinker: hoisted` — the desktop bundle needs real directories and one copy of React. Don't change it.
- Commit subjects are sentence-case imperative, no conventional-commit prefix and no attribution trailer
  (e.g. "Release only the forward run's own lease").

## Releases

To cut a desktop release follow README → Releasing (version bump, `v*` tag, review the draft). Apple signing and
notarization run in `.github/workflows/desktop.yml`; never ship macOS builds signed any other way.
