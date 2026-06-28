import { describe, expect, test } from "bun:test"
import type { BackgroundJobListItem } from "@opencode-ai/sdk/v2"
import {
  backgroundJobDetails,
  backgroundJobGlyph,
  defaultBackgroundJobID,
  formatBackgroundJobsCounts,
  formatBackgroundJobDescription,
  formatBackgroundJobMeta,
  formatBackgroundJobStatus,
  formatBackgroundJobTrace,
  formatBackgroundJobTitle,
  nextBackgroundJobID,
  orderedBackgroundJobs,
  previousBackgroundJobOrExit,
  selectedBackgroundJob,
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
    expect(formatBackgroundJobsCounts([job])).toBe("1 running")
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
    // Counts-only summary stays stable regardless of worker output length.
    expect(formatBackgroundJobsCounts([completed, failed])).toBe("1 failed, 1 completed")
    // Compact right-aligned status column.
    expect(formatBackgroundJobMeta(failed, 10_000)).toBe("failed")
    expect(formatBackgroundJobMeta(completed, 10_000)).toBe("done")
    expect(backgroundJobGlyph(failed)).toBe("✗")
    expect(backgroundJobGlyph(completed)).toBe("✓")
  })

  test("running worker meta shows elapsed duration only", () => {
    const running: BackgroundJobListItem = {
      id: "session:tool:call_999",
      type: "tool",
      title: "Sleep",
      status: "running",
      severity: "info",
      startedAt: 1_000,
      tool: "bash",
    }
    expect(formatBackgroundJobMeta(running, 66_000)).toBe("1m 5s")
    expect(backgroundJobGlyph(running)).toBe("•")
  })

  test("orders and cycles workers for footer navigation", () => {
    const completed: BackgroundJobListItem = {
      id: "completed",
      type: "tool",
      title: "Completed worker",
      status: "completed",
      severity: "success",
      startedAt: 4_000,
      completedAt: 5_000,
    }
    const running: BackgroundJobListItem = {
      id: "running",
      type: "tool",
      title: "Running worker",
      status: "running",
      severity: "info",
      startedAt: 3_000,
    }
    const failed: BackgroundJobListItem = {
      id: "failed",
      type: "tool",
      title: "Failed worker",
      status: "error",
      severity: "error",
      startedAt: 2_000,
      completedAt: 6_000,
    }

    expect(orderedBackgroundJobs([completed, running, failed]).map((job) => job.id)).toEqual([
      "failed",
      "running",
      "completed",
    ])
    expect(defaultBackgroundJobID([completed, running, failed])).toBe("failed")
    expect(selectedBackgroundJob([completed, running, failed], "missing")?.id).toBe("failed")
    expect(nextBackgroundJobID([completed, running, failed], "failed", 1)).toBe("running")
    expect(nextBackgroundJobID([completed, running, failed], "failed", -1)).toBe("completed")
  })

  test("up at the top worker exits to the prompt, otherwise selects the previous worker", () => {
    const completed: BackgroundJobListItem = {
      id: "completed",
      type: "tool",
      title: "Completed worker",
      status: "completed",
      severity: "success",
      startedAt: 4_000,
      completedAt: 5_000,
    }
    const running: BackgroundJobListItem = {
      id: "running",
      type: "tool",
      title: "Running worker",
      status: "running",
      severity: "info",
      startedAt: 3_000,
    }
    const failed: BackgroundJobListItem = {
      id: "failed",
      type: "tool",
      title: "Failed worker",
      status: "error",
      severity: "error",
      startedAt: 2_000,
      completedAt: 6_000,
    }
    // Order is: failed (top), running, completed (bottom).
    const jobs = [completed, running, failed]

    // At the top worker -> exit back to the prompt (no wrap to the bottom).
    expect(previousBackgroundJobOrExit(jobs, "failed")).toEqual({ type: "exit" })

    // Below the top -> move up one row.
    expect(previousBackgroundJobOrExit(jobs, "running")).toEqual({ type: "select", id: "failed" })
    expect(previousBackgroundJobOrExit(jobs, "completed")).toEqual({ type: "select", id: "running" })

    // No / stale selection resolves to the top, so it exits.
    expect(previousBackgroundJobOrExit(jobs, undefined)).toEqual({ type: "exit" })
    expect(previousBackgroundJobOrExit(jobs, "missing")).toEqual({ type: "exit" })

    // Single worker is always the top -> exit.
    expect(previousBackgroundJobOrExit([running], "running")).toEqual({ type: "exit" })

    // Empty list -> exit.
    expect(previousBackgroundJobOrExit([], undefined)).toEqual({ type: "exit" })
  })
})
