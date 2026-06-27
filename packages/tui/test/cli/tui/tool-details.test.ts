import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TOOL_DETAILS_MODE,
  isToolDetailsMode,
  legacyToolDetailsMode,
  toolDetailsModeFromValue,
  toolPartVisible,
} from "../../../src/context/tool-details"

describe("tool details mode", () => {
  test("defaults to showing tool details", () => {
    expect(DEFAULT_TOOL_DETAILS_MODE).toBe("show")
    expect(toolDetailsModeFromValue("invalid")).toBe("show")
    expect(toolDetailsModeFromValue(undefined)).toBe("show")
  })

  test("validates stored mode values", () => {
    expect(isToolDetailsMode("show")).toBe(true)
    expect(isToolDetailsMode("hide")).toBe(true)
    expect(isToolDetailsMode("minimal")).toBe(true)
    expect(isToolDetailsMode("visible")).toBe(false)
    expect(isToolDetailsMode(true)).toBe(false)
  })

  test("maps legacy boolean visibility to equivalent modes", () => {
    expect(legacyToolDetailsMode(true)).toBe("show")
    expect(legacyToolDetailsMode(false)).toBe("minimal")
    expect(legacyToolDetailsMode(undefined)).toBe("show")
  })

  test("shows minimal tools until the assistant turn completes", () => {
    expect(toolPartVisible("minimal", "pending")).toBe(true)
    expect(toolPartVisible("minimal", "running")).toBe(true)
    expect(toolPartVisible("minimal", "error", false)).toBe(false)
    expect(toolPartVisible("minimal", "error", true)).toBe(false)
    expect(toolPartVisible("minimal", "completed", false)).toBe(true)
    expect(toolPartVisible("minimal", "completed", true)).toBe(false)
  })

  test("hide mode keeps errors visible", () => {
    expect(toolPartVisible("hide", "pending")).toBe(false)
    expect(toolPartVisible("hide", "running")).toBe(false)
    expect(toolPartVisible("hide", "completed")).toBe(false)
    expect(toolPartVisible("hide", "error")).toBe(true)
  })
})
