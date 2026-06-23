import { describe, expect, test } from "bun:test"
import type { FilePart, Message, Part } from "@opencode-ai/sdk/v2"
import { editLastMessageAction } from "../../../src/component/prompt"

const sessionID = "ses_test"

function userMessage(id: string): Message {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "test", modelID: "model" },
  }
}

function textPart(messageID: string, text: string, synthetic = false): Part {
  return {
    id: `prt_${messageID}_${text}`,
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic,
  }
}

function filePart(messageID: string): FilePart {
  return {
    id: `prt_${messageID}_file`,
    sessionID,
    messageID,
    type: "file",
    mime: "text/plain",
    filename: "notes.txt",
    url: "file:///tmp/notes.txt",
  }
}

describe("editLastMessageAction", () => {
  test("reconstructs the latest user prompt and reverts it while idle", () => {
    const message = userMessage("msg_002")
    const attachment = filePart(message.id)

    const action = editLastMessageAction({
      sessionID,
      messages: [userMessage("msg_001"), message],
      parts: {
        [message.id]: [textPart(message.id, "hello "), textPart(message.id, "ignored", true), textPart(message.id, "world"), attachment],
      },
      status: { type: "idle" },
    })

    expect(action?.kind).toBe("revert")
    expect(action?.messageID).toBe(message.id)
    expect(action?.prompt.input).toBe("hello world")
    expect(action?.prompt.parts).toHaveLength(1)
    expect(action?.prompt.parts[0]).toMatchObject({ type: "file", url: attachment.url })
  })

  test("retracts instead of reverting while the session is busy", () => {
    const message = userMessage("msg_busy")

    expect(
      editLastMessageAction({
        sessionID,
        messages: [message],
        parts: { [message.id]: [textPart(message.id, "while busy")] },
        status: { type: "busy" },
      }),
    ).toMatchObject({ kind: "retract", messageID: message.id, prompt: { input: "while busy" } })
  })

  test("skips messages at or after the current revert boundary", () => {
    const previous = userMessage("msg_001")
    const reverted = userMessage("msg_002")

    expect(
      editLastMessageAction({
        sessionID,
        messages: [previous, reverted],
        parts: {
          [previous.id]: [textPart(previous.id, "previous")],
          [reverted.id]: [textPart(reverted.id, "reverted")],
        },
        status: { type: "idle" },
        revertMessageID: reverted.id,
      })?.prompt.input,
    ).toBe("previous")
  })

  test("does nothing without a session or user message", () => {
    expect(editLastMessageAction({ messages: [userMessage("msg_001")], parts: {} })).toBeUndefined()
    expect(editLastMessageAction({ sessionID, messages: [], parts: {} })).toBeUndefined()
  })
})
