import { expect, test } from "bun:test"
import { RESTARTING_STATUS_TEXT } from "../../../src/component/prompt"

test("restart footer status uses an explicit non-prompt indicator", () => {
  expect(RESTARTING_STATUS_TEXT).toBe("Restarting session...")
})
