import "server-only"
import { randomUUID } from "node:crypto"
import { Prisma } from "@/lib/generated/prisma/client"
import { db } from "@/lib/server/db"
import type { Chain } from "@/lib/chains"

/** A renewable wallet/chain lease: every mutation compares the owner, and expired owners cannot resume. */
export async function acquireForwardLease(walletId: string, chain: Chain, durationMs: number) {
  const key = { walletId, chain }
  const owner = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + durationMs)
  const reclaimed = await db.forwardLease.updateMany({ where: { ...key, expiresAt: { lte: now } }, data: { owner, expiresAt } })
  if (!reclaimed.count) {
    try { await db.forwardLease.create({ data: { ...key, owner, expiresAt } }) }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null
      throw error
    }
  }
  let failure: unknown
  let pending = Promise.resolve()
  const renew = async () => {
    if (failure) throw failure
    const now = new Date()
    const renewed = await db.forwardLease.updateMany({
      where: { ...key, owner, expiresAt: { gt: now } }, data: { expiresAt: new Date(now.getTime() + durationMs) },
    })
    if (!renewed.count) throw new Error("Forward lease lost; refusing to sign or broadcast")
  }
  const assertOwned = () => {
    const next = pending.then(renew)
    pending = next.catch((error) => { failure = error })
    return next
  }
  const timer = setInterval(() => { void assertOwned().catch(() => {}) }, Math.min(10_000, durationMs / 3))
  timer.unref()
  return {
    assertOwned,
    close: async () => {
      clearInterval(timer)
      await pending
      await db.forwardLease.deleteMany({ where: { ...key, owner } })
    },
  }
}
