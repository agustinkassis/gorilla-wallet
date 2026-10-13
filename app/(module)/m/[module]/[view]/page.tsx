import { Suspense } from "react"
import { notFound } from "next/navigation"
import { MODULES, moduleById } from "@/modules"
import { ModuleView } from "./module-view"

export function generateStaticParams() {
  return MODULES.flatMap((m) => m.views.map((v) => ({ module: m.id, view: v.id })))
}

/** A module's view, loaded by the wallet in a sandboxed frame (components/module-frame.tsx). */
export default function Page({ params }: PageProps<"/m/[module]/[view]">) {
  return (
    <Suspense>
      {params.then(({ module, view }) => {
        const m = moduleById(module)
        if (!m?.views.some((v) => v.id === view)) notFound()
        return <ModuleView ui={m.ui} view={view} />
      })}
    </Suspense>
  )
}
