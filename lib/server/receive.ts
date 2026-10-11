import "server-only"
import { CHAIN_IDS, familyOf, type Chain } from "@/lib/chains"
import { deriveAddress, scriptHash } from "@/lib/wallet"
import { db } from "@/lib/server/db"
import { getWallet, WalletError } from "@/lib/server/wallets"

export async function receiveAddress(id: unknown, chain: Chain, options: { readonly next?: boolean; readonly label?: string } = {}) {
  const wallet = await getWallet(id)
  const family = familyOf(chain)
  const account = wallet.accounts[family]
  if (!account) throw new WalletError("Wallet is not enabled on this network family")
  return db.$transaction(async (tx) => {
    // Acquire the SQLite write lock before reading the cursor: concurrent advances cannot lose updates.
    const cursor = await tx.receiveCursor.upsert({
      where: { walletId_family: { walletId: wallet.id, family } },
      create: { walletId: wallet.id, family, index: options.next ? 1 : 0 },
      update: { index: { increment: options.next ? 1 : 0 } },
    })
    const used = new Set((await tx.addressState.findMany({
      where: { walletId: wallet.id, chain: { in: CHAIN_IDS.filter((c) => familyOf(c) === family) }, used: true },
      select: { address: true },
    })).map((row) => row.address))
    let index = cursor.index
    let address: string
    do {
      if (index >= 0x80000000) throw new WalletError("Receive address range exhausted")
      address = deriveAddress(account.xpub, 0, index, family).address
      if (!used.has(address)) break
      index++
    } while (true)
    await tx.receiveCursor.update({ where: { walletId_family: { walletId: wallet.id, family } }, data: { index } })
    await tx.address.upsert({
      where: { walletId_address: { walletId: wallet.id, address } },
      create: { walletId: wallet.id, family, address, change: 0, index, scripthash: scriptHash(address, family) },
      update: {},
    })
    const key = { walletId: wallet.id, chain, type: "addr", ref: address } // address labels belong to one chain
    if (options.label !== undefined) await tx.label.upsert({
      where: { walletId_chain_type_ref: key }, create: { ...key, label: options.label }, update: { label: options.label },
    })
    const label = await tx.label.findUnique({ where: { walletId_chain_type_ref: key } })
    return { address, index, path: `${account.path}/0/${index}`, family, ...(label?.label ? { label: label.label } : {}) }
  })
}
