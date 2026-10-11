# 🦍 Gorilla Wallet

A self-hosted, multi-wallet Bitcoin wallet with optional Nostr login, coin control, several networks (Bitcoin, the
**Blake2b (XBT)** fork, Testnet4, Testnet3, Signet) and a desktop app for macOS, Windows and Linux.

Keys live only on your server. The browser gets each wallet's xpub (to derive addresses and build unsigned PSBTs)
and asks the backend to sign. It runs with an **empty `.env`**: no login, and only reachable from this machine. Set
`ALLOWED_PUBKEYS` to require a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) signed request from
one of those Nostr keys on every API call.

## Download

Desktop builds are on the [Releases](https://github.com/agustinkassis/gorila-wallet/releases) page:

| System | File |
|---|---|
| macOS, Apple silicon (M-series) | `Gorilla.Wallet_<version>_aarch64.dmg` |
| macOS, Intel | `Gorilla.Wallet_<version>_x64.dmg` |
| Windows (x64 / ARM64) | `Gorilla.Wallet_<version>_x64-setup.exe` / `_arm64-setup.exe` |
| Linux, Intel/AMD | `Gorilla.Wallet_<version>_amd64.AppImage` (standalone), `_amd64.deb`, `.x86_64.rpm` |
| Linux, ARM64 | `Gorilla.Wallet_<version>_aarch64.AppImage` (standalone), `_arm64.deb`, `.aarch64.rpm` |

macOS builds are signed with an Apple Developer ID and notarized, so they open without a warning. Windows installers
are unsigned (More info → Run anyway); on Linux `chmod +x` the AppImage and run it.

## Run it locally

Requires [git](https://git-scm.com), **Node 24** (see `.nvmrc`; [nvm](https://github.com/nvm-sh/nvm) makes it easy)
and [pnpm](https://pnpm.io) (`corepack enable` sets it up).

```bash
git clone https://github.com/agustinkassis/gorila-wallet.git
cd gorila-wallet
nvm use               # Node 24
pnpm install          # also generates the Prisma client
pnpm dev              # applies migrations, starts on http://localhost:3000
```

Open http://localhost:3000 and create or import a wallet. For a production server: `pnpm build && pnpm start`. To
build the desktop app instead, see [Desktop app](#desktop-app).

`dev` and `start` listen on `127.0.0.1` only. Without `ALLOWED_PUBKEYS` the API also refuses any request not addressed
to localhost or coming from another site, so never expose that port (not even behind a reverse proxy). To use it from
other machines, set `ALLOWED_PUBKEYS` and run `pnpm db:migrate && pnpm next start -H 0.0.0.0` (or proxy to it).

## Wallets

For local terminal use without starting Next.js, install `gorila` with
`pnpm link --global`. See [CLI installation, commands and examples](docs/CLI.md).

Switch wallets from the top of the sidebar; add more with **Add wallet** (Sparrow-style):

- **Create**: new 12/24 recovery words generated in the browser, a backup check, optional BIP39 passphrase.
- **Import words**: restore from existing BIP39 words (live word and checksum validation).
- **Watch-only**: an xpub/zpub (mainnet) or tpub/vpub (testnets), with optional path and master fingerprint. Shown
  with a *Watch-only* badge; every send action is disabled.
- **`.env` wallet**: `SEED_PHRASE` (optional) appears as the default wallet; its seed is never stored.

Software wallets keep their recovery words in SQLite **encrypted with the wallet's password**
(scrypt N=2¹⁶ + AES-256-GCM). The password is asked for at signing time and the seed is decrypted in memory
for that signature only. The password is optional: without one the words are stored unencrypted and signing asks
for nothing. Every wallet syncs in the background over one shared Electrum connection per chain.

Each wallet has an account per family of networks: mainnet (Bitcoin, Blake) at `m/84'/0'/0'` and testnets (Testnet4,
Testnet3, Signet) at `m/84'/1'/0'`, like Sparrow and Electrum. New wallets get both; a password-protected wallet from
an earlier version asks for its password once to enable testnets.

## Networks

Pick the network in the navbar (top right): **Bitcoin**, **Blake**, **Testnet4**, **Testnet3** or **Signet**, one at a
time. A fork's replay pair syncs along in the background (on Bitcoin, Blake too; on Blake, Bitcoin), so replay checks
and the OP_RETURN guard always have both chains.

Every chain is data in [`lib/chains.ts`](lib/chains.ts): address family, colors, default sources, and features such as
SIGHASH_UNIFIED replay protection, consensus output limits and its replay pair. Adding a chain is adding an entry.
Each chain can use several Electrum servers and mempool.space-compatible explorers, tried in order: edit them in
**Settings → Networks** (or reset to the defaults), or set `<CHAIN>_ELECTRUM` / `MEMPOOL_<CHAIN>_URL` in `.env`.

## Features

- **Optional Nostr login** (NIP-07 extension) with `ALLOWED_PUBKEYS`: avatar in the navbar, NIP-98 + allowlist on every
  API call. Without it, local-only access
- **Live balances and transactions** over SSE from Electrum/Fulcrum subscriptions, with server failover
- **Send**: batch recipients, Send max, coin control (auto-suggested UTXOs), fee manager with mempool estimates
- **Review → Sign → Broadcast** modal: unsigned PSBT as animated QR (UR `crypto-psbt`, BBQr, base64, `.psbt`); sign here,
  or bring back a tx **signed on another device** (scan UR/BBQr with the camera, paste, or load `.psbt`/`.txn`), which is
  finalized and verified against the reviewed transaction (same txid, valid signatures, `0x21` on Blake); then broadcast
- **Fee bumping**: RBF (redesign the replacement: add coins, change amounts, take the fee from the payment) and CPFP
- **Replay** (Bitcoin ↔ Blake): analyze rebroadcasting any transaction in your history on the other chain, including
  incoming ones that spend someone else's coins, with an inputs → tx → outputs graph and the reason it works or not,
  then broadcast it
- **Networks**: Bitcoin, Blake, Testnet4, Testnet3 and Signet from the navbar, with editable sources per chain
- **Sats / BTC switch** in the navbar: every amount in the app in sats or in coins
- **Coin control**: freeze / unfreeze, labels on coins, addresses and txs, BIP-329 export/import
- **Receive**: next unused address with QR, gap-limit discovery (20 receive / 10 change), change on the internal chain
- **Notifications**: toast, sound, animation and system notification on incoming payments and confirmations
- **Light / dark / system theme**, switched with a circular reveal; glass surfaces, page and list transitions
- **Local SQLite cache** (Prisma): addresses, UTXOs, txs, raw txs, block times, labels, settings; warm start, Electrum status-hash sync

## Blake2b (XBT)

Select **Blake** or **Bitcoin** in the navbar: the same keys are tracked on both chains of the BLAKE2b fork:

- Blake sends are signed with **SIGHASH_UNIFIED** (`ALL|UNIFIED = 0x21`, Bitcoin Knots v29.4.1+), which Bitcoin rejects:
  they can't be replayed to move your BTC. Verified against the 166 reference vectors in `scripts/vectors/`.
- Bitcoin sends can carry a **Bitcoin-only OP_RETURN** (≥ 84 bytes). Blake's consensus rejects OP_RETURNs over 83 bytes
  (until 2027-09-01), so the transaction can never confirm there. The send form warns when a BTC spend of pre-fork coins
  could be replayed on Blake.
- Blake transactions refuse OP_RETURN outputs and output scripts over 34 bytes (Blake consensus).
- **Replay analysis** checks, per input and output: the coin is unspent on the target chain (asked to its Electrum
  server, for anyone's coin), the signatures aren't SIGHASH_UNIFIED when going to Bitcoin, outputs fit the target's
  consensus rules, the locktime is final there, the tx isn't already there, and the fee against the target's estimates.
  Transactions spending someone else's coins can be replayed too (e.g. a payment you received, so you also get its
  Blake coins): those coins move exactly where their owner sent them on the source chain. The server re-runs the
  analysis and broadcasts the source chain's own bytes.

## Configuration

Copy `.env.example` to `.env` only to change a default.

| Variable | Purpose |
|---|---|
| `SEED_PHRASE` | Optional default wallet (BIP39). Never sent to the browser or stored |
| `DERIVATION_PATH` | Its account path, default `m/84'/0'/0'` (P2WPKH) |
| `ALLOWED_PUBKEYS` | Optional npub/hex allowlist. Set: every API call needs a NIP-98 login from one of these keys. Unset: no login, localhost only |
| `<CHAIN>_ELECTRUM` | Comma-separated `tcp://` / `ssl://` Electrum servers, tried in order (`BTC_ELECTRUM`, `XBT_ELECTRUM`, `TBTC4_ELECTRUM`, …). Settings → Networks overrides it |
| `ELECTRUM_SELF_SIGNED` | Comma-separated Electrum hosts whose `ssl://` certificate isn't verified (a self-signed node you trust). Every other `ssl://` server needs a valid certificate |
| `MEMPOOL_<CHAIN>_URL` | mempool.space-compatible APIs: fees, broadcast, explorer links (`MEMPOOL_BTC_URL`, …) |
| `DATABASE_URL` | SQLite file (default `file:./data/wallet.db`) |

## Desktop app

`src-tauri/` wraps the app in [Tauri](https://tauri.app) for macOS, Windows and Linux. It bundles the Next.js server
(standalone) and Node, starts them on `localhost`, and keeps the database and `server.log` in the
OS app-data folder (`com.gorillawallet.desktop`). No `.env` is read or bundled, so it runs without login, reachable only
from this machine.

Building needs [Rust](https://rustup.rs) and, on Linux, `libwebkit2gtk-4.1-dev librsvg2-dev patchelf`:

```bash
pnpm tauri build      # installers in src-tauri/target/release/bundle/
```

Builds are native (Node and better-sqlite3 are bundled for the host), so each OS/arch builds on its own:
`.github/workflows/desktop.yml` builds macOS (arm64, x64), Windows (x64, arm64) and Linux (x64, arm64) as workflow
artifacts; a `v*` tag also creates a draft release (see [Releasing](#releasing)). macOS builds are Developer ID signed
and notarized when the secrets below exist (ad-hoc signed otherwise, except on a tag, which fails); Windows installers
are unsigned (SmartScreen: More info → Run anyway). The app icon, favicon and sidebar use the official logo
(`src-tauri/app-icon.svg`, `components/logo.tsx`); after changing it, run `pnpm tauri icon src-tauri/app-icon.svg` and
keep only the files already in `src-tauri/icons/`. The boot screens (`src-tauri/splash/`, `components/splash.tsx`) show
the cover image with a progress bar and the version.

### Signed macOS builds

macOS only opens downloaded apps without a warning when they are signed with an Apple **Developer ID** and notarized
by Apple. The workflow does both with these repository secrets (GitHub → Settings → Secrets and variables → Actions).
They are already set; this is how to set them up again (new certificate, renewed or revoked key, another repository).

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Your *Developer ID Application* certificate exported as `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting that `.p12` |
| `APPLE_API_KEY_ID` | An App Store Connect API key's Key ID (used to notarize) |
| `APPLE_API_ISSUER` | That key's Issuer ID |
| `APPLE_API_KEY_P8` | The contents of the key's `AuthKey_<KeyID>.p8` file |

1. **Join the Apple Developer Program** at <https://developer.apple.com/programs/enroll/> (99 USD/year; an organization
   needs a D-U-N-S number). Approval usually takes a day or two.
2. **Create the certificate** (as the account holder): in Xcode, Settings → Accounts → your team → Manage
   Certificates → **+** → *Developer ID Application*. Without Xcode: Keychain Access → Certificate Assistant → Request a
   Certificate From a Certificate Authority (saved to disk), then upload it at
   <https://developer.apple.com/account/resources/certificates/add> as *Developer ID Application* (G2 Sub-CA) and
   double-click the downloaded `.cer`.
3. **Export it**: Keychain Access → login → My Certificates → *Developer ID Application: Your Name (TEAMID)* (with its
   private key) → Export → `DeveloperID.p12`, with a password.
4. **Create an API key for notarization**: <https://appstoreconnect.apple.com> → Users and Access → Integrations →
   App Store Connect API → **Team Keys** (not *Individual Keys*: those have no Issuer ID) → **+**, access *Developer* →
   download `AuthKey_<KeyID>.p8` (only downloadable once) and note its Key ID. The **Issuer ID** is the UUID shown
   above that table (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, with a Copy button).
5. **Add the secrets**:

   ```bash
   base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE --repo agustinkassis/gorila-wallet
   gh secret set APPLE_CERTIFICATE_PASSWORD --repo agustinkassis/gorila-wallet   # prompts for it
   gh secret set APPLE_API_KEY_ID --repo agustinkassis/gorila-wallet --body "<Key ID>"
   pbpaste | tr -d '[:space:]"' | gh secret set APPLE_API_ISSUER --repo agustinkassis/gorila-wallet   # Issuer ID copied
   gh secret set APPLE_API_KEY_P8 --repo agustinkassis/gorila-wallet < AuthKey_<KeyID>.p8
   ```

6. **Check** with a run from Actions → Desktop → Run workflow: the macOS jobs import the certificate into a temporary
   keychain, sign the app, the bundled Node and its native modules with the hardened runtime, notarize with the API
   key, staple the ticket and check that Gatekeeper accepts it. Then delete the local `.p12` and `.p8`.

The Developer ID certificate expires after 5 years, and the Apple Developer Program needs renewing every year: an
expired membership fails notarization.

### Releasing

Every release ships the same installers: macOS (arm64, x64), Windows (x64, arm64), Linux (x64, arm64).

1. On `main`, bump `version` in `package.json` (e.g. `0.1.1`), commit and push.
2. Tag that commit with the same version and push the tag:

   ```bash
   git tag v0.1.1 && git push origin v0.1.1
   ```

3. Wait for [Actions → Desktop](https://github.com/agustinkassis/gorila-wallet/actions/workflows/desktop.yml) (about 15
   minutes). On a tag the workflow fails rather than ship something incomplete: the tag must equal `v` + the
   `package.json` version, the macOS apps must be Developer ID signed, notarized and accepted by Gatekeeper, and the
   draft release is only created when all six builds succeed. A flaky failure: Re-run failed jobs (the release job
   replaces the files of an existing draft). A failure that needs a code fix: delete the tag
   (`git push --delete origin v0.1.1 && git tag -d v0.1.1`), fix on `main` and tag again.
4. Open the draft on [Releases](https://github.com/agustinkassis/gorila-wallet/releases), review the generated notes
   and files (10: two `.dmg`, two `-setup.exe`, and an AppImage, `.deb` and `.rpm` per Linux arch), and **Publish
   release**.

## Scripts

| Command | |
|---|---|
| `pnpm dev` / `pnpm start` | Migrate, then run (dev / production) |
| `pnpm build` | Production build |
| `pnpm check` | Self-checks: SIGHASH_UNIFIED vectors, signing round trips, coin selection, fee math, NIP-98 |
| `pnpm check:cli` | CLI and core checks against isolated SQLite and simulated Electrum/mempool servers |
| `pnpm check:cli:regtest` | CLI end-to-end checks against isolated Bitcoin Core and Electrum/Esplora in Docker, with mined confirmations |
| `pnpm lint` | ESLint |
| `pnpm db:migrate` | Apply Prisma migrations |
| `pnpm tauri build` | Desktop app for this OS/arch (see above) |

## Security model

- The backend signs only inputs that are provably this wallet's coins (derivation path, fingerprint and script checked
  against the real parent transaction), refuses frozen coins and chain-rule violations, and caps fee rates.
- POST bodies are bound to the NIP-98 signature (`payload` tag). Each write event is accepted once, including across restarts; clients must sign a fresh event for retries.
- `ssl://` Electrum servers must present a valid certificate, except hosts listed in `ELECTRUM_SELF_SIGNED`; `tcp://`
  servers are unauthenticated. Raw transactions are checked against their txid, from the network and from the cache.
- Software wallets with a password store their recovery words only encrypted with it; a stolen database can't spend
  them. Wallets created without a password can be spent by anyone with the database.
  Watch-only wallets can't sign. `.env` and `data/` are git-ignored.

## Layout

```
app/                 pages (dashboard, send, receive, transactions, utxos, settings) and API routes
components/          UI (shadcn/ui), providers, QR
lib/chains.ts        chain registry: networks, address families, features, default sources
lib/wallet.ts        shared types and address helpers
lib/tx.ts            coin selection, fee policies, PSBT building, per-chain output rules
lib/unified-sighash.ts  SIGHASH_UNIFIED
lib/server/          wallets, seed encryption, auth, Electrum client, sync engine, signer, settings, labels (server-only)
prisma/              schema and migrations
scripts/check.ts     pnpm check
scripts/desktop.mjs  desktop bundle inputs (Next.js standalone server + Node sidecar)
src-tauri/           desktop app (Tauri)
```
