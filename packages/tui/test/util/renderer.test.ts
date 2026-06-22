import { expect, test } from "bun:test"
import { destroyRenderer } from "../../src/util/renderer"

test("clears the terminal title before destroying the renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: false,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:", "destroy"])
})

test("still clears the title after renderer destruction", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: true,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:"])
})

test("can preserve the screen during renderer destruction", () => {
  const calls: [unknown, boolean][] = []
  const renderer = {
    clearOnShutdown: true,
    rendererPtr: "renderer",
    lib: {
      setClearOnShutdown(renderer: unknown, clear: boolean) {
        calls.push([renderer, clear])
      },
    },
    isDestroyed: false,
    setTerminalTitle() {},
    destroy() {},
  }

  destroyRenderer(renderer, { preserveScreen: true })

  expect(renderer.clearOnShutdown).toBe(false)
  expect(calls).toEqual([["renderer", false]])
})

test("leaves an adopted alternate screen after renderer destruction", () => {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    destroyRenderer(
      {
        isDestroyed: false,
        setTerminalTitle() {},
        destroy() {},
      },
      { adoptedAlternateScreen: true },
    )

    expect(stdout).toBe("\x1b[?1049l")
  } finally {
    process.stdout.write = originalWrite
  }
})
