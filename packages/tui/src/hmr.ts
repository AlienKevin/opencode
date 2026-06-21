import { createSignal, type Component } from "solid-js"

type AnyComponent = Component<Record<string, any>>
type ComponentSignal = ReturnType<typeof createSignal<AnyComponent>>

const registry = new Map<string, ComponentSignal>()

function getEntry(id: string) {
  let entry = registry.get(id)
  if (!entry) {
    entry = createSignal<AnyComponent>(() => null)
    registry.set(id, entry)
  }
  return entry
}

export function useHmrComponent(id: string): AnyComponent {
  const [comp] = getEntry(id)
  return comp as unknown as AnyComponent
}

export function registerComponent(id: string, component: AnyComponent) {
  const [, setComp] = getEntry(id)
  setComp(() => component)
}

export function hot<P extends Record<string, any>>(id: string, component: Component<P>): Component<P> {
  registerComponent(id, component as AnyComponent)
  return ((props: P) => {
    const [comp] = getEntry(id)
    const C = comp()
    return C(props as Record<string, any>)
  }) as Component<P>
}

/**
 * Re-import a module and re-register its default export. The module path
 * must be an absolute file path. Cache-busting via query string forces Bun
 * to re-evaluate the module.
 */
export async function reloadModule(filePath: string): Promise<boolean> {
  try {
    const url = new URL("file://" + filePath + "?t=" + Date.now())
    const mod = await import(url.href)
    // The hot() call inside the module will re-register via registerComponent.
    // If the module doesn't use hot(), we can't reload it — return false.
    return true
  } catch (e) {
    console.error(`[hmr] failed to reload ${filePath}:`, e)
    return false
  }
}

/**
 * Start a file watcher that reloads changed TUI source files.
 * Only active when OPENCODE_HMR=true.
 */
export async function startHmrWatcher(srcDir: string): Promise<(() => void) | undefined> {
  if (!process.env.OPENCODE_HMR) return

  try {
    const { watch } = await import("fs")
    const { resolve } = await import("path")

    const root = resolve(srcDir)
    let debounce: ReturnType<typeof setTimeout> | undefined

    const w = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      if (!filename.endsWith(".tsx") && !filename.endsWith(".ts")) return
      const abs = resolve(root, filename)
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        console.log(`[hmr] reloading ${filename}`)
        void reloadModule(abs)
      }, 100)
    })

    console.log(`[hmr] watching ${root}`)
    return () => w.close()
  } catch (e) {
    console.error("[hmr] failed to start watcher:", e)
    return undefined
  }
}
