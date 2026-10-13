import { Suspense } from "react"
import { MODULES } from "@/modules"
import { ModulePage } from "./module-page"

export function generateStaticParams() {
  const pages = MODULES.flatMap((m) => m.views.filter((v) => v.slot === "page").map((v) => ({ module: m.id, view: v.id })))
  return pages.length ? pages : [{ module: "none", view: "none" }] // Cache Components needs at least one
}

/** A module's own page (sidebar → Apps), its view running in a sandboxed frame. */
export default function Page({ params }: PageProps<"/apps/[module]/[view]">) {
  return <Suspense>{params.then(({ module, view }) => <ModulePage id={module} viewId={view} />)}</Suspense>
}
