export * as PluginBoot from "./boot"

import type { Plugin as PublicPlugin, PluginHost } from "@opencode-ai/plugin/v2/effect"
import type {
  AgentV2Info,
  CommandV2Info,
  Event as SDKEvent,
  IntegrationInfo,
  ModelV2Info,
  ProviderV2Info,
  ReferenceInfo,
  SkillV2Info,
} from "@opencode-ai/sdk/v2/types"
import { Context, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { Integration } from "../integration"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { CommandV2 } from "../command"
import { Config } from "../config"
import { ConfigAgentPlugin } from "../config/plugin/agent"
import { ConfigCommandPlugin } from "../config/plugin/command"
import { ConfigSkillPlugin } from "../config/plugin/skill"
import { ConfigReferencePlugin } from "../config/plugin/reference"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { FileSystem } from "../filesystem"
import { Global } from "../global"
import { Location } from "../location"
import { ModelsDev } from "../models-dev"
import { ModelV2 } from "../model"
import { Npm } from "../npm"
import { PluginV2 } from "../plugin"
import { AgentPlugin } from "./agent"
import { CommandPlugin } from "./command"
import { SkillPlugin } from "./skill"
import { ConfigProviderPlugin } from "../config/plugin/provider"
import { ModelsDevPlugin } from "./models-dev"
import { ProviderPlugins } from "./provider"
import { SkillV2 } from "../skill"
import { Reference } from "../reference"
import { ProviderV2 } from "../provider"

type PublicAgentDraft = Parameters<Parameters<PluginHost["agent"]["transform"]>[0]>[0]
type PublicCatalogDraft = Parameters<Parameters<PluginHost["catalog"]["transform"]>[0]>[0]
type PublicIntegrationDraft = Parameters<Parameters<PluginHost["integration"]["transform"]>[0]>[0]
type PublicIntegrationMethod = ReturnType<PublicIntegrationDraft["method"]["list"]>[number]
type PublicSkillDraft = Parameters<Parameters<PluginHost["skill"]["transform"]>[0]>[0]
type PublicSkillSource = Parameters<PublicSkillDraft["source"]>[0]
type EventMap = { [Item in SDKEvent as Item["type"]]: Item }

type InternalPlugin = {
  id: PluginV2.ID
  effect: PluginV2.Effect<
    | Catalog.Service
    | CommandV2.Service
    | Integration.Service
    | AgentV2.Service
    | Npm.Service
    | EventV2.Service
    | FSUtil.Service
    | FileSystem.Service
    | Global.Service
    | Location.Service
    | Config.Service
    | ModelsDev.Service
    | SkillV2.Service
    | Reference.Service
  >
}

export interface Interface {
  readonly add: (plugin: PublicPlugin) => Effect.Effect<void>
  readonly wait: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/PluginBoot") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const commands = yield* CommandV2.Service
    const plugin = yield* PluginV2.Service
    const integration = yield* Integration.Service
    const agents = yield* AgentV2.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const modelsDev = yield* ModelsDev.Service
    const npm = yield* Npm.Service
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const filesystem = yield* FileSystem.Service
    const global = yield* Global.Service
    const skill = yield* SkillV2.Service
    const reference = yield* Reference.Service
    const host: PluginHost = {
      agent: {
        get: (id) =>
          agents
            .get(AgentV2.ID.make(id))
            .pipe(Effect.map((value) => value && encode<AgentV2Info>(AgentV2.Info, value))),
        default: () => agents.default().pipe(Effect.map((value) => value && encode<AgentV2Info>(AgentV2.Info, value))),
        list: () =>
          agents.all().pipe(Effect.map((items) => items.map((value) => encode<AgentV2Info>(AgentV2.Info, value)))),
        rebuild: agents.rebuild,
        transform: (callback) => agents.transform((draft) => callback(agentDraft(draft))),
      },
      catalog: {
        provider: {
          get: (id) => optional(catalog.provider.get(ProviderV2.ID.make(id)), ProviderV2.Info),
          list: () =>
            catalog.provider
              .all()
              .pipe(Effect.map((items) => items.map((value) => encode<ProviderV2Info>(ProviderV2.Info, value)))),
          available: () =>
            catalog.provider
              .available()
              .pipe(Effect.map((items) => items.map((value) => encode<ProviderV2Info>(ProviderV2.Info, value)))),
        },
        model: {
          get: (providerID, modelID) =>
            optional(catalog.model.get(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)), ModelV2.Info),
          list: () =>
            catalog.model
              .all()
              .pipe(Effect.map((items) => items.map((value) => encode<ModelV2Info>(ModelV2.Info, value)))),
          available: () =>
            catalog.model
              .available()
              .pipe(Effect.map((items) => items.map((value) => encode<ModelV2Info>(ModelV2.Info, value)))),
          default: () =>
            catalog.model
              .default()
              .pipe(
                Effect.map(
                  (value) => Option.map(value, (item) => encode<ModelV2Info>(ModelV2.Info, item)).valueOrUndefined,
                ),
              ),
          small: (providerID) =>
            catalog.model
              .small(ProviderV2.ID.make(providerID))
              .pipe(
                Effect.map(
                  (value) => Option.map(value, (item) => encode<ModelV2Info>(ModelV2.Info, item)).valueOrUndefined,
                ),
              ),
        },
        rebuild: catalog.rebuild,
        transform: (callback) => catalog.transform((draft) => callback(catalogDraft(draft))),
      },
      command: {
        get: (name) =>
          commands.get(name).pipe(Effect.map((value) => value && encode<CommandV2Info>(CommandV2.Info, value))),
        list: () =>
          commands
            .list()
            .pipe(Effect.map((items) => items.map((value) => encode<CommandV2Info>(CommandV2.Info, value)))),
        rebuild: commands.rebuild,
        transform: commands.transform,
      },
      event: eventDomain(events),
      filesystem,
      integration: {
        get: (id) =>
          integration
            .get(Integration.ID.make(id))
            .pipe(Effect.map((value) => value && encode<IntegrationInfo>(Integration.Info, value))),
        list: () =>
          integration
            .list()
            .pipe(Effect.map((items) => items.map((value) => encode<IntegrationInfo>(Integration.Info, value)))),
        rebuild: integration.rebuild,
        transform: (callback) => integration.transform((draft) => callback(integrationDraft(draft))),
      },
      location,
      npm,
      path: {
        home: global.home,
        data: global.data,
        cache: global.cache,
        config: global.config,
        state: global.state,
        temp: global.tmp,
      },
      reference: {
        list: () =>
          reference
            .list()
            .pipe(Effect.map((items) => items.map((value) => encode<ReferenceInfo>(Reference.Info, value)))),
        rebuild: reference.rebuild,
        transform: reference.transform,
      },
      skill: {
        sources: () =>
          skill
            .sources()
            .pipe(Effect.map((items) => items.map((value) => encode<PublicSkillSource>(SkillV2.Source, value)))),
        list: () =>
          skill.list().pipe(Effect.map((items) => items.map((value) => encode<SkillV2Info>(SkillV2.Info, value)))),
        rebuild: skill.rebuild,
        transform: skill.transform,
      },
    }
    const done = yield* Deferred.make<void>()

    const add = Effect.fn("PluginBoot.add")(function* (input: InternalPlugin) {
      const executable = typeof input.effect === "function" ? input.effect(host) : input.effect
      yield* plugin.add({
        id: input.id,
        effect: executable.pipe(
          Effect.provideService(Catalog.Service, catalog),
          Effect.provideService(CommandV2.Service, commands),
          Effect.provideService(Integration.Service, integration),
          Effect.provideService(AgentV2.Service, agents),
          Effect.provideService(Config.Service, config),
          Effect.provideService(Location.Service, location),
          Effect.provideService(ModelsDev.Service, modelsDev),
          Effect.provideService(Npm.Service, npm),
          Effect.provideService(EventV2.Service, events),
          Effect.provideService(FSUtil.Service, fs),
          Effect.provideService(FileSystem.Service, filesystem),
          Effect.provideService(Global.Service, global),
          Effect.provideService(SkillV2.Service, skill),
          Effect.provideService(Reference.Service, reference),
        ),
      })
    })

    const boot = Effect.gen(function* () {
      yield* add(AgentPlugin.Plugin)
      yield* add(CommandPlugin.Plugin)
      yield* add(SkillPlugin.Plugin)
      yield* add(ModelsDevPlugin)
      yield* add(ConfigProviderPlugin.Plugin)
      yield* add(ConfigAgentPlugin.Plugin)
      yield* add(ConfigCommandPlugin.Plugin)
      yield* add(ConfigSkillPlugin.Plugin)
      yield* add(ConfigReferencePlugin.Plugin)
      for (const item of ProviderPlugins) {
        yield* add(item)
      }
    }).pipe(Effect.withSpan("PluginBoot.boot"))

    yield* boot.pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(done, exit)),
      Effect.forkScoped,
    )

    return Service.of({
      add: (input) =>
        Deferred.await(done).pipe(
          Effect.andThen(
            plugin.add({
              id: PluginV2.ID.make(input.id),
              effect: input.effect(host),
            }),
          ),
        ),
      wait: () => Deferred.await(done),
    })
  }),
)

export const locationLayer = layer.pipe(
  Layer.provideMerge(Integration.locationLayer),
  Layer.provideMerge(Catalog.locationLayer),
  Layer.provideMerge(CommandV2.locationLayer),
  Layer.provideMerge(Config.locationLayer),
  Layer.provideMerge(AgentV2.locationLayer),
  Layer.provideMerge(SkillV2.locationLayer),
  Layer.provideMerge(Reference.locationLayer),
  Layer.provideMerge(FileSystem.locationLayer),
)

function eventDomain(events: EventV2.Interface): PluginHost["event"] {
  return {
    subscribe: <Type extends keyof EventMap>(type: Type): Stream.Stream<EventMap[Type]> =>
      Stream.unwrap(
        Effect.sync(() => {
          const definition = EventV2.registry.get(type)
          if (!definition) throw new Error(`Unknown event type: ${type}`)
          const encode = Schema.encodeUnknownSync(definition.data as Schema.Codec<unknown, unknown, never, never>)
          return events.subscribe(definition).pipe(
            Stream.map(
              (event) =>
                ({
                  id: event.id,
                  type: event.type,
                  properties: encode(event.data),
                }) as unknown as EventMap[Type],
            ),
          )
        }),
      ),
  }
}

function agentDraft(draft: AgentV2.Draft): PublicAgentDraft {
  return {
    list: () => draft.list().map((value) => encode<AgentV2Info>(AgentV2.Info, value)),
    get: (id) => {
      const value = draft.get(AgentV2.ID.make(id))
      return value && encode<AgentV2Info>(AgentV2.Info, value)
    },
    default: (id) => draft.default(id === undefined ? undefined : AgentV2.ID.make(id)),
    update: (id, update) =>
      draft.update(AgentV2.ID.make(id), (value) => {
        const encoded = encode<AgentV2Info>(AgentV2.Info, value)
        update(encoded)
        Object.assign(value, Schema.decodeUnknownSync(AgentV2.Info)(encoded))
      }),
    remove: (id) => draft.remove(AgentV2.ID.make(id)),
  }
}

function catalogDraft(draft: Catalog.Draft): PublicCatalogDraft {
  return {
    provider: {
      list: () =>
        draft.provider.list().map((record) => ({
          provider: encode<ProviderV2Info>(ProviderV2.Info, record.provider),
          models: new Map(Array.from(record.models, ([id, model]) => [id, encode<ModelV2Info>(ModelV2.Info, model)])),
        })),
      get: (providerID) => {
        const record = draft.provider.get(ProviderV2.ID.make(providerID))
        if (!record) return
        return {
          provider: encode<ProviderV2Info>(ProviderV2.Info, record.provider),
          models: new Map(Array.from(record.models, ([id, model]) => [id, encode<ModelV2Info>(ModelV2.Info, model)])),
        }
      },
      update: (providerID, update) =>
        draft.provider.update(ProviderV2.ID.make(providerID), (value) => {
          const encoded = encode<ProviderV2Info>(ProviderV2.Info, value)
          update(encoded)
          Object.assign(value, Schema.decodeUnknownSync(ProviderV2.Info)(encoded))
        }),
      remove: (providerID) => draft.provider.remove(ProviderV2.ID.make(providerID)),
    },
    model: {
      get: (providerID, modelID) => {
        const value = draft.model.get(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))
        return value && encode<ModelV2Info>(ModelV2.Info, value)
      },
      update: (providerID, modelID, update) =>
        draft.model.update(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID), (value) => {
          const encoded = encode<ModelV2Info>(ModelV2.Info, value)
          update(encoded)
          Object.assign(value, Schema.decodeUnknownSync(ModelV2.Info)(encoded))
        }),
      remove: (providerID, modelID) => draft.model.remove(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
      default: {
        get: draft.model.default.get,
        set: (providerID, modelID) => draft.model.default.set(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
      },
    },
  }
}

function integrationDraft(draft: Integration.Draft): PublicIntegrationDraft {
  return {
    list: () => draft.list().map((value) => ({ id: value.id, name: value.name })),
    get: (id) => draft.get(Integration.ID.make(id)),
    update: (id, update) => draft.update(Integration.ID.make(id), update),
    remove: (id) => draft.remove(Integration.ID.make(id)),
    method: {
      list: (id) =>
        draft.method
          .list(Integration.ID.make(id))
          .map((method) => encode<PublicIntegrationMethod>(Integration.Method, method)),
      update: (input) => {
        if (input.method.type === "env") {
          draft.method.update({
            integrationID: Integration.ID.make(input.integrationID),
            method: { type: "env", names: [...input.method.names] },
          })
          return
        }
        draft.method.update({
          integrationID: Integration.ID.make(input.integrationID),
          method: { type: "key", label: input.method.label },
        })
      },
      remove: (id, method) =>
        draft.method.remove(Integration.ID.make(id), Schema.decodeUnknownSync(Integration.Method)(method)),
    },
  }
}

function encode<Output>(schema: Schema.Top, value: unknown): Output {
  const result = Schema.encodeUnknownSync(schema as Schema.Codec<unknown, unknown, never, never>)(value)
  return structuredClone(result) as Output
}

function optional<Output, E>(effect: Effect.Effect<unknown, E>, schema: Schema.Top): Effect.Effect<Output | undefined> {
  return effect.pipe(
    Effect.option,
    Effect.map((value) => Option.map(value, (item) => encode<Output>(schema, item)).valueOrUndefined),
  )
}
