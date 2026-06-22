import { render, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Deferred, Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { hotComponent, startHmrWatcher } from "./hmr"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ClipboardProvider, useClipboard } from "./context/clipboard"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider } from "./context/epilogue"
import { handleSelectionKey } from "./util/selection"
import { createCliRenderer } from "@opentui/core"
import { RouteProvider, useRoute, type Route } from "./context/route"
import {
  createEffect,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  on,
} from "solid-js"
import { TuiPathsProvider, TuiStartupProvider, TuiTerminalEnvironmentProvider } from "./context/runtime"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogProvider as DialogProviderList } from "./component/dialog-provider"
import { ErrorComponent } from "./component/error-component"
import { ProjectProvider, useProject } from "./context/project"
import { EditorContextProvider } from "./context/editor"
import { useEvent } from "./context/event"
import { SDKProvider, useSDK } from "./context/sdk"
import { SyncProvider, useSync } from "./context/sync"
import { DataProvider } from "./context/data"
import { LocalProvider, useLocal } from "./context/local"
import { ThemeProvider, useTheme } from "./context/theme"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { DialogConfirm } from "./ui/dialog-confirm"
import { ToastProvider, useToast } from "./ui/toast"
import { KVProvider, useKV } from "./context/kv"
import { parse } from "./util/model"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import { PromptRefProvider } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig, type TuiConfig } from "./config"
import { createTuiApiAdapters } from "./plugin/adapters"
import { createTuiApi } from "./plugin/api"
import { createPluginRuntime, PluginRuntimeProvider, usePluginRuntime, type TuiPluginHost } from "./plugin/runtime"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useOpencodeKeymap } from "./keymap"

import type { EventSource } from "./context/sdk"
import { createTuiAttention } from "./attention"
import { dispose } from "./audio"
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./terminal-win32"
import { destroyRenderer } from "./util/renderer"
import { cliErrorMessage, errorFormat } from "./util/error"
import { AppView, type AppViewProps } from "./app-view"
import { isRecord } from "./util/record"

const hmrRoots = [{ id: "app-view.tsx#AppView", file: "app-view.tsx", exportName: "AppView" }] as const
const HotAppView = hotComponent<AppViewProps>(hmrRoots[0].id, AppView)

export type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  restart?: {
    preserveScreen?: boolean
    adoptAlternateScreen?: boolean
    wasRestarted?: boolean
    initialRoute?: unknown
    fastBoot?: boolean
  }
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  pluginHost: TuiPluginHost
}

export type TuiResult = { type: "exit" } | { type: "restart"; route: Route }

type TuiRestartReason = { type: "restart"; route: Route }

function isRoute(value: unknown): value is Route {
  if (!isRecord(value)) return false
  if (value.type === "home") return true
  if (value.type === "session") return typeof value.sessionID === "string"
  if (value.type === "plugin") return typeof value.id === "string"
  return false
}

function isRestartReason(reason: unknown): reason is TuiRestartReason {
  if (!isRecord(reason)) return false
  if (reason.type !== "restart") return false
  return isRoute(reason.route)
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return error instanceof Error ? error.message : String(error)
}

function isVersionGreater(left: string, right: string) {
  const parse = (value: string) => {
    const [core, prerelease] = value.replace(/^v/, "").split("-", 2)
    return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), prerelease }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference) return difference > 0
  }
  if (a.prerelease === b.prerelease) return false
  if (!a.prerelease) return true
  if (!b.prerelease) return false
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true }) > 0
}

export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const global = yield* Global.Service
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          createCliRenderer({
            ...(input.restart?.adoptAlternateScreen ? { screenMode: "main-screen" as const } : {}),
            externalOutputMode: "passthrough",
            targetFps: 60,
            gatherStats: false,
            exitOnCtrlC: false,
            useKittyKeyboard: {},
            autoFocus: false,
            openConsoleOnError: false,
            useMouse: !Flag.OPENCODE_DISABLE_MOUSE && input.config.mouse,
            consoleOptions: {
              keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
            },
          }),
        ),
        (renderer) =>
          Effect.sync(() => {
            if (input.restart?.preserveScreen && isRestartReason(exit.reason)) return
            destroyRenderer(renderer, { adoptedAlternateScreen: input.restart?.adoptAlternateScreen === true })
          }),
      )
      win32DisableProcessedInput()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerOpencodeKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await input.pluginHost.dispose()
          } catch (error) {
            console.error("Failed to dispose TUI plugins", error)
          }
        }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(dispose))
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () =>
        destroyRenderer(renderer, { adoptedAlternateScreen: input.restart?.adoptAlternateScreen === true })
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))
      const pluginRuntime = createPluginRuntime()
      const restarted = input.restart?.wasRestarted === true

      // Start HMR file watcher for the hot app view boundary.
      const stopHmr = yield* Effect.tryPromise(() => startHmrWatcher({ srcDir: import.meta.dir, roots: hmrRoots })).pipe(
        Effect.map((stop) => stop ?? (() => {})),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => stopHmr()))

      yield* Effect.tryPromise(async () => {
        // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        const mode = input.restart?.adoptAlternateScreen
          ? (renderer.themeMode ?? "dark")
          : ((await renderer.waitForThemeMode(1000)) ?? "dark")
        if (renderer.isDestroyed) return

        await render(() => {
          return (
            <ExitProvider
              exit={(reason) => {
                if (renderer.isDestroyed) return
                exit.reason = reason
                if (input.restart?.preserveScreen && isRestartReason(reason)) {
                  renderer.stop()
                  Deferred.doneUnsafe(shutdown, Effect.void)
                  return
                }
                destroyRenderer(renderer, {
                  preserveScreen: isRestartReason(reason),
                  adoptedAlternateScreen: input.restart?.adoptAlternateScreen === true,
                })
              }}
            >
              <EpilogueProvider set={(value) => (exit.epilogue = value)}>
                <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}>
                  <TuiPathsProvider
                    value={{
                      cwd: process.cwd(),
                      home: global.home,
                      state: global.state,
                      worktree: global.data + "/worktree",
                    }}
                  >
                    <TuiTerminalEnvironmentProvider
                      value={{
                        platform: process.platform,
                        multiplexer: process.env.TMUX ? "tmux" : process.env.STY ? "screen" : undefined,
                        displayServer: process.env.WAYLAND_DISPLAY
                          ? "wayland"
                          : process.env.DISPLAY
                            ? "x11"
                            : undefined,
                      }}
                    >
                      <TuiStartupProvider
                        value={{
                          initialRoute: restarted ? input.restart?.initialRoute : undefined,
                          skipInitialLoading: restarted && input.restart?.fastBoot === true,
                        }}
                      >
                        <ClipboardProvider>
                          <OpencodeKeymapProvider keymap={keymap}>
                            <ArgsProvider {...input.args}>
                              <KVProvider>
                                <ToastProvider>
                                  <RouteProvider
                                    initialRoute={
                                      input.args.continue
                                        ? {
                                            type: "session",
                                            sessionID: "dummy",
                                          }
                                        : undefined
                                    }
                                  >
                                    <TuiConfigProvider config={input.config}>
                                      <PluginRuntimeProvider value={pluginRuntime}>
                                        <SDKProvider
                                          url={input.url}
                                          directory={input.directory}
                                          fetch={input.fetch}
                                          headers={input.headers}
                                          events={input.events}
                                        >
                                          <ProjectProvider>
                                            <SyncProvider>
                                              <DataProvider>
                                                <ThemeProvider mode={mode}>
                                                  <LocalProvider>
                                                    <PromptStashProvider>
                                                      <DialogProvider>
                                                        <FrecencyProvider>
                                                          <PromptHistoryProvider>
                                                            <PromptRefProvider>
                                                              <EditorContextProvider>
                                                                <App
                                                                  onSnapshot={input.onSnapshot}
                                                                  pluginHost={input.pluginHost}
                                                                />
                                                              </EditorContextProvider>
                                                            </PromptRefProvider>
                                                          </PromptHistoryProvider>
                                                        </FrecencyProvider>
                                                      </DialogProvider>
                                                    </PromptStashProvider>
                                                  </LocalProvider>
                                                </ThemeProvider>
                                              </DataProvider>
                                            </SyncProvider>
                                          </ProjectProvider>
                                        </SDKProvider>
                                      </PluginRuntimeProvider>
                                    </TuiConfigProvider>
                                  </RouteProvider>
                                </ToastProvider>
                              </KVProvider>
                            </ArgsProvider>
                          </OpencodeKeymapProvider>
                        </ClipboardProvider>
                      </TuiStartupProvider>
                    </TuiTerminalEnvironmentProvider>
                  </TuiPathsProvider>
                </ErrorBoundary>
              </EpilogueProvider>
            </ExitProvider>
          )
        }, renderer)
      })
      yield* Deferred.await(shutdown)
      return { epilogue: exit.epilogue, reason: exit.reason }
    }),
  )
  const output: TuiResult = isRestartReason(result.reason)
    ? { type: "restart", route: result.reason.route }
    : { type: "exit" }
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (output.type === "exit" && result.reason !== undefined)
      process.stderr.write((cliErrorMessage(result.reason) ?? errorFormat(result.reason)) + "\n")
    if (output.type === "exit" && result.epilogue) process.stdout.write(result.epilogue + "\n")
  })
  return output
})

function App(props: { onSnapshot?: () => Promise<string[]>; pluginHost: TuiPluginHost }) {
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useOpencodeKeymap()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const sync = useSync()
  const project = useProject()
  const exit = useExit()
  const pluginRuntime = usePluginRuntime()
  const attention = createTuiAttention({ renderer, config: tuiConfig, kv })
  const clipboard = useClipboard()

  const api = createTuiApi(
    createTuiApiAdapters({
      version: InstallationVersion,
      tuiConfig,
      dialog,
      keymap,
      kv,
      route,
      routes: pluginRuntime.routes,
      event,
      sdk,
      sync,
      theme: themeState,
      toast,
      renderer,
      attention,
      Slot: pluginRuntime.Slot,
    }),
  )
  const [ready, setReady] = createSignal(false)
  props.pluginHost
    .start({
      api,
      config: tuiConfig,
      runtime: pluginRuntime,
      dispose: () => attention.dispose(),
    })
    .catch((error) => {
      console.error("Failed to load TUI plugins", error)
    })
    .finally(() => {
      setReady(true)
    })

  // Let selection copy/dismiss win ahead of normal bindings when explicit copy is required.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      handleSelectionKey(renderer, toast, event, clipboard)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    attention.dispose()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await clipboard
      .write?.(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = parse(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0,
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  event.on("tui.command.execute", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    keymap.dispatchCommand(evt.properties.command)
  })

  event.on("tui.toast.show", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on("tui.session.select", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  event.on("installation.update-available", async (evt) => {
    console.log("installation.update-available", evt)
    const version = evt.properties.version

    const skipped = kv.get("skipped_version")
    if (skipped && !isVersionGreater(version, skipped)) return

    const choice = await DialogConfirm.show(
      dialog,
      `Update Available`,
      `A new release v${version} is available. Would you like to update now?`,
      "skip",
    )

    if (choice === false) {
      kv.set("skipped_version", version)
      return
    }

    if (choice !== true) return

    toast.show({
      variant: "info",
      message: `Updating to v${version}...`,
      duration: 30000,
    })

    const result = await sdk.client.global.upgrade({ target: version })

    if (result.error || !result.data?.success) {
      toast.show({
        variant: "error",
        title: "Update Failed",
        message: "Update failed",
        duration: 10000,
      })
      return
    }

    await DialogAlert.show(
      dialog,
      "Update Complete",
      `Successfully updated to OpenCode v${result.data.version}. Please restart the application.`,
    )

    void exit()
  })

  return <HotAppView ready={ready} onSnapshot={props.onSnapshot} />
}
