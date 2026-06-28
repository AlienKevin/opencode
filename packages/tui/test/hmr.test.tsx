/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Component, JSX } from "solid-js"
import { clearHmrRestartRequired, hotComponent, registerComponent, reloadHotRoots, useHmrRestartRequired } from "../src/hmr"

let app: Awaited<ReturnType<typeof testRender>> | undefined
let tempDir: string | undefined

afterEach(async () => {
  app?.renderer.destroy()
  clearHmrRestartRequired()
  app = undefined
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

test("hot component updates rendered output after re-registration", async () => {
  const id = "file:///tmp/opencode/hmr-test.tsx#Probe"
  const Probe = hotComponent<{ label: string }>(id, (props) => <text>{props.label}:before</text>)

  app = await testRender(() => <Probe label="hmr" />, { width: 40, height: 3 })
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("hmr:before")

  registerComponent("file:///tmp/opencode/hmr-test.tsx?t=123#Probe", (props) => (
    <text>{String(props.label)}:after</text>
  ))
  await app.renderOnce()

  expect(app.captureCharFrame()).toContain("hmr:after")
})

test("reloadHotRoots reloads nested UI dependencies while preserving stable contexts", async () => {
  const srcDir = await createFixture("before")
  const valueContext = (await import(pathToFileURL(join(srcDir, "context/value.tsx")).href)) as {
    ValueProvider: Component<{ value: string; children?: JSX.Element }>
  }
  const root = (await import(pathToFileURL(join(srcDir, "app-view.tsx")).href)) as {
    AppView: Component
  }
  const HotAppView = hotComponent("fixture#AppView", root.AppView)

  app = await testRender(
    () => (
      <valueContext.ValueProvider value="ctx">
        <HotAppView />
      </valueContext.ValueProvider>
    ),
    { width: 40, height: 3 },
  )
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("ctx:before")

  await writeFile(join(srcDir, "component/probe.tsx"), probeSource("after"), "utf8")
  expect(
    await reloadHotRoots({
      srcDir,
      roots: [{ id: "fixture#AppView", file: "app-view.tsx", exportName: "AppView" }],
    }),
  ).toBe(true)
  await app.renderOnce()

  expect(app.captureCharFrame()).toContain("ctx:after")
})

test("reloadHotRoots keeps the previous UI when reload fails", async () => {
  const srcDir = await createFixture("before")
  const root = (await import(pathToFileURL(join(srcDir, "app-view.tsx")).href)) as {
    AppView: Component
  }
  const HotAppView = hotComponent("fixture-fail#AppView", root.AppView)

  app = await testRender(() => <HotAppView />, { width: 40, height: 3 })
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("missing:before")

  await writeFile(join(srcDir, "component/probe.tsx"), "export function Probe() { return <text>broken</text", "utf8")
  expect(
    await reloadHotRoots({
      srcDir,
      roots: [{ id: "fixture-fail#AppView", file: "app-view.tsx", exportName: "AppView" }],
    }),
  ).toBe(false)
  await app.renderOnce()

  expect(app.captureCharFrame()).toContain("missing:before")
})

test("hot component keeps previous UI and asks for restart when render fails", async () => {
  const id = "fixture-render-fail#AppView"
  const HotAppView = hotComponent(id, () => <text>before</text>)

  function Notice() {
    const restartRequired = useHmrRestartRequired()
    return <text>{restartRequired() ? "Use /restart" : ""}</text>
  }

  app = await testRender(
    () => (
      <box flexDirection="column">
        <HotAppView />
        <Notice />
      </box>
    ),
    { width: 40, height: 4 },
  )
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("before")

  registerComponent(id, () => { throw new Error("render failed") })
  await app.renderOnce()

  expect(app.captureCharFrame()).toContain("before")
  expect(app.captureCharFrame()).toContain("Use /restart")
})

async function createFixture(label: string) {
  tempDir = await mkdtemp(join(process.cwd(), ".opencode-hmr-test-"))
  await mkdir(join(tempDir, "component"), { recursive: true })
  await mkdir(join(tempDir, "context"), { recursive: true })
  await writeFile(
    join(tempDir, "app-view.tsx"),
    `import { Probe } from "./component/probe"\nexport function AppView() { return <Probe /> }\n`,
    "utf8",
  )
  await writeFile(join(tempDir, "component/probe.tsx"), probeSource(label), "utf8")
  await writeFile(
    join(tempDir, "context/value.tsx"),
    `import { createContext, useContext, type ParentProps } from "solid-js"\nconst ValueContext = createContext("missing")\nexport function ValueProvider(props: ParentProps<{ value: string }>) { return <ValueContext.Provider value={props.value}>{props.children}</ValueContext.Provider> }\nexport function useValue() { return useContext(ValueContext) }\n`,
    "utf8",
  )
  return tempDir
}

function probeSource(label: string) {
  return `import { useValue } from "../context/value"\nexport function Probe() { return <text>{useValue()}:${label}</text> }\n`
}
