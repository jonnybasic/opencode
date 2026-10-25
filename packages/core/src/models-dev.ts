import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Context, Duration, Effect, Layer, Schema, Semaphore } from "effect"
import { ModelsDev } from "@opencode/schema/models-dev"
import { Money } from "@opencode/schema/money"
import { App } from "./app.js"
import { Hash } from "@opencode/util/hash"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "./bus.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Model } from "./model.js"
import { AISDKNative } from "./aisdk-native.js"
import { Provider } from "./provider.js"
import { Variant } from "./variant.js"
import { KV } from "./kv.js"
import snapshotText from "./models-dev/snapshot.txt" with { type: "text" }

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

type Cost = {
  readonly input: Money.USDPerMillionTokens
  readonly output: Money.USDPerMillionTokens
  readonly cache_read?: Money.USDPerMillionTokens
  readonly cache_write?: Money.USDPerMillionTokens
  readonly tiers?: readonly (Cost & { readonly tier: { readonly type: "context"; readonly size: number } })[]
}

type Modality = "text" | "audio" | "image" | "video" | "pdf"

type SourceModel = {
  readonly id: string
  readonly name: string
  readonly family?: string
  readonly release_date: string
  readonly attachment: boolean
  readonly reasoning: boolean
  readonly reasoning_options?: readonly (
    | { readonly type: "effort"; readonly values: readonly (string | null)[] }
    | Exclude<Variant.Support, { type: "effort" }>
  )[]
  readonly temperature?: boolean
  readonly tool_call: boolean
  readonly interleaved?: boolean | string | { readonly field: string }
  readonly cost?: Cost
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
  readonly modalities?: { readonly input: readonly Modality[]; readonly output: readonly Modality[] }
  readonly experimental?: {
    readonly modes?: Readonly<
      Record<
        string,
        {
          readonly cost?: Cost
          readonly provider?: {
            readonly body?: Provider.Settings
            readonly headers?: Readonly<Record<string, string>>
          }
        }
      >
    >
  }
  readonly status?: CatalogModelStatus
  readonly provider?: {
    readonly npm?: string
    readonly api?: string
    readonly shape?: "responses" | "completions"
  }
}

type SourceProvider = {
  readonly api?: string
  readonly name: string
  readonly env: readonly string[]
  readonly id: string
  readonly npm: string
  readonly models: Readonly<Record<string, SourceModel>>
}

export type Snapshot = {
  readonly info: Provider.Info
  readonly models: readonly Model.Info[]
  readonly environment: readonly string[]
}

function nativePackage(provider: SourceProvider, model?: SourceModel) {
  const npm = model?.provider?.npm ?? provider.npm
  return (
    AISDKNative.native(npm, {
      providerID: provider.id,
      modelID: model?.id,
      shape: model?.provider?.shape,
    }) ?? Provider.aisdk(npm)
  )
}

/**
 * Normalizes input from either the native catalog schema or the opencode.json schema.
 */
function adaptInput(raw: unknown): Record<string, SourceProvider> {
  if (!raw || typeof raw !== "object") return {}
  const record = raw as Record<string, any>
  const source = record.providers && typeof record.providers === "object" ? record.providers : record
  const result: Record<string, SourceProvider> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== "object") continue
    const v = value as any
    if ("npm" in v && "models" in v && !("package" in v)) {
      result[key] = {
        id: v.id ?? key,
        name: v.name ?? key,
        npm: v.npm,
        api: v.api,
        env: Array.isArray(v.env) ? v.env : [],
        models: v.models ?? {},
      }
      continue
    }
    const npm = v.npm ?? (v.package ? v.package.replace("@opencode/ai/providers/", "@ai-sdk/") : "@ai-sdk/openai-compatible")
    const api = v.api ?? v.settings?.baseURL
    const env = Array.isArray(v.env) ? v.env : []
    const models: Record<string, SourceModel> = {}
    for (const [mKey, mVal] of Object.entries(v.models ?? {})) {
      if (!mVal || typeof mVal !== "object") continue
      const m = mVal as any
      const mId = m.id ?? m.modelID ?? mKey
      models[mId] = {
        id: mId,
        name: m.name ?? mId,
        family: m.family,
        release_date: m.release_date ?? "2026-01-01",
        attachment: m.attachment ?? false,
        reasoning: m.reasoning ?? !!m.capabilities?.reasoning,
        temperature: m.temperature ?? !!m.capabilities?.temperature,
        tool_call: m.tool_call ?? !!m.capabilities?.tool_call,
        cost: m.cost,
        limit: m.limit ?? { context: 32768, output: 8192 },
        modalities: m.modalities ?? { input: ["text"], output: ["text"] },
      }
    }
    result[key] = {
      id: v.id ?? key,
      name: v.name ?? key,
      npm,
      api,
      env,
      models,
    }
  }
  return result
}

function normalize(input: Record<string, SourceProvider>): readonly Snapshot[] {
  const adapted = adaptInput(input)
  const providers: Snapshot[] = []
  for (const item of Object.values(adapted)) {
    const isLocal = item.id === "local-llama" || item.id === "localhost"
    const providerID = Provider.ID.make(item.id)
    const packageName = nativePackage(item)
    const info = {
      id: providerID,
      name: item.name,
      activation: isLocal ? "enabled" : "auto",
      package: packageName,
      ...(item.api
        ? {
            settings: {
              baseURL: item.api,
              ...(isLocal ? { apiKey: "sk-local-airgap" } : {}),
            },
          }
        : isLocal
          ? { settings: { apiKey: "sk-local-airgap" } }
          : {}),
    } satisfies Provider.Info
    const models: Model.Info[] = []
    for (const model of Object.values(item.models)) {
      const baseCost = cost(model.cost)
      const id = Model.ID.make(model.id)
      const base = modelInfo(item, id, model, { cost: baseCost })
      const variants = Variant.resolve({ ...base, package: nativePackage(item, model) }, supports(model))
      models.push({ ...base, variants })
      for (const [mode, options] of Object.entries(model.experimental?.modes ?? {})) {
        const modeID = Model.ID.make(`${model.id}-${mode}`)
        models.push(
          modelInfo(item, modeID, model, {
            name: modeName(model, mode),
            cost: mergeCost(baseCost, options.cost),
            request: options.provider,
            variants,
          }),
        )
      }
    }
    providers.push({ info, models, environment: [...item.env] })
  }
  return providers
}

function released(date: string) {
  const time = Date.parse(date)
  return Number.isFinite(time) ? time : 0
}

function cost(input: SourceModel["cost"]): Model.Info["cost"] {
  const base = {
    input: input?.input ?? Money.USDPerMillionTokens.zero,
    output: input?.output ?? Money.USDPerMillionTokens.zero,
    cache: {
      read: input?.cache_read ?? Money.USDPerMillionTokens.zero,
      write: input?.cache_write ?? Money.USDPerMillionTokens.zero,
    },
  }
  return [
    base,
    ...(input?.tiers?.map((item) => ({
      tier: item.tier,
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read ?? Money.USDPerMillionTokens.zero,
        write: item.cache_write ?? Money.USDPerMillionTokens.zero,
      },
    })) ?? []),
  ]
}

function mergeCost(base: Model.Info["cost"], override: SourceModel["cost"] | undefined) {
  if (!override) return base
  const next = cost(override)
  const [baseDefault, ...baseTiers] = base
  const [nextDefault, ...nextTiers] = next
  const tierKey = (item: Model.Info["cost"][number]) => `${item.tier?.type ?? "base"}:${item.tier?.size ?? 0}`
  const merge = (left: Model.Info["cost"][number], right: Model.Info["cost"][number]) => ({
    ...left,
    ...right,
    tier: right.tier ?? left.tier,
    cache: { ...left.cache, ...right.cache },
  })
  const tiers = new Map(baseTiers.map((item) => [tierKey(item), item]))
  for (const item of nextTiers) {
    const current = tiers.get(tierKey(item))
    tiers.set(tierKey(item), current ? merge(current, item) : item)
  }
  return [
    merge(
      baseDefault ?? {
        input: Money.USDPerMillionTokens.zero,
        output: Money.USDPerMillionTokens.zero,
        cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
      },
      nextDefault,
    ),
    ...tiers.values(),
  ]
}

function modeName(model: SourceModel, mode: string) {
  return `${model.name} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`
}

function supports(model: SourceModel): readonly Variant.Support[] {
  return (model.reasoning_options ?? []).map((option) =>
    option.type === "effort"
      ? { type: "effort", values: option.values.filter((value): value is string => value !== null && value !== "null") }
      : option,
  )
}

function modelInfo(
  provider: SourceProvider,
  id: Model.ID,
  model: SourceModel,
  input: {
    readonly name?: string
    readonly cost?: Model.Info["cost"]
    readonly request?: NonNullable<NonNullable<SourceModel["experimental"]>["modes"]>[string]["provider"]
    readonly variants?: NonNullable<Model.Info["variants"]>
  } = {},
): Model.Info {
  const providerID = Provider.ID.make(provider.id)
  const resolved = nativePackage(provider, model)
  const pkg = model.provider?.npm || resolved !== nativePackage(provider) ? resolved : undefined
  const settings = {
    ...(model.provider?.api ? { baseURL: model.provider.api } : {}),
    ...(resolved === "@opencode/ai/providers/openai-compatible" ? { provider: providerID } : {}),
  }
  return {
    id,
    modelID: Model.ID.make(model.id),
    providerID,
    name: input.name ?? model.name,
    compatibility: Model.compatibility(model.interleaved),
    family: model.family ? Model.Family.make(model.family) : undefined,
    package: pkg,
    settings: Object.keys(settings).length === 0 ? undefined : settings,
    capabilities: {
      tools: model.tool_call,
      input: [...(model.modalities?.input ?? [])],
      output: [...(model.modalities?.output ?? [])],
    },
    variants: [...(input.variants ?? [])],
    time: { released: released(model.release_date) },
    cost: (input.cost ?? cost(model.cost)).map((item) => ({
      ...item,
      tier: item.tier && { ...item.tier },
      cache: { ...item.cache },
    })),
    status: model.status ?? "active",
    enabled: true,
    limit: { context: model.limit.context, input: model.limit.input, output: model.limit.output },
    headers: input.request?.headers ? { ...input.request.headers } : undefined,
    body: input.request?.body ? { ...input.request.body } : undefined,
  }
}

export { Event } from "@opencode/schema/models-dev"

export interface Interface {
  readonly get: () => Effect.Effect<readonly Snapshot[]>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export const Options = Schema.Struct({
  url: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  fetch: Schema.optional(Schema.Boolean),
  snapshot: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

const CatalogJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeCatalog = (text: string) =>
  Schema.decodeUnknownEffect(CatalogJson)(text).pipe(Effect.map((catalog) => catalog as Record<string, SourceProvider>))

function resolveOverrideFile(explicit?: string): string | undefined {
  if (explicit && fs.existsSync(explicit)) return explicit
  const envPath = process.env.OPENCODE_MODELS_PATH
  if (envPath && fs.existsSync(envPath)) return envPath
  const etc = "/etc/opencode/models.json"
  try {
    if (fs.existsSync(etc)) return etc
  } catch {}
  const home = os.homedir()
  const configHome = path.join(home, ".config", "opencode", "models.json")
  try {
    if (fs.existsSync(configHome)) return configHome
  } catch {}
  if (process.platform === "win32") {
    const programData = process.env.PROGRAMDATA || "C:\\ProgramData"
    const pdPath = path.join(programData, "opencode", "models.json")
    try {
      if (fs.existsSync(pdPath)) return pdPath
    } catch {}
  }
  return undefined
}

let bundledCache: readonly Snapshot[] | undefined
const bundledSnapshot = Effect.suspend(() =>
  bundledCache
    ? Effect.succeed(bundledCache)
    : decodeCatalog(snapshotText).pipe(
        Effect.map((catalog) => {
          bundledCache = normalize(catalog)
          return bundledCache
        }),
      ),
)

export function bodyDigest(text: string) {
  return Hash.sha256(text)
}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsUtil = yield* FSUtil.Service
      const bus = yield* Bus.Service
      const lock = Semaphore.makeUnsafe(1)

      const targetFile = resolveOverrideFile(options?.file)

      const loadFromFile = targetFile
        ? fsUtil.readJson(targetFile).pipe(
            Effect.map((input) => input as Record<string, SourceProvider>),
            Effect.orElseSucceed(() => undefined),
          )
        : Effect.undefined

      const loadSnapshot = options?.snapshot === false ? Effect.undefined : bundledSnapshot

      const populate = Effect.gen(function* () {
        const fromFile = yield* loadFromFile
        if (fromFile) return normalize(fromFile)
        const bundled = yield* loadSnapshot
        if (bundled) return bundled
        return []
      }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

      const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

      const get = (): Effect.Effect<readonly Snapshot[]> => cachedGet

      const refresh = Effect.fn("ModelsDev.refresh")(function* (_force = false) {
        yield* lock
          .withPermit(
            Effect.gen(function* () {
              yield* invalidate
              yield* bus.publish(ModelsDev.Event.Refreshed, {})
            }),
          )
          .pipe(Effect.ignore)
      })

      return Service.of({ get, refresh })
    }),
  )

export function configured(options?: Options) {
  return makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [FSUtil.node, Bus.node, App.node, KV.node, httpClient],
  })
}

export const node = configured()

export * as ModelsDev from "./models-dev.js"
