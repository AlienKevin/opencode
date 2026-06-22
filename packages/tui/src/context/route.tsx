import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      props.initialRoute ?? initialRoute(startup.initialRoute) ?? { type: "home" },
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(route))
      },
    }
  },
})

export function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  const prompt = "prompt" in value ? initialPrompt(value.prompt) : undefined
  if (value.type === "home") return { type: "home", ...(prompt ? { prompt } : {}) }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID, ...(prompt ? { prompt } : {}) }
  }
  if (value.type === "plugin" && "id" in value && typeof value.id === "string") {
    return { type: "plugin", id: value.id }
  }
}

function initialPrompt(value: unknown): PromptInfo | undefined {
  if (!value || typeof value !== "object") return
  if (!("input" in value) || typeof value.input !== "string") return
  if (!("parts" in value) || !Array.isArray(value.parts)) return
  const mode = "mode" in value && (value.mode === "normal" || value.mode === "shell") ? value.mode : undefined
  return { input: value.input, parts: value.parts as PromptInfo["parts"], ...(mode ? { mode } : {}) }
}

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
