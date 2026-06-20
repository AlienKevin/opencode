import type { Effect, Scope } from "effect"
import type { PluginHost } from "./host.js"

export interface Plugin {
  readonly id: string
  readonly effect: (host: PluginHost) => Effect.Effect<void, never, Scope.Scope>
}

export function define(plugin: Plugin) {
  return plugin
}
