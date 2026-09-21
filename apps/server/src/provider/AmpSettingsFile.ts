import * as NodeOS from "node:os";
import type { AmpSettings } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const LocalSettings = Schema.Struct({
  "amp.url": Schema.optional(Schema.String),
  "amp.proxy": Schema.optional(Schema.String),
  "amp.network.timeout": Schema.optional(Schema.Finite),
  "amp.skills.path": Schema.optional(Schema.String),
  "amp.skills.disableClaudeCodeSkills": Schema.optional(Schema.Boolean),
});
const EMPTY_SETTINGS: typeof LocalSettings.Type = {};
const decodeSettings = Schema.decodeEffect(fromLenientJson(LocalSettings));

export const readAmpSettingsFile = Effect.fn("readAmpSettingsFile")(function* (
  settings: Pick<AmpSettings, "settingsFile">,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
  const explicit = settings.settingsFile.trim() || environment.AMP_SETTINGS_FILE;
  if (explicit) return yield* fs.readFileString(explicit).pipe(Effect.flatMap(decodeSettings));
  const directory = path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "amp");
  for (const filename of ["settings.json", "settings.jsonc"]) {
    const source = path.join(directory, filename);
    if (yield* fs.exists(source))
      return yield* fs.readFileString(source).pipe(Effect.flatMap(decodeSettings));
  }
  return EMPTY_SETTINGS;
});
