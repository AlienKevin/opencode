import { expect, mock, test } from "bun:test"
import type { CliRendererConfig } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

async function waitForFrameWhere(input: {
  render: () => Promise<void>
  capture: () => string
  label: string
  predicate: (frame: string) => boolean
  timeout?: number
}) {
  const start = Date.now()
  while (true) {
    const frame = input.capture()
    if (input.predicate(frame)) return frame
    await input.render()
    const rendered = input.capture()
    if (input.predicate(rendered)) return rendered
    if (Date.now() - start > (input.timeout ?? 2000)) throw new Error(`timed out waiting for ${input.label}`)
    await Bun.sleep(10)
  }
}

async function waitForFrame(input: { render: () => Promise<void>; capture: () => string; text: string; timeout?: number }) {
  return waitForFrameWhere({
    render: input.render,
    capture: input.capture,
    label: input.text,
    predicate: (frame) => frame.includes(input.text),
    timeout: input.timeout,
  })
}

function createSessionFixtureFetch() {
  const model = {
    id: "model",
    providerID: "test",
    api: { id: "test", url: "https://example.com", npm: "@test/provider" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1000, output: 1000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
  const provider = {
    id: "test",
    name: "Test Provider",
    source: "custom",
    env: [],
    options: {},
    models: { model },
  }
  const session = {
    id: "ses_test",
    title: "Test session",
    slug: "test-session",
    projectID: "proj_test",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 2 },
  }
  const user = {
    id: "msg_user",
    sessionID: session.id,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "test", modelID: "model" },
  }
  const assistant = {
    id: "msg_assistant",
    sessionID: session.id,
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: user.id,
    modelID: "model",
    providerID: "test",
    mode: "primary",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
  const parts = [
    {
      id: "prt_active_reasoning",
      sessionID: session.id,
      messageID: assistant.id,
      type: "reasoning",
      text: "**Active Reasoning**\n\nactive reasoning body",
      time: { start: 1 },
    },
    {
      id: "prt_completed_reasoning",
      sessionID: session.id,
      messageID: assistant.id,
      type: "reasoning",
      text: "**Completed Reasoning**\n\ncompleted reasoning body",
      time: { start: 1, end: 2 },
    },
    {
      id: "prt_answer",
      sessionID: session.id,
      messageID: assistant.id,
      type: "text",
      text: "assistant answer",
    },
  ]
  return createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { test: "model" } })
    if (url.pathname === "/provider") return json({ all: [provider], default: { test: "model" }, connected: ["test"] })
    if (url.pathname === "/agent")
      return json([
        { name: "build", mode: "primary", permission: [], options: {}, model: { providerID: "test", modelID: "model" } },
        { name: "review", mode: "primary", permission: [], options: {}, model: { providerID: "test", modelID: "model" } },
      ])
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/session/status") return json({ [session.id]: { type: "idle" } })
    if (url.pathname === `/session/${session.id}`) return json(session)
    if (url.pathname === `/session/${session.id}/message`)
      return json([
        { info: user, parts: [] },
        { info: assistant, parts },
      ])
    if (url.pathname === `/session/${session.id}/todo`) return json([])
    if (url.pathname === `/session/${session.id}/diff`) return json([])
  })
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(Global.defaultLayer)),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(Global.defaultLayer)),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.restart can return without destroying the renderer for exec handoff", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch()
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const stop = setup.renderer.stop.bind(setup.renderer)
  let stops = 0
  setup.renderer.stop = () => {
    stops++
    stop()
  }

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        restart: { preserveScreen: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(Global.defaultLayer)),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.restart")

    expect((await task).type).toBe("restart")
    expect(setup.renderer.isDestroyed).toBe(false)
    expect(stops).toBe(1)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("session UI exposes thinking selector and assistant metadata toggle", async () => {
  const setup = await createTestRenderer({ width: 100, height: 32, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createSessionFixtureFetch()
  const originalWrite = process.stdout.write.bind(process.stdout)
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  process.stdout.write = (() => true) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        restart: {
          wasRestarted: true,
          fastBoot: true,
          initialRoute: { type: "session", sessionID: "ses_test" },
        },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(Global.defaultLayer)),
    )

    await ready
    const frame = await waitForFrame({
      render: () => setup.renderOnce(),
      capture: () => setup.captureCharFrame(),
      text: "assistant answer",
    })
    expect(frame).toContain("Active Reasoning")
    expect(frame).not.toContain("Completed Reasoning")
    const metadataVisible = frame.includes("Test Model")

    api?.keymap.dispatchCommand("session.toggle.assistant_metadata")
    const toggledFrame = await waitForFrameWhere({
      render: () => setup.renderOnce(),
      capture: () => setup.captureCharFrame(),
      label: "assistant metadata toggle",
      predicate: (next) => next.includes("Test Model") !== metadataVisible,
    })
    expect(toggledFrame.includes("Test Model")).toBe(!metadataVisible)

    api?.keymap.dispatchCommand("session.toggle.thinking")
    const dialogFrame = await waitForFrame({
      render: () => setup.renderOnce(),
      capture: () => setup.captureCharFrame(),
      text: "Thinking mode",
    })
    expect(dialogFrame).toContain("Show thinking")
    expect(dialogFrame).toContain("Minimal thinking")

    api?.keymap.dispatchCommand("app.exit")
    expect((await task).type).toBe("exit")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("restarted app adopts the existing alternate screen", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  let rendererConfig: CliRendererConfig | undefined
  mock.module("@opentui/core", () => ({
    ...core,
    createCliRenderer: async (config?: CliRendererConfig) => {
      rendererConfig = config
      return setup.renderer
    },
  }))
  const events = createEventSource()
  const calls = createFetch()
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        restart: { adoptAlternateScreen: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(Global.defaultLayer)),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")

    expect((await task).type).toBe("exit")
    expect(rendererConfig?.screenMode).toBe("main-screen")
    expect(stdout).toContain("\x1b[?1049l")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
