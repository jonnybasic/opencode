import { Context, Effect, Layer } from "effect"
import type { Policy } from "./updater-action"

export const methods = ["curl", "npm", "pnpm", "bun", "yarn", "vp", "brew"] as const

export type Method = (typeof methods)[number]
export type RunResult = { readonly type: "available" | "installed"; readonly version: string }
export type CheckResult = RunResult | { readonly type: "unavailable"; readonly message: string }

export class UpgradeError extends Error {
  readonly title: string
  readonly detail: string
  readonly command?: string
  readonly retry: string

  constructor(
    input: {
      readonly title: string
      readonly detail: string
      readonly command?: string
      readonly retry: string
    },
    options?: ErrorOptions,
  ) {
    super(input.detail, options)
    this.name = "UpgradeError"
    this.title = input.title
    this.detail = input.detail
    this.command = input.command
    this.retry = input.retry
  }
}

export interface Interface {
  readonly run: (onInstall?: (version: string) => void) => Effect.Effect<RunResult | undefined>
  readonly check: () => Effect.Effect<CheckResult | undefined, Error>
  readonly apply: (version: string) => Effect.Effect<void, Error>
  readonly method: () => Effect.Effect<Method | undefined>
  readonly latest: (method?: Method) => Effect.Effect<string, Error>
  readonly upgrade: (method: Method, version: string) => Effect.Effect<void, Error>
  readonly removal: (
    method: Method,
  ) => { readonly command: ReadonlyArray<string>; readonly run: Effect.Effect<void, Error> } | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export function decodePolicy(_text: string): Policy | undefined {
  return "disable"
}

const make = Effect.gen(function* () {
  const airgapError = new UpgradeError({
    title: "Updates Disabled",
    detail: "Disabled in Enterprise Air-Gapped Build",
    retry: "",
  })

  const run = Effect.fn("cli.updater.run")(function* (_onInstall?: (version: string) => void) {
    return undefined
  })

  const check = Effect.fn("cli.updater.check")(function* () {
    return {
      type: "unavailable" as const,
      message: "Disabled in Enterprise Air-Gapped Build",
    }
  })

  const apply = Effect.fn("cli.updater.apply")(function* (_version: string) {
    return yield* Effect.fail(airgapError)
  })

  const method = Effect.fn("cli.updater.method")(function* () {
    return undefined
  })

  const latest = Effect.fn("cli.updater.latest")(function* (_method?: Method) {
    return yield* Effect.fail(airgapError)
  })

  const upgrade = Effect.fn("cli.updater.upgrade")(function* (_method: Method, _version: string) {
    return yield* Effect.fail(airgapError)
  })

  const removal = (_method: Method) => undefined

  return Service.of({ run, check, apply, method, latest, upgrade, removal })
})

export const layer = Layer.effect(Service, make)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
