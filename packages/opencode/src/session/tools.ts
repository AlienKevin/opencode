import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Deferred, Effect } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { BackgroundJob } from "@/background/job"

const BACKGROUND_TOOL_STARTED = [
  "This tool is still running in the background because the user submitted a new message.",
  "Continue with the user's latest message. You will be notified automatically when the tool finishes.",
].join("\n")

function backgroundToolJobID(sessionID: string, callID: string) {
  return `${sessionID}:tool:${callID}`
}

function stringArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function renderBackgroundTool(input: {
  tool: string
  callID: string
  state: "running" | "completed" | "error"
  text: string
}) {
  const tag = input.state === "error" ? "tool_error" : "tool_result"
  return [
    `<tool name="${input.tool}" call_id="${input.callID}" state="${input.state}">`,
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</tool>",
  ].join("\n")
}

type CompletedToolOutput = Parameters<SessionProcessor.Handle["completeToolCall"]>[1] & { content?: unknown }

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  background: BackgroundJob.Interface
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const background = input.background
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service

  const context = (
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    abort = options.abortSignal!,
  ): Tool.Context => ({
    sessionID: input.session.id,
    abort,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      Effect.all(
        [
          input.processor.updateToolCall(options.toolCallId, (match) => {
            if (!["running", "pending"].includes(match.state.status)) return match
            return {
              ...match,
              state: {
                title: val.title,
                metadata: val.metadata,
                status: "running",
                input: args,
                time: { start: Date.now() },
              },
            }
          }),
          background
            .update({
              id: backgroundToolJobID(input.session.id, options.toolCallId),
              title: val.title,
              metadata: val.metadata,
            })
            .pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  const notifyBackgroundTool = Effect.fn("SessionTools.notifyBackgroundTool")(function* (job: {
    jobID: string
    tool: string
    callID: string
  }) {
    yield* Effect.sync(() =>
      run.fork(
        background.wait({ id: job.jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") {
              return input.promptOps
                .prompt({
                  sessionID: input.session.id,
                  agent: input.session.agent ?? input.agent.name,
                  parts: [
                    {
                      type: "text",
                      synthetic: true,
                      text: renderBackgroundTool({
                        tool: job.tool,
                        callID: job.callID,
                        state: "completed",
                        text: result.info.output ?? "",
                      }),
                    },
                  ],
                })
                .pipe(Effect.asVoid)
            }
            if (result.info?.status === "error") {
              return input.promptOps
                .prompt({
                  sessionID: input.session.id,
                  agent: input.session.agent ?? input.agent.name,
                  parts: [
                    {
                      type: "text",
                      synthetic: true,
                      text: renderBackgroundTool({
                        tool: job.tool,
                        callID: job.callID,
                        state: "error",
                        text: result.info.error ?? "Tool failed",
                      }),
                    },
                  ],
                })
                .pipe(Effect.asVoid)
            }
            return Effect.void
          }),
          Effect.ignore,
        ),
      ),
    ).pipe(Effect.asVoid)
  })

  const runPromotableTool = Effect.fn("SessionTools.runPromotableTool")(function* (toolInput: {
    tool: string
    callID: string
    args: Record<string, unknown>
    abort: AbortSignal
    run: (abort: AbortSignal) => Effect.Effect<CompletedToolOutput>
  }) {
    const jobID = backgroundToolJobID(input.session.id, toolInput.callID)
    const done = yield* Deferred.make<CompletedToolOutput, unknown>()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    const removeAbort = Effect.sync(() => toolInput.abort.removeEventListener("abort", onAbort))
    yield* Effect.sync(() => {
      if (toolInput.abort.aborted) {
        controller.abort()
        return
      }
      toolInput.abort.addEventListener("abort", onAbort, { once: true })
    })
    const description = stringArg(toolInput.args, "description")
    const command = stringArg(toolInput.args, "command")
    const workdir = stringArg(toolInput.args, "workdir")
    const metadata = {
      sessionId: input.session.id,
      messageId: input.processor.message.id,
      tool: toolInput.tool,
      callId: toolInput.callID,
      worker: "tool",
      summary: description ?? toolInput.tool,
      ...(description ? { description } : {}),
      ...(command ? { command } : {}),
      ...(workdir ? { workdir } : {}),
    }
    yield* background.start({
      id: jobID,
      type: "tool",
      title: description ?? toolInput.tool,
      metadata,
      onPromote: Effect.all(
        [
          removeAbort,
          input.processor.updateToolCall(toolInput.callID, (part) => {
            if (part.state.status !== "running") return part
            return {
              ...part,
              state: {
                ...part.state,
                metadata: { ...(part.state.metadata ?? {}), background: true, jobId: jobID },
              },
            }
          }),
          notifyBackgroundTool({ jobID, tool: toolInput.tool, callID: toolInput.callID }),
        ],
        { discard: true },
      ),
      run: toolInput.run(controller.signal).pipe(
        Effect.matchCauseEffect({
          onSuccess: (output) =>
            Deferred.succeed(done, output).pipe(
              Effect.andThen(
                toolInput.abort.aborted ? input.processor.completeToolCall(toolInput.callID, output) : Effect.void,
              ),
              Effect.as(output.output),
            ),
          onFailure: (cause) => Deferred.failCause(done, cause).pipe(Effect.andThen(Effect.failCause(cause))),
        }),
        Effect.ensuring(Effect.all([removeAbort, Effect.sync(() => controller.abort())], { discard: true })),
      ),
    })

    const result = yield* Effect.raceFirst(
      Deferred.await(done).pipe(Effect.map((output) => ({ type: "completed" as const, output }))),
      background.waitForPromotion(jobID).pipe(Effect.as({ type: "promoted" as const })),
    )

    if (result.type === "completed") return result.output
    return {
      title: description ?? toolInput.tool,
      metadata: { background: true, jobId: jobID, summary: description ?? toolInput.tool },
      output: renderBackgroundTool({
        tool: toolInput.tool,
        callID: toolInput.callID,
        state: "running",
        text: BACKGROUND_TOOL_STARTED,
      }),
    }
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const output = yield* runPromotableTool({
              tool: item.id,
              callID: options.toolCallId,
              args,
              abort: options.abortSignal!,
              run: (abort) =>
                Effect.gen(function* () {
                  const ctx = context(args, options, abort)
                  yield* plugin.trigger(
                    "tool.execute.before",
                    { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                    { args },
                  )
                  const result = yield* item.execute(args, ctx)
                  const output = {
                    ...result,
                    attachments: result.attachments?.map((attachment) => ({
                      ...attachment,
                      id: PartID.ascending(),
                      sessionID: ctx.sessionID,
                      messageID: input.processor.message.id,
                    })),
                  }
                  yield* plugin.trigger(
                    "tool.execute.after",
                    { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                    output,
                  )
                  return output
                }),
            })
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const output = yield* runPromotableTool({
            tool: key,
            callID: opts.toolCallId,
            args,
            abort: opts.abortSignal!,
            run: (abort) =>
              Effect.gen(function* () {
                const ctx = context(args, opts, abort)
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
                  { args },
                )
                const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
                  yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
                  return yield* Effect.promise(() => execute(args, opts))
                }).pipe(
                  Effect.withSpan("Tool.execute", {
                    attributes: {
                      "tool.name": key,
                      "tool.call_id": opts.toolCallId,
                      "session.id": ctx.sessionID,
                      "message.id": input.processor.message.id,
                    },
                  }),
                )
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
                  result,
                )

                const textParts: string[] = []
                const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
                for (const contentItem of result.content) {
                  if (contentItem.type === "text") textParts.push(contentItem.text)
                  else if (contentItem.type === "image") {
                    attachments.push({
                      type: "file",
                      mime: contentItem.mimeType,
                      url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                    })
                  } else if (contentItem.type === "resource") {
                    const { resource } = contentItem
                    if (resource.text) textParts.push(resource.text)
                    if (resource.blob) {
                      attachments.push({
                        type: "file",
                        mime: resource.mimeType ?? "application/octet-stream",
                        url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                        filename: resource.uri,
                      })
                    }
                  }
                }

                const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
                const metadata = {
                  ...result.metadata,
                  truncated: truncated.truncated,
                  ...(truncated.truncated && { outputPath: truncated.outputPath }),
                }

                return {
                  title: "",
                  metadata,
                  output: truncated.content,
                  attachments: attachments.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                  content: result.content,
                }
              }),
          })
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

export * as SessionTools from "./tools"
