import { Effect } from "effect"
import type { Npm } from "@opencode/util/npm"

const staticSDKs: Record<string, () => Promise<unknown>> = {
  "@ai-sdk/openai": () => import("@ai-sdk/openai"),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible"),
  "@ai-sdk/google": () => import("@ai-sdk/google"),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex"),
}

export const loadSDKFactory = Effect.fnUntraced(function* (_npm: Npm.Interface, packageName: string) {
  const loader = staticSDKs[packageName]
  if (loader) {
    const mod = (yield* Effect.promise(loader)) as Record<string, unknown>
    const match = Object.keys(mod).find((name) => name.startsWith("create"))
    if (!match) return yield* Effect.die(new Error(`Package ${packageName} has no provider factory export`))
    return mod[match]
  }

  return yield* Effect.die(
    new Error(`Dynamic package installation is disabled in the Enterprise Air-Gapped build: ${packageName}`),
  )
})
