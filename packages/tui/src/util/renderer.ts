import type { CliRenderer } from "@opentui/core"

export function destroyRenderer(
  renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">,
  options: { preserveScreen?: boolean } = {},
) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  if (options.preserveScreen) setClearOnShutdown(renderer, false)
  renderer.destroy()
}

function setClearOnShutdown(renderer: object, clear: boolean) {
  Reflect.set(renderer, "clearOnShutdown", clear)
  const lib = Reflect.get(renderer, "lib")
  if (!lib || typeof lib !== "object") return
  const setNativeClearOnShutdown = Reflect.get(lib, "setClearOnShutdown")
  if (typeof setNativeClearOnShutdown !== "function") return
  setNativeClearOnShutdown.call(lib, Reflect.get(renderer, "rendererPtr"), clear)
}
