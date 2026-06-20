import { Effect } from "effect"
import { PluginV2 } from "../../plugin"

export const LLMGatewayPlugin = PluginV2.define({
  id: PluginV2.ID.make("llmgateway"),
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.disabled) continue
          if (!(yield* ctx.integration.get(item.provider.id))) continue
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://api.llmgateway.io/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] = "https://opencode.ai/"
            provider.request.headers["X-Title"] = "opencode"
            provider.request.headers["X-Source"] = "opencode"
          })
        }
      }),
    )
  }),
})
