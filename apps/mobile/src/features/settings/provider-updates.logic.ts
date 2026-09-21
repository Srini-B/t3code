import type { ServerProvider } from "@t3tools/contracts";
import { isProviderDriverKind, PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";

export type MobileProviderVersionRow = {
  readonly instanceId: string;
  readonly driver: string;
  readonly label: string;
  readonly version: string | null;
  readonly latestVersion: string | null;
  readonly behindLatest: boolean;
  readonly canUpdate: boolean;
  readonly updateRunning: boolean;
  readonly updateStatus: "idle" | "queued" | "running" | "succeeded" | "failed" | "unchanged";
};

export function providerDisplayLabel(provider: {
  readonly driver: string;
  readonly displayName?: string | undefined;
  readonly instanceId: string;
}): string {
  return (
    provider.displayName ??
    (isProviderDriverKind(provider.driver) ? PROVIDER_DISPLAY_NAMES[provider.driver] : undefined) ??
    provider.instanceId
  );
}

function updateState(provider: ServerProvider) {
  return provider.updateState?.status ?? "idle";
}

/**
 * One row per live provider snapshot, newest `checkedAt` per instance.
 * Disabled or uninstalled instances have no version to act on, so they
 * stay out of the list.
 */
export function buildMobileProviderVersionRows(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<MobileProviderVersionRow> {
  const latestByInstance = new Map<string, ServerProvider>();
  for (const provider of providers) {
    const current = latestByInstance.get(provider.instanceId);
    if (!current || provider.checkedAt.localeCompare(current.checkedAt) >= 0) {
      latestByInstance.set(provider.instanceId, provider);
    }
  }
  return [...latestByInstance.values()]
    .filter((provider) => provider.enabled && provider.installed)
    .map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      label: providerDisplayLabel(provider),
      version: provider.version,
      latestVersion: provider.versionAdvisory?.latestVersion ?? null,
      behindLatest: provider.versionAdvisory?.status === "behind_latest",
      canUpdate: provider.versionAdvisory?.canUpdate === true,
      updateRunning:
        provider.updateState?.status === "queued" || provider.updateState?.status === "running",
      updateStatus: updateState(provider),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** Rows the update action may target: behind latest and not already running. */
export function mobileProviderUpdateCandidates(
  rows: ReadonlyArray<MobileProviderVersionRow>,
): ReadonlyArray<MobileProviderVersionRow> {
  return rows.filter((row) => row.behindLatest && row.canUpdate && !row.updateRunning);
}
