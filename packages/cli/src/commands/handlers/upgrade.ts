import { intro, log, outro } from "@clack/prompts"
import { Effect } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"

export default Runtime.handler(
  Commands.commands.upgrade,
  Effect.fn("cli.upgrade")(function* () {
    intro("Upgrade")
    log.info("Disabled in Enterprise Air-Gapped Build")
    outro("Done")
  }),
)
