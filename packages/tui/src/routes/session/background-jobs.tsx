import { createSignal, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { Locale } from "../../util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { useCommandShortcut, useBindings } from "../../keymap"
import type { BackgroundJobListItem } from "@opencode-ai/sdk/v2"
import { useDialog } from "../../ui/dialog"

function jobTool(job: BackgroundJobListItem) {
  return job.tool ?? job.type
}

function statusVerb(job: BackgroundJobListItem) {
  if (job.status === "completed") return "completed"
  if (job.status === "error") return "failed"
  if (job.status === "cancelled") return "cancelled"
  return "running"
}

function statusCount(jobs: BackgroundJobListItem[], status: BackgroundJobListItem["status"]) {
  return jobs.filter((job) => job.status === status).length
}

function statusPriority(job: BackgroundJobListItem) {
  if (job.status === "error") return 0
  if (job.status === "running") return 1
  if (job.status === "cancelled") return 2
  return 3
}

function sameLabel(a: string | undefined, b: string | undefined) {
  return a?.trim().toLowerCase() === b?.trim().toLowerCase()
}

export function formatBackgroundJobTitle(job: BackgroundJobListItem) {
  if (job.title) return job.title
  if (job.summary) return job.summary
  return Locale.titlecase(jobTool(job))
}

export function orderedBackgroundJobs(jobs: BackgroundJobListItem[]) {
  return jobs.toSorted(
    (a, b) =>
      statusPriority(a) - statusPriority(b) ||
      (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
      formatBackgroundJobTitle(a).localeCompare(formatBackgroundJobTitle(b)),
  )
}

export function defaultBackgroundJobID(jobs: BackgroundJobListItem[]) {
  return orderedBackgroundJobs(jobs)[0]?.id
}

export function selectedBackgroundJob(jobs: BackgroundJobListItem[], selectedID: string | undefined) {
  return jobs.find((job) => job.id === selectedID) ?? orderedBackgroundJobs(jobs)[0]
}

export function nextBackgroundJobID(
  jobs: BackgroundJobListItem[],
  selectedID: string | undefined,
  direction: 1 | -1,
) {
  const ordered = orderedBackgroundJobs(jobs)
  if (ordered.length === 0) return
  const current = ordered.findIndex((job) => job.id === selectedID)
  return ordered[(current + direction + ordered.length) % ordered.length]?.id ?? ordered[0]?.id
}

// Decides what "previous"/up should do while the worker panel is focused.
// At the top worker (or with no resolvable selection) it exits back to the
// prompt that sits directly above the panel; otherwise it moves up one row.
// Never wraps from the top to the bottom.
export function previousBackgroundJobOrExit(
  jobs: BackgroundJobListItem[],
  selectedID: string | undefined,
): { type: "exit" } | { type: "select"; id: string } {
  const ordered = orderedBackgroundJobs(jobs)
  if (ordered.length === 0) return { type: "exit" }
  const index = ordered.findIndex((job) => job.id === selectedID)
  if (index <= 0) return { type: "exit" }
  return { type: "select", id: ordered[index - 1].id }
}

export function formatBackgroundJobStatus(job: BackgroundJobListItem, now: number) {
  if (job.status === "running") return `running ${Locale.duration(Math.max(0, now - job.startedAt))}`
  if (job.completedAt === undefined) return statusVerb(job)
  return `${statusVerb(job)} ${Locale.duration(Math.max(0, now - job.completedAt))} ago`
}

export function formatBackgroundJobDescription(job: BackgroundJobListItem, now: number) {
  const parts: string[] = []
  const tool = jobTool(job)
  const title = formatBackgroundJobTitle(job)
  if (job.summary && !sameLabel(job.summary, title)) parts.push(job.summary)
  if (tool && !sameLabel(title, Locale.titlecase(tool)) && !sameLabel(tool, job.summary)) parts.push(tool)
  parts.push(formatBackgroundJobStatus(job, now))
  return parts.join(" · ")
}

export function backgroundJobDetails(job: BackgroundJobListItem): string[] {
  const details: string[] = []
  if (job.error) details.push(job.error.trim())
  if (job.output) details.push(...job.output.trimEnd().split("\n").slice(-5))
  return details
}

// Counts-only summary. Deliberately excludes any per-worker output excerpt so
// the footer header has a stable width and the right-side affordance never
// shifts as worker outputs grow or shrink.
export function formatBackgroundJobsCounts(jobs: BackgroundJobListItem[]) {
  return [
    statusCount(jobs, "running") > 0
      ? Locale.pluralize(statusCount(jobs, "running"), "{} running", "{} running")
      : undefined,
    statusCount(jobs, "error") > 0
      ? Locale.pluralize(statusCount(jobs, "error"), "{} failed", "{} failed")
      : undefined,
    statusCount(jobs, "cancelled") > 0
      ? Locale.pluralize(statusCount(jobs, "cancelled"), "{} cancelled", "{} cancelled")
      : undefined,
    statusCount(jobs, "completed") > 0
      ? Locale.pluralize(statusCount(jobs, "completed"), "{} completed", "{} completed")
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ")
}

// Short right-aligned status column for each worker row.
export function formatBackgroundJobMeta(job: BackgroundJobListItem, now: number) {
  if (job.status === "running") return Locale.duration(Math.max(0, now - job.startedAt))
  if (job.status === "error") return "failed"
  if (job.status === "cancelled") return "cancelled"
  return "done"
}

export function backgroundJobGlyph(job: BackgroundJobListItem) {
  if (job.status === "running") return "•"
  if (job.status === "error") return "✗"
  if (job.status === "cancelled") return "⊘"
  return "✓"
}

export function formatBackgroundJobTrace(
  job: BackgroundJobListItem,
  now: number,
  input?: { command?: string; workdir?: string },
) {
  const command = job.command ?? input?.command
  const workdir = job.workdir ?? input?.workdir
  return [
    `Status: ${formatBackgroundJobStatus(job, now)}`,
    `Type: ${job.type}`,
    job.tool ? `Tool/agent: ${job.tool}` : undefined,
    workdir ? `Workdir: ${workdir}` : undefined,
    command ? `$ ${command}` : "Command: unavailable for this worker",
    job.error ? `\nError:\n${job.error.trim()}` : undefined,
    job.output ? `\nOutput:\n${job.output.trimEnd()}` : undefined,
  ]
    .filter((line): line is string => !!line)
    .join("\n")
}

export function BackgroundJobsFooter(props: {
  jobs: BackgroundJobListItem[]
  now: number
  focused?: boolean
  selectedID?: string
  onClick: () => void
  onSelect?: (id: string) => void
}) {
  const { theme } = useTheme()
  const shortcut = useCommandShortcut("session.background.jobs")
  const [hover, setHover] = createSignal(false)
  const dimensions = useTerminalDimensions()

  const hasError = () => props.jobs.some((job) => job.severity === "error" || job.status === "error")
  const ordered = () => orderedBackgroundJobs(props.jobs)
  // Title budget keeps the left column from colliding with the right-aligned
  // status column regardless of how long a worker's title is. The right column
  // (meta) is short and bounded, so reserving a fixed slice is enough.
  const titleBudget = () => Math.max(12, dimensions().width - 22)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
        gap={props.focused ? 1 : 0}
      >
        <box
          flexDirection="row"
          justifyContent="space-between"
          gap={1}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => props.onClick()}
          backgroundColor={hover() && !props.focused ? theme.backgroundElement : theme.backgroundPanel}
        >
          <box flexDirection="row" gap={1} flexShrink={1}>
            <text fg={hasError() ? theme.error : theme.text} wrapMode="none">
              <b>Workers</b>
            </text>
            {/* Counts are redundant while focused because every worker's status
                is visible in the list below, so only show them collapsed. */}
            <Show when={!props.focused && formatBackgroundJobsCounts(props.jobs)}>
              {(counts) => (
                <text style={{ fg: theme.textMuted }} wrapMode="none">
                  {counts()}
                </text>
              )}
            </Show>
          </box>
          <Show
            when={props.focused}
            fallback={
              <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                ↓ inspect
                <Show when={shortcut()}>
                  <span> · {shortcut()}</span>
                </Show>
              </text>
            }
          >
            <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
              ↑/↓ select · Enter open · Esc close
            </text>
          </Show>
        </box>

        <Show when={props.focused}>
          <box flexDirection="column">
            <For each={ordered()}>
              {(job) => {
                const selected = () => props.selectedID === job.id
                const meta = () => formatBackgroundJobMeta(job, props.now)
                return (
                  <box
                    flexDirection="row"
                    justifyContent="space-between"
                    gap={2}
                    backgroundColor={selected() ? theme.primary : theme.backgroundPanel}
                    onMouseUp={() => props.onSelect?.(job.id)}
                  >
                    <text
                      wrapMode="none"
                      fg={
                        selected()
                          ? theme.selectedListItemText
                          : job.status === "error"
                            ? theme.error
                            : theme.text
                      }
                    >
                      {backgroundJobGlyph(job)} {Locale.truncate(formatBackgroundJobTitle(job), titleBudget())}
                    </text>
                    <text wrapMode="none" fg={selected() ? theme.selectedListItemText : theme.textMuted}>
                      {meta()}
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </box>
    </box>
  )
}

export function BackgroundJobTraceDialog(props: {
  title: string
  job: () => BackgroundJobListItem | undefined
  now: () => number
  input: () => { command?: string; workdir?: string }
}) {
  const { theme } = useTheme()
  const dialog = useDialog()

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Close worker details",
        group: "Dialog",
        cmd: () => dialog.clear(),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>
          <b>{props.job() ? formatBackgroundJobTitle(props.job()!) : props.title}</b>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{props.job() ? formatBackgroundJobTrace(props.job()!, props.now(), props.input()) : "Worker no longer available"}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}
