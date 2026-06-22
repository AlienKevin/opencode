import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "../tui/worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { EventSource } from "@opencode-ai/tui/context/sdk"
import type { TuiResult } from "@opencode-ai/tui"
import { writeHeapSnapshot } from "v8"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@opencode-ai/tui/terminal-win32"

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

function restartEnvironment(route: Extract<TuiResult, { type: "restart" }>["route"]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  env.OPENCODE_FAST_BOOT = "1"
  env.OPENCODE_RESTART = "1"
  env.OPENCODE_ROUTE = JSON.stringify(route)
  delete env.OPENCODE_ADOPT_ALT_SCREEN
  delete env.OPENCODE_RESTART_PID
  return env
}

function restartRoute(value: string | undefined) {
  if (!value) return
  try {
    return JSON.parse(value) as unknown
  } catch {
    return
  }
}

async function restart(result: Extract<TuiResult, { type: "restart" }>, cwd: string) {
  const env = restartEnvironment(result.route)
  const argv = [process.execPath, ...process.argv.slice(1)]
  process.chdir(cwd)
  const execve = Reflect.get(process, "execve")
  if (typeof execve === "function") {
    env.OPENCODE_ADOPT_ALT_SCREEN = "1"
    env.OPENCODE_RESTART_PID = String(process.pid)
    execve.call(process, process.execPath, argv, env)
    throw new Error("process.execve returned unexpectedly")
  }

  const proc = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return proc.exited
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      }),
  handler: async (args) => {
    const startCwd = Filesystem.resolve(process.cwd())
    const unguard = win32InstallCtrlCGuard()
    let unguarded = false
    const cleanupGuard = () => {
      if (unguarded) return
      unguarded = true
      try {
        unguard?.()
      } catch {}
    }
    try {
      const { TuiConfig } = await import("@/config/tui")
      const restartPID = process.env.OPENCODE_RESTART_PID
      const restarted = process.env.OPENCODE_RESTART === "1" && (!restartPID || restartPID === String(process.pid))
      const initialRoute = restarted ? restartRoute(process.env.OPENCODE_ROUTE) : undefined
      const fastBoot = restarted && process.env.OPENCODE_FAST_BOOT === "1"
      const adoptAlternateScreen = restarted && process.env.OPENCODE_ADOPT_ALT_SCREEN === "1"
      const execRestart = typeof Reflect.get(process, "execve") === "function"
      delete process.env.OPENCODE_ADOPT_ALT_SCREEN
      delete process.env.OPENCODE_FAST_BOOT
      delete process.env.OPENCODE_RESTART
      delete process.env.OPENCODE_RESTART_PID
      delete process.env.OPENCODE_ROUTE
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      const file = await target()
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      const worker = new Worker(file)
      const client = Rpc.client<typeof rpc>(worker)
      const reload = () => {
        client.call("reload", undefined).catch(() => {})
      }
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("SIGUSR2", reload)
        await withTimeout(client.call("shutdown", undefined), 5000).catch(() => {})
        worker.terminate()
      }

      const prompt = restarted ? undefined : await input(args.prompt)
      const config = await TuiConfig.get()

      const network = resolveNetworkOptionsNoConfig(args)
      const external =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"

      const transport = external
        ? {
            url: (await client.call("server", network)).url,
            fetch: undefined,
            events: undefined,
          }
        : {
            url: "http://opencode.internal",
            fetch: createWorkerFetch(client),
            events: createEventSource(client),
          }

      if (!restarted) {
        try {
          await validateSession({
            url: transport.url,
            sessionID: args.session,
            directory: cwd,
            fetch: transport.fetch,
          })
        } catch (error) {
          UI.error(errorMessage(error))
          process.exitCode = 1
          return
        }
      }

      setTimeout(() => {
        client.call("checkUpgrade", { directory: cwd }).catch(() => {})
      }, 1000).unref?.()

      let result: TuiResult = { type: "exit" }
      try {
        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        result = await Effect.runPromise(
          run({
            url: transport.url,
            async onSnapshot() {
              const tui = writeHeapSnapshot("tui.heapsnapshot")
              const server = await client.call("snapshot", undefined)
              return [tui, server]
            },
            config,
            restart: { preserveScreen: execRestart, adoptAlternateScreen, wasRestarted: restarted, initialRoute, fastBoot },
            pluginHost: createLegacyTuiPluginHost(),
            directory: cwd,
            fetch: transport.fetch,
            events: transport.events,
            args: {
              continue: restarted ? false : args.continue,
              sessionID: restarted ? undefined : args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: restarted ? false : args.fork,
            },
          }),
        )
      } finally {
        await stop()
      }
      if (result.type === "restart") {
        cleanupGuard()
        process.exit(await restart(result, startCwd))
      }
    } finally {
      cleanupGuard()
    }
    process.exit(0)
  },
})
// scratch
