import { describe, expect, test } from "bun:test"
import { serializableRoute } from "../../../src/app-view"
import { initialRoute } from "../../../src/context/route"
import type { PromptInfo } from "../../../src/prompt/history"

describe("restart route prompt drafts", () => {
  test("serializes a home prompt draft", () => {
    const prompt: PromptInfo = { input: "restart draft", parts: [], mode: "shell" }

    expect(serializableRoute({ type: "home" }, prompt)).toEqual({
      type: "home",
      prompt,
    })
  })

  test("serializes a session prompt draft", () => {
    const prompt: PromptInfo = {
      input: "ask about @agent",
      parts: [{ type: "agent", name: "build", source: { value: "@build", start: 10, end: 16 } }],
    }

    expect(serializableRoute({ type: "session", sessionID: "ses_test" }, prompt)).toEqual({
      type: "session",
      sessionID: "ses_test",
      prompt,
    })
  })

  test("does not attach empty prompt drafts", () => {
    expect(serializableRoute({ type: "home" }, { input: "", parts: [] })).toEqual({ type: "home" })
  })

  test("parses restart prompt drafts from startup routes", () => {
    expect(
      initialRoute({
        type: "session",
        sessionID: "ses_test",
        prompt: { input: "restored draft", parts: [], mode: "normal" },
      }),
    ).toEqual({
      type: "session",
      sessionID: "ses_test",
      prompt: { input: "restored draft", parts: [], mode: "normal" },
    })
  })

  test("drops invalid startup route prompt drafts", () => {
    expect(initialRoute({ type: "home", prompt: { input: 123, parts: [] } })).toEqual({ type: "home" })
  })
})
