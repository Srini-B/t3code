import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  homebrewOwnershipFromCommandPath,
  normalizeCommandPath,
  resolvePackageManagedProviderMaintenance,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";

export const AmpMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("AmpMaintenance.resolve")(function* (context) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const configuredHome = context?.env.AMP_HOME?.trim();
    const configuredBinary =
      context && configuredHome && path.isAbsolute(configuredHome)
        ? path.join(configuredHome, "bin", context.platform === "win32" ? "amp.exe" : "amp")
        : undefined;
    const configuredCommandPath = configuredBinary
      ? yield* fs.realPath(configuredBinary).pipe(Effect.orElseSucceed(() => configuredBinary))
      : undefined;
    const commandPath = context?.realCommandPath;
    const normalized = commandPath ? normalizeCommandPath(commandPath) : "";
    const nativeHome =
      commandPath &&
      !normalized.includes("/node_modules/") &&
      homebrewOwnershipFromCommandPath(commandPath) === null &&
      (normalized.endsWith("/.amp/bin/amp") ||
        normalized.endsWith("/.amp/bin/amp.exe") ||
        (configuredCommandPath !== undefined &&
          normalized === normalizeCommandPath(configuredCommandPath)))
        ? path.dirname(path.dirname(commandPath))
        : undefined;
    const capabilities = yield* resolvePackageManagedProviderMaintenance(
      {
        provider: ProviderDriverKind.make("amp"),
        npmPackageName: "@ampcode/cli",
        nativeUpdate:
          context && nativeHome
            ? {
                args: ["update"],
                isCommandPath: (candidate) => candidate === commandPath,
                env: {
                  ...context.env,
                  AMP_HOME: nativeHome,
                },
              }
            : null,
      },
      context,
    );
    if (!context || !nativeHome || !capabilities.update) return capabilities;
    const command = capabilities.update.command;
    const manualCommand =
      context.platform === "win32"
        ? `& { param($t3AmpPreviousHome); try { $env:AMP_HOME = '${nativeHome.replace(/['\u2018\u2019]/g, "$&$&")}'; ${command} } finally { $env:AMP_HOME = $t3AmpPreviousHome } } $env:AMP_HOME`
        : `AMP_HOME='${nativeHome.replaceAll("'", "'\\''")}' ${command}`;
    return { ...capabilities, update: { ...capabilities.update, command: manualCommand } };
  }),
};
