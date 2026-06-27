import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

const BACKGROUND_WORKERS_MARKER = "<background_workers>"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages
  yield* applyBackgroundWorkers(input, userMessage)

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

const applyBackgroundWorkers = Effect.fn("SessionReminders.applyBackgroundWorkers")(function* (
  input: {
    session: Session.Info
  },
  userMessage: SessionV1.WithParts,
) {
  userMessage.parts = userMessage.parts.filter(
    (part) => !(part.type === "text" && part.synthetic === true && part.text.includes(BACKGROUND_WORKERS_MARKER)),
  )
  const background = yield* BackgroundJob.Service
  const jobs = (yield* background.list()).filter(
    (job) =>
      job.status === "running" &&
      job.metadata?.background === true &&
      (stringMetadata(job.metadata, "parentSessionId") === input.session.id ||
        stringMetadata(job.metadata, "sessionId") === input.session.id),
  )
  if (jobs.length === 0) return
  userMessage.parts.push({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: renderBackgroundWorkers(jobs),
    synthetic: true,
  })
})

function renderBackgroundWorkers(jobs: BackgroundJob.Info[]) {
  return [
    BACKGROUND_WORKERS_MARKER,
    "The following background workers are still running. Coordinate around them; do not duplicate their work or poll for status unless the user asks.",
    ...jobs.map(renderBackgroundWorker),
    "</background_workers>",
  ].join("\n")
}

function renderBackgroundWorker(job: BackgroundJob.Info) {
  const tool = stringMetadata(job.metadata, "tool") ?? stringMetadata(job.metadata, "subagent") ?? job.type
  const summary = stringMetadata(job.metadata, "summary") ?? stringMetadata(job.metadata, "description") ?? job.title ?? tool
  const output = stringMetadata(job.metadata, "output")
  if (!output) return `- ${job.title ?? summary} (${tool}): ${summary}`
  return `- ${job.title ?? summary} (${tool}): ${summary}\n  latest output: ${truncate(output.trim(), 800)}`
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === "string" ? value : undefined
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

export * as SessionReminders from "./reminders"
