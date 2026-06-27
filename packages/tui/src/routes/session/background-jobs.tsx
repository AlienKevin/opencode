import { createSignal, Show } from "solid-js"
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

function sameLabel(a: string | undefined, b: string | undefined) {
  return a?.trim().toLowerCase() === b?.trim().toLowerCase()
}

export function formatBackgroundJobTitle(job: BackgroundJobListItem) {
  if (job.title) return job.title
  if (job.summary) return job.summary
  return Locale.titlecase(jobTool(job))
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

export function formatBackgroundJobsFooterSummary(jobs: BackgroundJobListItem[], now: number) {
  const counts = [
    statusCount(jobs, "running") > 0
      ? `${Locale.pluralize(statusCount(jobs, "running"), "{} running", "{} running")}`
      : undefined,
    statusCount(jobs, "error") > 0
      ? `${Locale.pluralize(statusCount(jobs, "error"), "{} failed", "{} failed")}`
      : undefined,
    statusCount(jobs, "cancelled") > 0
      ? `${Locale.pluralize(statusCount(jobs, "cancelled"), "{} cancelled", "{} cancelled")}`
      : undefined,
    statusCount(jobs, "completed") > 0
      ? `${Locale.pluralize(statusCount(jobs, "completed"), "{} completed", "{} completed")}`
      : undefined,
  ].filter((part): part is string => part !== undefined)
  const focus =
    jobs.find((job) => job.status === "error") ??
    jobs.find((job) => job.status === "running") ??
    jobs.find((job) => job.status === "cancelled") ??
    jobs.find((job) => job.status === "completed")
  const summary = focus && !sameLabel(focus.summary, formatBackgroundJobTitle(focus)) ? focus.summary : undefined
  const fallback = focus ? backgroundJobDetails(focus)[0] : undefined
  return [
    counts.join(", "),
    focus
      ? Locale.truncate(`${formatBackgroundJobTitle(focus)}: ${summary ?? fallback ?? formatBackgroundJobStatus(focus, now)}`, 80)
      : undefined,
  ]
    .filter((part): part is string => !!part)
    .join(" · ")
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
  onClick: () => void
}) {
  const { theme } = useTheme()
  const shortcut = useCommandShortcut("session.background.jobs")
  const [hover, setHover] = createSignal(false)
  useTerminalDimensions()

  const hasError = () => props.jobs.some((job) => job.severity === "error" || job.status === "error")

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
      >
        <box
          flexDirection="row"
          justifyContent="space-between"
          gap={1}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => props.onClick()}
          backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
        >
          <box flexDirection="row" gap={1}>
            <text fg={hasError() ? theme.error : theme.text}>
              <b>Workers</b>
            </text>
            <text style={{ fg: theme.textMuted }} wrapMode="none">
              ({formatBackgroundJobsFooterSummary(props.jobs, props.now)})
            </text>
          </box>
          <text fg={theme.text}>
            View
            <Show when={shortcut()}>
              <span style={{ fg: theme.textMuted }}> {shortcut()}</span>
            </Show>
          </text>
        </box>
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
