export * as ConfigSkillPlugin from "./skill"

import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { Global } from "../../global"
import { Location } from "../../location"
import { PluginV2 } from "../../plugin"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("config-skill"),
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const entries = yield* config.entries()
    const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
    const items = entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))

    yield* ctx.skill.transform((editor) => {
      for (const directory of directories) {
        editor.source(
          new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }),
        )
        editor.source(
          new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        )
      }
      for (const item of items) {
        if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
          editor.source(new SkillV2.UrlSource({ type: "url", url: item }))
          continue
        }
        const expanded = item.startsWith("~/") ? path.join(ctx.path.home, item.slice(2)) : item
        editor.source(
          new SkillV2.DirectorySource({
            type: "directory",
            path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(ctx.location.directory, expanded)),
          }),
        )
      }
    })
  }),
})
