# Modules

Modules add pages, dashboard cards and transaction types to Gorilla Wallet, per chain. Each one runs **isolated from
the wallet**: it never sees keys, passwords, the database or other wallets, and it reaches the wallet only through
a small API, limited to the permissions the user sees in **Settings → Modules**. Every transaction a module proposes
goes through the wallet's own review → sign → broadcast dialog.

`modules/example` is the reference: a block/price ticker (dashboard), an API playground (page) and a "pay yourself"
transaction type (Send). It's off by default; turn it on in Settings → Modules. `modules/faucet` is a real one: a
faucet page on Signet, Testnet4 and Testnet3, three instances of one UI with their own faucet lists.

## Anatomy

```
modules/
  index.ts            registry: the manifests (MODULES)
  ui.ts               registry: the UIs, by key (loaded only inside module frames)
  example/
    manifest.ts       data: id, chains, permissions, hosts, views, config
    ui.tsx            React: one component, rendered per view inside a sandboxed frame
```

A **manifest** (`ModuleManifest`, `lib/modules/types.ts`):

| Field | |
|---|---|
| `id` | instance id, `[a-z0-9-]` |
| `ui` | key of its UI in `modules/ui.ts`; instances can share one |
| `chains` | `"all"` or a list: its views only show while one of them is selected |
| `permissions` | `wallet:read` (balance), `wallet:receive` (next receive address), `wallet:send` (propose transactions), `ui:popups` (open sites in new windows) |
| `hosts` | exact https hostnames `http.fetch` may reach |
| `views` | `{ id, slot, title, icon }`: slot `page` (sidebar → Apps), `dashboard` (card) or `send` (a transaction type on Send); `icon` is a [lucide](https://lucide.dev/icons) name |
| `config` | per-instance JSON handed to the UI |
| `enabled` | default on/off |

**Instances** reuse a module with other settings, e.g. one faucet per testnet:

```ts
// modules/faucet/manifest.ts
export const faucet = { ui: "faucet", name: "Faucet", permissions: ["wallet:receive", "ui:popups"], views: [{ id: "claim", slot: "page", title: "Faucet", icon: "droplet" }] } as const
// modules/index.ts
export const MODULES: ModuleManifest[] = [
  { ...faucet, id: "faucet-signet", chains: ["signet"], hosts: ["signetfaucet.com"], config: { faucets: [/* … */] } },
  { ...faucet, id: "faucet-testnet4", chains: ["tbtc4"], hosts: ["mempool.space"], config: { faucets: [/* … */] } },
]
```

Manifests are plain data: they're imported by the wallet (sidebar, settings, server checks), so they must not import
React components or run code.

## Writing the UI

```tsx
"use client"
import { useModule, wallet, storage, http, ui } from "@/lib/modules/sdk"

export default function Faucet({ view }: { view: string }) {
  const m = useModule() // { module, view, config, permissions, info, theme }, kept fresh on every block
  if (!m) return null
  const claim = async () => {
    const { address } = await wallet.receive()
    const res = await http.fetch("https://signetfaucet.com/claim", { method: "POST", body: JSON.stringify({ address }) })
    ui.toast(res.status === 200 ? "Claimed" : `Faucet said ${res.status}`)
  }
  return <button onClick={claim}>Claim on {m.info.label}</button>
}
```

| Call | Permission | |
|---|---|---|
| `useModule()` | – | handshake + `info` updates; also sizes the frame to the content |
| `wallet.info()` | – | `{ chain, label, unit, family, height, explorer, fees, watchOnly }` |
| `wallet.balance()` | `wallet:read` | `{ confirmed, unconfirmed }` in sats |
| `wallet.receive()` | `wallet:receive` | `{ address }`, the next unused receive address |
| `wallet.send({ outputs, data?, feeRate?, memo? })` | `wallet:send` | outputs `{ address, amount }` or `{ script (hex), amount }`, `data` = OP_RETURN payload (hex). The wallet picks coins and change, shows it to the user, signs and broadcasts; resolves `{ txid }`, rejects if declined |
| `storage.get(key)` / `storage.set(key, value)` | – | this module's own JSON store (≤ 64 KB per value, 500 keys); `null` deletes |
| `http.fetch(url, { method, headers, body })` | `hosts` | made by the wallet's server: https, port 443, no redirects followed, text in/out, 1 MB up / 2 MB down, 15 s |
| `ui.toast(message)` | – | a notification in the wallet |
| `ui.copy(text)` | – | copies one of the wallet's own addresses to the clipboard; anything else is refused, so a module can't plant an address for the user to paste |

Use only the SDK: browser storage, cookies and network calls fail inside the frame. Components in
`@/components/ui/*`, `lucide-react` and `@/lib/utils` are fine; ESLint refuses imports of the wallet's internals
(`@/lib/server/*`, `@/lib/api`, `@/components/*` outside `ui`, Node built-ins) in `modules/**`.

Register it: the manifest in `modules/index.ts`, the UI in `modules/ui.ts` (`faucet: () => import("./faucet/ui")`).

## Security model

- **Opaque origin.** Views load in `<iframe sandbox="allow-scripts allow-forms">` (no `allow-same-origin`), and
  every `/m/*` response carries a CSP `sandbox` too, so a module page is sandboxed even if opened on its own. It can't
  read the wallet's DOM, cookies or storage, navigate the wallet, or call `/api` as the wallet.
- **No network of its own.** The frame's CSP has `connect-src 'none'`, no external scripts, images or frames, and
  `form-action 'none'`. The only way out is `http.fetch`, to the manifest's hosts, through the server.
- **The API refuses frames.** `/api` rejects `Origin: null`, `Sec-Fetch-Site: cross-site` and `*.localhost` hosts,
  with or without Nostr login (a NIP-98 token from inside a frame doesn't help).
- **Bound calls.** The host answers only messages from its own frame's window carrying the random token it put in
  that frame's URL fragment: a frame that navigated elsewhere loses the API.
- **Permissions in the host.** Each call is checked against the manifest, the user's on/off switch and the selected
  chain. Transactions are built, validated (outputs, dust, chain rules, replay protection) and shown by the wallet;
  signing still needs the wallet password or the external signer, as for any payment.
- **Server side, per module.** Storage rows are keyed by module; the HTTP proxy only reaches the manifest's hosts,
  drops cookies/host/origin headers and doesn't follow redirects.

Limits: a module can leak what it's allowed to read by navigating its own frame to another site (the sandbox can't
block that), so `wallet:read` / `wallet:receive` go to modules you trust. Modules are built in (reviewed code in this
repo): their UI ships in the app bundle; installing third-party modules at runtime is a later step.

**`pnpm dev`:** Next's dev server won't serve its chunks to an opaque origin, so in development each module runs on
its own origin instead, `http://<id>.localhost:<port>` (Chrome and Firefox resolve `*.localhost` to this machine).
Different origin, same isolation from the wallet; the CSP sandbox applies in production builds (`pnpm build && pnpm
start`, the desktop app). Browser storage works there in dev only: use `storage`.

## Checks

`pnpm check` covers the server side: manifests (unique ids, registered UIs, public hostnames), per-module storage,
the HTTP allowlist, the `modules` setting and the API refusing sandboxed frames.
