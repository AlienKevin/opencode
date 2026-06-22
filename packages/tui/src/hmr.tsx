import { createMemo, createSignal, type Component } from "solid-js"
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

type HotProps = Record<string, unknown>
type HotComponent = Component<HotProps>
type ComponentSignal = ReturnType<typeof createSignal<HotComponent>>

export type HmrRoot = {
  id: string
  file: string
  exportName: string
}

export type HmrOptions = {
  srcDir: string
  roots: readonly HmrRoot[]
  debounceMs?: number
  debugLog?: (message: string) => void
}

const registry = new Map<string, ComponentSignal>()
const importPattern = /((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'])(\.{1,2}\/[^"']+)(["'])/g
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx"])
const moduleExtensions = ["", ".tsx", ".ts", ".jsx", ".js", ".json"]
const indexFiles = ["index.tsx", "index.ts", "index.jsx", "index.js", "index.json"]
const stableRoots = [
  "config/",
  "context/",
  "plugin/",
  "runtime.tsx",
  "keymap.tsx",
  "hmr.tsx",
  "hmr.ts",
  "app.tsx",
  "ui/dialog.tsx",
  "ui/toast.tsx",
  "prompt/history.tsx",
  "prompt/frecency.tsx",
  "prompt/stash.tsx",
  "component/prompt/history.tsx",
  "component/prompt/frecency.tsx",
  "component/prompt/stash.tsx",
] as const

function normalizeId(id: string) {
  try {
    const url = new URL(id)
    const hash = url.hash
    url.search = ""
    url.hash = ""
    return url.href + hash
  } catch {
    const [path, hash] = id.split("#")
    return path.replace(/\?.*$/, "") + (hash ? `#${hash}` : "")
  }
}

function getEntry(id: string) {
  let entry = registry.get(id)
  if (!entry) {
    entry = createSignal<HotComponent>(() => undefined)
    registry.set(id, entry)
  }
  return entry
}

export function registerComponent(id: string, component: HotComponent) {
  const [, setComponent] = getEntry(normalizeId(id))
  setComponent(() => component)
}

export function hotComponent<P extends object>(id: string, component: Component<P>): Component<P> {
  const normalized = normalizeId(id)
  registerComponent(normalized, component as unknown as HotComponent)
  return ((props: P) => {
    const [component] = getEntry(normalized)
    return createMemo(() => component()(props as unknown as HotProps))
  }) as unknown as Component<P>
}

export function createHmrReloader(options: HmrOptions) {
  const srcDir = resolve(options.srcDir)
  const roots = options.roots.map((root) => ({ ...root, file: resolve(srcDir, root.file) }))
  const log = options.debugLog ?? (() => {})
  let activeTempRoot: string | undefined

  async function reload() {
    if (roots.length === 0) return false

    const tempRoot = await mkdtemp(join(srcDir, ".opencode-hmr-"))
    const loader = createModuleLoader({ srcDir, tempRoot, log })

    try {
      const updates = [] as { id: string; component: HotComponent }[]
      for (const root of roots) {
        log(`importing ${root.file}`)
        const moduleUrl = await loader.compile(root.file)
        const mod = await import(moduleUrl)
        const component = mod[root.exportName]
        if (typeof component !== "function") throw new Error(`${root.exportName} is not a component export`)
        updates.push({ id: root.id, component: component as HotComponent })
      }

      updates.forEach((update) => registerComponent(update.id, update.component))
      const previousTempRoot = activeTempRoot
      activeTempRoot = tempRoot
      if (previousTempRoot) await rm(previousTempRoot, { recursive: true, force: true })
      log(`reload succeeded: ${updates.map((update) => update.id).join(",")}`)
      return true
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true })
      log(`reload failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
      return false
    }
  }

  return {
    reload,
    async dispose() {
      if (!activeTempRoot) return
      await rm(activeTempRoot, { recursive: true, force: true })
      activeTempRoot = undefined
    },
  }
}

export async function reloadHotRoots(options: HmrOptions) {
  const reloader = createHmrReloader(options)
  try {
    return await reloader.reload()
  } finally {
    await reloader.dispose()
  }
}

export async function startHmrWatcher(options: HmrOptions): Promise<(() => void) | undefined> {
  const debugLog = options.debugLog ?? ((message: string) => writeDebugLog(message))
  const reloader = createHmrReloader({ ...options, debugLog })

  try {
    const { watch } = await import("node:fs")
    const root = resolve(options.srcDir)
    let debounce: ReturnType<typeof setTimeout> | undefined

    debugLog(`starting watcher on ${root}`)
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const name = String(filename)
      if (name.includes(".opencode-hmr-")) return
      if (!isReloadableFile(name)) return

      debugLog(`change detected: ${resolve(root, name)}`)
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debugLog(`reloading hot roots`)
        void reloader.reload().then((success) => {
          if (!success) debugLog(`keeping previous hot UI`)
        })
      }, options.debounceMs ?? 100)
    })

    debugLog(`watcher started`)
    return () => {
      if (debounce) clearTimeout(debounce)
      watcher.close()
      void reloader.dispose()
    }
  } catch (error) {
    debugLog(`watcher failed: ${error instanceof Error ? error.message : String(error)}`)
    await reloader.dispose()
    return undefined
  }
}

function createModuleLoader(input: { srcDir: string; tempRoot: string; log: (message: string) => void }) {
  const compiled = new Map<string, string>()

  async function compile(file: string): Promise<string> {
    const sourceFile = resolve(file)
    if (!isInside(input.srcDir, sourceFile) || isStableModule(input.srcDir, sourceFile)) return pathToFileURL(sourceFile).href

    const existing = compiled.get(sourceFile)
    if (existing) return pathToFileURL(existing).href

    const targetFile = join(input.tempRoot, relative(input.srcDir, sourceFile))
    compiled.set(sourceFile, targetFile)
    await mkdir(dirname(targetFile), { recursive: true })

    if (!codeExtensions.has(extname(sourceFile))) {
      await copyFile(sourceFile, targetFile)
      return pathToFileURL(targetFile).href
    }

    const source = (await readFile(sourceFile, "utf8")).replace(
      /\bimport\.meta\.url\b/g,
      JSON.stringify(pathToFileURL(sourceFile).href),
    )
    await writeFile(targetFile, await rewriteImports(source, sourceFile, compile), "utf8")
    input.log(`compiled ${sourceFile}`)
    return pathToFileURL(targetFile).href
  }

  return { compile }
}

async function rewriteImports(source: string, fromFile: string, compile: (file: string) => Promise<string>) {
  const chunks = [] as string[]
  let lastIndex = 0

  for (const match of source.matchAll(importPattern)) {
    const index = match.index ?? 0
    chunks.push(source.slice(lastIndex, index))
    chunks.push(match[1]!, await compile(await resolveImport(fromFile, match[2]!)), match[3]!)
    lastIndex = index + match[0].length
  }

  chunks.push(source.slice(lastIndex))
  return chunks.join("")
}

async function resolveImport(fromFile: string, specifier: string) {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of moduleExtensions.map((extension) => base + extension)) {
    if (await isFile(candidate)) return candidate
  }
  for (const candidate of indexFiles.map((file) => join(base, file))) {
    if (await isFile(candidate)) return candidate
  }
  throw new Error(`Cannot resolve ${specifier} from ${fromFile}`)
}

async function isFile(file: string) {
  return stat(file)
    .then((result) => result.isFile())
    .catch(() => false)
}

function isStableModule(srcDir: string, file: string) {
  const path = relativePath(srcDir, file)
  return stableRoots.some((root) => (root.endsWith("/") ? path.startsWith(root) : path === root))
}

function isReloadableFile(file: string) {
  const extension = extname(file)
  return codeExtensions.has(extension) || extension === ".json"
}

function isInside(parent: string, child: string) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function relativePath(srcDir: string, file: string) {
  return relative(srcDir, file).split(sep).join("/")
}

function writeDebugLog(message: string) {
  try {
    const { appendFileSync } = require("node:fs")
    appendFileSync("/tmp/opencode-hmr.log", new Date().toISOString() + " " + message + "\n")
  } catch {}
}
