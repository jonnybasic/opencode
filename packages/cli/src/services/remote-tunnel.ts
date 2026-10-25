export * as RemoteTunnel from "./remote-tunnel"

import { Effect } from "effect"

// Remote access tunneling is disabled in Enterprise Air-Gapped Build.
export const run = Effect.fnUntraced(function* (_input: {
  readonly route: string
  readonly target: string
  readonly onURL: (url: string | undefined) => void
}) {
  return Effect.void
})

export const ensure = Effect.fnUntraced(function* () {
  return yield* Effect.fail(new Error("Remote access disabled in Enterprise Air-Gapped Build"))
})

export const hostname = Effect.fnUntraced(function* (_route: string) {
  return undefined
})
