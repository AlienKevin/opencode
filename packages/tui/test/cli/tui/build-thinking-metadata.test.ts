import { describe, expect, test } from "bun:test"
import { BUILD_AGENT_NAME, resolveAgentName } from "../../../src/context/local"
import {
  DEFAULT_ASSISTANT_METADATA_VISIBLE,
  reasoningPartVisible,
  shouldSwitchToBuildAgentForToolPart,
} from "../../../src/routes/session"

describe("fork-specific session defaults", () => {
  test("hides assistant metadata by default", () => {
    expect(DEFAULT_ASSISTANT_METADATA_VISIBLE).toBe(false)
  })

  test("minimal thinking hides only completed reasoning", () => {
    expect(reasoningPartVisible("minimal", false)).toBe(true)
    expect(reasoningPartVisible("minimal", true)).toBe(false)
    expect(reasoningPartVisible("hide", true)).toBe(true)
    expect(reasoningPartVisible("show", true)).toBe(true)
  })
})

describe("build agent forcing", () => {
  test("maps plan requests to build", () => {
    expect(BUILD_AGENT_NAME).toBe("build")
    expect(resolveAgentName("plan")).toBe(BUILD_AGENT_NAME)
    expect(resolveAgentName("build")).toBe(BUILD_AGENT_NAME)
    expect(resolveAgentName("review")).toBe("review")
  })

  test("switches to build for completed plan tool boundaries only once", () => {
    const completed = {
      id: "prt_plan_enter",
      tool: "plan_enter",
      state: { status: "completed", input: {}, output: "", title: "done", metadata: {}, time: { start: 0, end: 1 } },
    } as const

    expect(shouldSwitchToBuildAgentForToolPart(completed)).toBe(true)
    expect(shouldSwitchToBuildAgentForToolPart(completed, completed.id)).toBe(false)
    expect(
      shouldSwitchToBuildAgentForToolPart({
        ...completed,
        id: "prt_plan_exit",
        tool: "plan_exit",
      }),
    ).toBe(true)
    expect(
      shouldSwitchToBuildAgentForToolPart({
        ...completed,
        id: "prt_bash",
        tool: "bash",
      }),
    ).toBe(false)
    expect(
      shouldSwitchToBuildAgentForToolPart({
        ...completed,
        id: "prt_pending",
        state: { status: "pending", input: {}, raw: "{}" },
      }),
    ).toBe(false)
  })
})
