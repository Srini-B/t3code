import { type AmpSettings, ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ProviderCommandNotFoundError,
} from "../providerSnapshot.ts";

const DRIVER = ProviderDriverKind.make("amp");
const PRESENTATION = {
  displayName: "Amp",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
  reportsContextWindow: true,
};
const CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    {
      id: "fastMode",
      type: "boolean",
      label: "Fast",
      description: "Faster serving at higher cost.",
      currentValue: false,
    },
    {
      id: "proMode",
      type: "boolean",
      label: "Pro",
      description: "Requires an OpenAI API connection.",
      currentValue: false,
    },
  ],
});
const MODES: ReadonlyArray<ServerProviderModel> = ["medium", "low", "high", "ultra"].map(
  (slug) => ({
    slug,
    name: `Amp ${slug[0]!.toUpperCase()}${slug.slice(1)}`,
    isCustom: false,
    isDefault: slug === "medium",
    capabilities: CAPABILITIES,
  }),
);

const models = (settings: AmpSettings) =>
  providerModelsFromSettings(MODES, settings.customModels, CAPABILITIES);

export const makePendingAmpProvider = Effect.fn("makePendingAmpProvider")(function* (
  settings: AmpSettings,
) {
  return buildServerProvider({
    driver: DRIVER,
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    models: models(settings),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Amp availability..."
        : "Amp is disabled in T3 Code settings.",
    },
  });
});

export const checkAmpProviderStatus = Effect.fn("checkAmpProviderStatus")(function* (
  settings: AmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  if (!settings.enabled) return yield* makePendingAmpProvider(settings);
  const command = settings.binaryPath || "amp";
  const env = { ...environment, AMP_SKIP_UPDATE_CHECK: "1" };
  const run = Effect.fn("AmpProvider.run")(function* (args: ReadonlyArray<string>) {
    const resolved = yield* resolveSpawnCommand(command, args, { env });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(resolved.command, resolved.args, {
        env,
        ...(cwd ? { cwd } : {}),
        shell: resolved.shell,
        stdin: "ignore",
      }),
    );
  });
  const probe = yield* Effect.gen(function* (): Effect.fn.Return<
    ProviderProbeResult,
    PlatformError.PlatformError | ProviderCommandNotFoundError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    const versionResult = yield* run(["--version"]).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS));
    if (Option.isNone(versionResult)) {
      return {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Amp version check timed out.",
      };
    }
    const version = parseGenericCliVersion(versionResult.value.stdout);
    if (versionResult.value.code !== 0) {
      return {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Amp could not report its version.",
      };
    }
    const usage = yield* run([
      "usage",
      "--no-color",
      ...(settings.settingsFile ? ["--settings-file", settings.settingsFile] : []),
    ]).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS));
    if (Option.isNone(usage)) {
      return {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Amp authentication check timed out.",
      };
    }
    if (usage.value.code === 0) {
      return { installed: true, version, status: "ready", auth: { status: "authenticated" } };
    }
    const unauthenticated =
      /invalid or missing api key|not authenticated|not logged in|run ['"]?amp login/i.test(
        `${usage.value.stderr}\n${usage.value.stdout}`,
      );
    return {
      installed: true,
      version,
      status: "warning",
      auth: { status: unauthenticated ? "unauthenticated" : "unknown" },
      message: unauthenticated
        ? "Run amp login on this environment, then refresh Amp."
        : "Amp authentication could not be verified. Run amp usage on this environment.",
    };
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed<ProviderProbeResult>({
        installed: !isCommandMissingCause(cause),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(cause)
          ? "Install Amp on this environment or configure its binary path."
          : "Amp availability check failed.",
      }),
    ),
  );
  return buildServerProvider({
    driver: DRIVER,
    presentation: PRESENTATION,
    enabled: true,
    checkedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    models: models(settings),
    probe,
  });
});
