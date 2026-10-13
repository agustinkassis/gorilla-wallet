"use client"

import { useEffect, useState, type ComponentType } from "react"
import { UIS } from "@/modules/ui"

export function ModuleView({ ui, view }: { ui: string; view: string }) {
  const [View, setView] = useState<ComponentType<{ view: string }> | null>(null)
  useEffect(() => void UIS[ui]?.().then((m) => setView(() => m.default)), [ui])
  return View && <View view={view} />
}
