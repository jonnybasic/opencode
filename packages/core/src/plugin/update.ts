export * as PluginUpdate from "./update.js"

import { Context, Effect, Layer, Stream } from "effect"
import { Npm } from "@opencode/util/npm"
import { type EffectFlock } from "@opencode/util/effect-flock"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

interface Change {
  readonly target: string
  readonly outdated: boolean
  readonly updating: boolean
}

export interface Interface {
  readonly check: (target: string, options?: { readonly refresh?: boolean }) => Effect.Effect<boolean>
  readonly update: (target: string) => Effect.Effect<void, Npm.InstallFailedError | EffectFlock.LockError>
  readonly changes: () => Stream.Stream<Change>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PluginUpdate") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    check: () => Effect.succeed(false),
    update: () => Effect.void,
    changes: () => Stream.empty,
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Npm.node] })
