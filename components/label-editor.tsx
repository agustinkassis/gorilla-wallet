"use client"

import { useState } from "react"
import { TagIcon } from "lucide-react"
import { toast } from "sonner"
import { useWallet } from "@/components/wallet-provider"
import { api } from "@/lib/api"
import type { Chain } from "@/lib/chains"
import { cn } from "@/lib/utils"

/** Inline BIP-329 label: click to edit, Enter/blur saves, Escape cancels. */
export function LabelEditor({
  chain,
  type,
  target,
  value,
  className,
}: {
  chain: Chain
  type: "tx" | "addr" | "output"
  target: string
  value?: string
  className?: string
}) {
  const { wallet } = useWallet()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? "")

  const save = async () => {
    setEditing(false)
    if (draft.trim() === (value ?? "")) return
    try {
      await api("/api/labels", { walletId: wallet?.id, chain, type, ref: target, label: draft.trim() })
    } catch (e) {
      toast.error("Couldn't save label", { description: (e as Error).message })
      setDraft(value ?? "")
    }
  }

  if (editing)
    return (
      <input
        autoFocus
        value={draft}
        maxLength={255}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
          if (e.key === "Escape") {
            setDraft(value ?? "")
            setEditing(false)
          }
        }}
        className={cn("h-7 w-full min-w-28 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring/50", className)}
        placeholder="Label"
      />
    )
  return (
    <button
      onClick={() => {
        setDraft(value ?? "")
        setEditing(true)
      }}
      className={cn("inline-flex max-w-48 items-center gap-1 truncate text-left text-xs", value ? "text-foreground" : "text-muted-foreground/60 hover:text-muted-foreground", className)}
      title={value ? "Edit label" : "Add label"}
    >
      <TagIcon className="size-3 shrink-0" />
      <span className="truncate">{value || "Add label"}</span>
    </button>
  )
}
