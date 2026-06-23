import { createMemo, type Setter } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useKV } from "./kv"

export type ToolDetailsMode = "show" | "hide" | "minimal"

export const DEFAULT_TOOL_DETAILS_MODE = "show" satisfies ToolDetailsMode

const MODES: readonly ToolDetailsMode[] = ["show", "hide", "minimal"] as const

export function isToolDetailsMode(value: unknown): value is ToolDetailsMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

export function legacyToolDetailsMode(value: unknown): ToolDetailsMode {
  if (value === false) return "minimal"
  return DEFAULT_TOOL_DETAILS_MODE
}

export function toolDetailsModeFromValue(value: unknown): ToolDetailsMode {
  if (isToolDetailsMode(value)) return value
  return DEFAULT_TOOL_DETAILS_MODE
}

export function toolPartVisible(mode: ToolDetailsMode, status: ToolPart["state"]["status"]) {
  if (mode === "show") return true
  if (mode === "minimal") return status !== "completed"
  return status === "error"
}

export function useToolDetailsMode() {
  const kv = useKV()
  const hadStored = kv.get("tool_details_mode") !== undefined
  const legacy = kv.get("tool_details_visibility")
  const [stored, setStored] = kv.signal<ToolDetailsMode>("tool_details_mode", DEFAULT_TOOL_DETAILS_MODE)

  const set = (next: ToolDetailsMode | ((prev: ToolDetailsMode) => ToolDetailsMode)) => {
    if (typeof next === "function") setStored(next as Setter<ToolDetailsMode>)
    else setStored(() => next)
  }

  // Preserve legacy boolean behavior: true showed all tools, false only hid
  // completed tools. That legacy false maps to the new minimal mode.
  if (!hadStored && legacy !== undefined) set(legacyToolDetailsMode(legacy))

  const mode = createMemo<ToolDetailsMode>(() => toolDetailsModeFromValue(stored()))

  return {
    mode,
    set,
  }
}
