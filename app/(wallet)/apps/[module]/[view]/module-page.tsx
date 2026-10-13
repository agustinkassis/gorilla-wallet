"use client"

import Link from "next/link"
import { PuzzleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ModuleFrame } from "@/components/module-frame"
import { useWallet } from "@/components/wallet-provider"
import { CHAINS } from "@/lib/wallet"
import { isEnabled, moduleById, runsOn } from "@/modules"

export function ModulePage({ id, viewId }: { id: string; viewId: string }) {
  const { settings, chain } = useWallet()
  const mod = moduleById(id)
  const view = mod?.views.find((v) => v.id === viewId && v.slot === "page")
  const problem = !mod || !view
    ? "This module page doesn't exist."
    : !isEnabled(mod, settings.modules)
      ? `${mod.name} is turned off.`
      : !runsOn(mod, chain)
        ? `${mod.name} doesn't work on ${CHAINS[chain].label}.`
        : null
  if (!problem) return <ModuleFrame key={`${id}:${chain}`} module={mod!} view={view!} minHeight={480} />
  return (
    <Card className="mx-auto w-full max-w-md text-center">
      <CardHeader className="items-center">
        <PuzzleIcon className="mx-auto size-8 text-muted-foreground" />
        <CardTitle>Module unavailable</CardTitle>
        <CardDescription>{problem}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <Link href="/settings#modules">Settings → Modules</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
