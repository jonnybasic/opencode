import { DynamicProviderPlugin } from "./provider/dynamic.js"
import { PromptCacheKeyPlugin } from "./provider/prompt-cache-key.js"
import type { PluginInternal } from "./internal.js"

export const ProviderPlugins: PluginInternal.InternalPlugin[] = [
  DynamicProviderPlugin,
  PromptCacheKeyPlugin,
]
