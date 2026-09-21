import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  resolveAmpLoginCommand,
  resolveOnboardingProviderInstallCommand,
} from "../../onboarding/providerReadiness.logic";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

function SetupCommand({ command }: { readonly command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "command" });
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 text-xs break-all select-text">{command}</code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy command"
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

export function AmpSetupSection({
  environmentId,
  environmentLabel,
  config,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly config: unknown;
}) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (!serverConfig) return null;
  const platform = serverConfig.environment.platform.os;
  return (
    <section aria-label="Amp setup" className="divide-y divide-border/50 text-xs">
      <SettingsRow title="Run in terminal on" control={environmentLabel} />
      <SettingsRow
        title="Install"
        control={
          <SetupCommand command={resolveOnboardingProviderInstallCommand("amp", platform)} />
        }
      />
      <SettingsRow
        title="Sign in"
        control={<SetupCommand command={resolveAmpLoginCommand(config, platform)} />}
      />
      <SettingsRow
        title="API key"
        control={
          <span className="text-xs text-muted-foreground">
            Alternatively, add <code>AMP_API_KEY</code> as a sensitive environment variable below.
          </span>
        }
      />
    </section>
  );
}
