import type { ModuleManifest } from "@/lib/modules/types"

/** A public faucet. `{address}` in `url` becomes the receive address, on sites that prefill it. */
export type Faucet = {
  name: string
  url: string
  /** what its site asks before paying: the user goes through it there (the wallet never solves captchas) */
  gate: "captcha" | "login"
  /** a keyless claim API in CypherFaucet's shape: POST {network, address}, GET info; claims without opening the site */
  api?: { claim: string; info: string; network: string }
  note?: string
}
export type FaucetConfig = { faucets: Faucet[]; notice?: string }

const faucet: Omit<ModuleManifest, "id" | "chains" | "hosts" | "config"> = {
  name: "Faucet",
  description: "Test coins from public faucets, paid to your next receive address. One click where the faucet has an API, its own site (and captcha) otherwise.",
  ui: "faucet",
  permissions: ["wallet:receive", "wallet:read", "ui:popups"],
  views: [{ id: "claim", slot: "page", title: "Faucet", icon: "droplet" }],
  enabled: true,
}

// Checked live 2026-10-13: reachable, paying, how each takes the address. Add or drop faucets here; no code changes.
export const faucets: ModuleManifest[] = [
  {
    ...faucet,
    id: "faucet-signet",
    chains: ["signet"],
    config: {
      faucets: [
        { name: "Signet Faucet", url: "https://alt.signetfaucet.com/#{address}", gate: "captcha" },
        { name: "Signet Faucet (mirror)", url: "https://signet25.bublina.eu.org/#{address}", gate: "captcha" },
        { name: "Bitcoin Signet Faucet", url: "https://bitcoinsignetfaucet.com/", gate: "captcha", note: "1,000–10,000 sats, up to 5 requests a day" },
      ],
    } satisfies FaucetConfig,
  },
  {
    ...faucet,
    id: "faucet-testnet4",
    chains: ["tbtc4"],
    hosts: ["cypherfaucet.com"],
    config: {
      faucets: [
        {
          name: "CypherFaucet",
          url: "https://cypherfaucet.com/btc-testnet?address={address}",
          gate: "captcha",
          api: { claim: "https://cypherfaucet.com/api/v1/claim", info: "https://cypherfaucet.com/api/v1/info?network=btc-testnet", network: "btc-testnet" },
        },
        { name: "coinfaucet.eu", url: "https://coinfaucet.eu/en/btc-testnet4/", gate: "captcha" },
        { name: "testnet4.dev", url: "https://faucet.testnet4.dev/", gate: "captcha" },
        { name: "testnet4.info", url: "https://testnet4.info/", gate: "login", note: "GitHub, X or Discord login; 0.1 tBTC decaying to 0.01" },
      ],
    } satisfies FaucetConfig,
  },
  {
    ...faucet,
    id: "faucet-testnet3",
    chains: ["tbtc3"],
    config: {
      notice: "Testnet3 is deprecated (Bitcoin Core 30 dropped it): few faucets still pay. Testnet4 or Signet are better bets.",
      faucets: [{ name: "coinfaucet.eu", url: "https://coinfaucet.eu/en/btc-testnet/", gate: "captcha" }],
    } satisfies FaucetConfig,
  },
]
