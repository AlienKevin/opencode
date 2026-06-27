import { describe, expect, test } from "bun:test"
import type { BackgroundJobListItem } from "@opencode-ai/sdk/v2"
import {
  backgroundJobDetails,
  formatBackgroundJobsFooterSummary,
  formatBackgroundJobDescription,
  formatBackgroundJobStatus,
  formatBackgroundJobTrace,
  formatBackgroundJobTitle,
} from "../../../src/routes/session/background-jobs"

describe("background jobs", () => {
  test("formats running background tool calls", () => {
    const job: BackgroundJobListItem = {
      id: "session:tool:call_123",
      type: "tool",
      status: "running",
      severity: "info",
      startedAt: 1_000,
      tool: "bash",
      callID: "call_123",
      summary: "Wait for marker file",
      command: "sleep 30",
      workdir: "/data",
      output: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6",
    }

    expect(formatBackgroundJobTitle(job)).toBe("Wait for marker file")
    expect(formatBackgroundJobDescription(job, 6_000)).toBe("bash · running 5.0s")
    expect(formatBackgroundJobStatus(job, 6_000)).toBe("running 5.0s")
    expect(backgroundJobDetails(job)).toEqual(["line 2", "line 3", "line 4", "line 5", "line 6"])
    expect(formatBackgroundJobTrace(job, 6_000)).toContain("$ sleep 30")
    expect(formatBackgroundJobTrace(job, 6_000)).toContain("Workdir: /data")
  })

  test("does not repeat bash when title casing differs", () => {
    const job: BackgroundJobListItem = {
      id: "session:tool:call_123",
      type: "tool",
      title: "bash",
      status: "running",
      severity: "info",
      startedAt: 1_000,
      tool: "bash",
      summary: "bash",
    }

    expect(formatBackgroundJobDescription(job, 6_000)).toBe("running 5.0s")
    expect(formatBackgroundJobsFooterSummary([job], 6_000)).toBe("1 running · bash: running 5.0s")
  })

  test("uses explicit job title and includes tool metadata", () => {
    const job: BackgroundJobListItem = {
      id: "task_123",
      type: "task",
      title: "Research docs",
      status: "running",
      severity: "info",
      startedAt: 1_000,
      tool: "task",
      summary: "Research docs",
    }

    expect(formatBackgroundJobTitle(job)).toBe("Research docs")
    expect(formatBackgroundJobDescription(job, 61_000)).toBe("task · running 1m 0s")
    expect(backgroundJobDetails(job)).toEqual([])
  })

  test("formats recent completed and failed workers", () => {
    const completed: BackgroundJobListItem = {
      id: "task_123",
      type: "task",
      title: "Research docs",
      status: "completed",
      severity: "success",
      startedAt: 1_000,
      completedAt: 9_000,
      summary: "Research docs",
      output: "done",
    }
    const failed: BackgroundJobListItem = {
      id: "session:tool:call_123",
      type: "tool",
      title: "Run tests",
      status: "error",
      severity: "error",
      startedAt: 1_000,
      completedAt: 8_000,
      tool: "bash",
      summary: "Run tests",
      error: "test failed",
    }

    expect(formatBackgroundJobDescription(completed, 10_000)).toBe("task · completed 1.0s ago")
    expect(formatBackgroundJobDescription(failed, 10_000)).toBe("bash · failed 2.0s ago")
    expect(backgroundJobDetails(failed)).toEqual(["test failed"])
    expect(formatBackgroundJobsFooterSummary([completed, failed], 10_000)).toBe("1 failed, 1 completed · Run tests: test failed")
  })
})
