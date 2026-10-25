import { Effect, Layer } from "effect"
import { runID } from "./shared.js"

export interface Options {
  readonly endpoint?: string
  readonly headers?: string
}

export interface App {
  readonly client: string
  readonly version: string
  readonly channel: string
}

export function resource(app: App = { client: "opencode", version: "unknown", channel: "local" }): {
  serviceName: string
  serviceVersion: string
  attributes: Record<string, string>
} {
  return {
    serviceName: "opencode",
    serviceVersion: app.version,
    attributes: {
      "deployment.environment.name": app.channel,
      "opencode.client": app.client,
      "opencode.run": runID(),
      "service.instance.id": runID(),
    },
  }
}

// Observability and OTLP exporters permanently disabled in Enterprise Air-Gapped Build.
export function loggers(_options: Options | undefined, _app: App) {
  return []
}

export const tracingLayer = Effect.fnUntraced(function* (_options: Options | undefined, _app: App) {
  return Layer.empty
})

export * as Otlp from "./otlp.js"
