import { authorizedJson } from "@/lib/server/auth"
import { ModuleError, enabledModule, moduleFetch, storageGet, storageSet } from "@/lib/server/modules"
import type { HttpRequest } from "@/lib/modules/types"

/**
 * POST {module, method, params} → {result}: the server half of the module API (storage.get/set, http.fetch).
 * Only the wallet calls it, on behalf of the module whose frame asked (components/module-frame.tsx): module frames
 * are sandboxed and can't reach /api themselves.
 */
export async function POST(req: Request) {
  const body = await authorizedJson<{ module?: unknown; method?: unknown; params?: unknown }>(req)
  if (body instanceof Response) return body
  const p = (body.params && typeof body.params === "object" ? body.params : {}) as Record<string, unknown>
  try {
    const m = await enabledModule(body.module)
    if (body.method === "storage.get") return Response.json({ result: await storageGet(m, p.key) })
    if (body.method === "storage.set") {
      await storageSet(m, p.key, p.value)
      return Response.json({ result: null })
    }
    if (body.method === "http.fetch") return Response.json({ result: await moduleFetch(m, p as HttpRequest) })
    return Response.json({ error: "Unknown method" }, { status: 400 })
  } catch (e) {
    return Response.json({ error: e instanceof ModuleError ? e.message : "Module request failed" }, { status: 422 })
  }
}
