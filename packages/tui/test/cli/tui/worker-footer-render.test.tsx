/** @jsxImportSource @opentui/solid */
import { afterEach, beforeAll, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import type { BackgroundJobListItem } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { BackgroundJobsFooter } from "../../../src/routes/session/background-jobs"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

beforeAll(() => {
  mkdirSync("/tmp/opencode/state", { recursive: true })
})

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

const NOW = 1_000_000

const jobs: BackgroundJobListItem[] = [
  {
    id: "running-long",
    type: "tool",
    status: "running",
    severity: "info",
    startedAt: NOW - 65_000,
    tool: "bash",
    title: "Wait for the integration marker file to appear before continuing",
    summary: "Wait for the integration marker file to appear before continuing",
    command: "sleep 60",
  },
  {
    id: "failed",
    type: "tool",
    status: "error",
    severity: "error",
    startedAt: NOW - 120_000,
    completedAt: NOW - 8_000,
    tool: "bash",
    title: "Run regression suite",
    summary: "Run regression suite",
    error: "exit 1",
  },
  {
    id: "done-short",
    type: "tool",
    status: "completed",
    severity: "success",
    startedAt: NOW - 40_000,
    completedAt: NOW - 2_000,
    tool: "bash",
    title: "ls",
    summary: "ls",
  },
]

function Harness(props: { render: () => JSX.Element }) {
  const keymap = createDefaultOpenTuiKeymap(useRenderer())
  return (
    <TestTuiContexts>
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <box width="100%" flexDirection="column">
                {props.render()}
              </box>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

// The headless renderer needs a few pumped passes for the async ThemeProvider
// to resolve colors before any text paints; loop renderOnce until non-blank.
async function renderFooter(render: () => JSX.Element, width: number, height: number) {
  testSetup = await testRender(() => <Harness render={render} />, { width, height })
  let raw = ""
  for (let i = 0; i < 40; i++) {
    await testSetup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    raw = testSetup.captureCharFrame()
    if (raw.replace(/[\s\u0000]/g, "").length > 0) break
  }
  return raw
    .replace(/\u0000/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.length > 0)
}

const stripBorder = (line: string) => line.replace(/^[┃|]\s?/, "")

test("unfocused footer is counts-only with a stable inspect affordance", async () => {
  const lines = await renderFooter(() => <BackgroundJobsFooter jobs={jobs} now={NOW} onClick={() => {}} />, 100, 4)
  const text = lines.join("\n")
  expect(text).toContain("Workers")
  expect(text).toContain("1 running, 1 failed, 1 completed")
  expect(text).toContain("inspect")
  // The variable-length per-worker output excerpt that caused the right-side
  // affordance to shift around must be gone.
  expect(text).not.toContain("Run regression suite")
  expect(text).not.toContain("exit 1")
})

test("focused footer lists one worker per row with a right-aligned status column", async () => {
  const lines = await renderFooter(
    () => (
      <BackgroundJobsFooter jobs={jobs} now={NOW} focused selectedID="failed" onClick={() => {}} onSelect={() => {}} />
    ),
    100,
    8,
  )
  const text = lines.join("\n")
  expect(text).toContain("Enter open")

  // Match worker rows by their status glyph so we never accidentally match the
  // header line (the counts text can contain words like "failed").
  const failedRow = lines.find((l) => l.includes("✗"))
  const runningRow = lines.find((l) => l.includes("•"))
  const doneRow = lines.find((l) => l.includes("✓"))

  expect(failedRow).toBeDefined()
  expect(runningRow).toBeDefined()
  expect(doneRow).toBeDefined()

  expect(failedRow).toContain("Run regression suite")
  expect(runningRow).toContain("Wait for the integration")
  expect(doneRow).toContain("ls")

  // Each worker occupies its own row (no horizontal cramming).
  expect(failedRow).not.toBe(doneRow)
  expect(failedRow).not.toBe(runningRow)

  // Status column is right-aligned: meta tokens terminate at the same column on
  // every row regardless of how long or short the title is.
  const metaEnd = (line: string, token: string) => line.lastIndexOf(token) + token.length
  const failedEnd = metaEnd(failedRow!, "failed")
  const runningEnd = metaEnd(runningRow!, "1m 5s")
  const doneEnd = metaEnd(doneRow!, "done")
  expect(Math.abs(failedEnd - runningEnd)).toBeLessThanOrEqual(1)
  expect(Math.abs(failedEnd - doneEnd)).toBeLessThanOrEqual(1)

  // Selected row carries the status glyph and title.
  expect(stripBorder(failedRow!)).toContain("✗ Run regression suite")
})

test("focused footer keeps alignment and avoids cramming at a narrow width", async () => {
  const width = 60
  const lines = await renderFooter(
    () => (
      <BackgroundJobsFooter jobs={jobs} now={NOW} focused selectedID="running-long" onClick={() => {}} onSelect={() => {}} />
    ),
    width,
    8,
  )

  const failedRow = lines.find((l) => l.includes("✗"))
  const doneRow = lines.find((l) => l.includes("✓"))
  expect(failedRow).toBeDefined()
  expect(doneRow).toBeDefined()

  // No row overflows the viewport width.
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(width)

  // Long title is truncated (ellipsis) rather than wrapping/cramming.
  const longRow = lines.find((l) => l.includes("Wait for the integration"))
  expect(longRow).toBeDefined()
  expect(longRow!).toContain("…")

  // Still right-aligned at the narrow width.
  const metaEnd = (line: string, token: string) => line.lastIndexOf(token) + token.length
  expect(Math.abs(metaEnd(failedRow!, "failed") - metaEnd(doneRow!, "done"))).toBeLessThanOrEqual(1)
})
