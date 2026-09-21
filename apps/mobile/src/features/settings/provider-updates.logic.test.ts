import { describe, expect, it } from "@effect/vitest";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  buildMobileProviderVersionRows,
  mobileProviderUpdateCandidates,
  providerDisplayLabel,
} from "./provider-updates.logic";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-21T00:00:00.000Z",
    models: [],
    ...overrides,
  } as ServerProvider;
}

describe("mobile provider update rows", () => {
  it("keeps the newest snapshot per instance and drops disabled or uninstalled providers", () => {
    const rows = buildMobileProviderVersionRows([
      provider({ checkedAt: "2026-09-21T00:00:00.000Z", version: "1.0.0" }),
      provider({ checkedAt: "2026-09-21T01:00:00.000Z", version: "1.1.0" }),
      provider({
        instanceId: ProviderInstanceId.make("amp"),
        driver: ProviderDriverKind.make("amp"),
        enabled: false,
      }),
      provider({
        instanceId: ProviderInstanceId.make("grok"),
        driver: ProviderDriverKind.make("grok"),
        installed: false,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instanceId: "codex", version: "1.1.0" });
  });

  it("flags behind-latest providers with an updatable advisory", () => {
    const rows = buildMobileProviderVersionRows([
      provider({
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          updateCommand: "npm i -g x",
          canUpdate: true,
          checkedAt: null,
          message: null,
        },
      }),
      provider({
        instanceId: ProviderInstanceId.make("amp"),
        driver: ProviderDriverKind.make("amp"),
        versionAdvisory: {
          status: "current",
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
          updateCommand: null,
          canUpdate: false,
          checkedAt: null,
          message: null,
        },
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.instanceId === "codex")).toMatchObject({
      behindLatest: true,
      canUpdate: true,
      latestVersion: "2.0.0",
    });
    expect(rows.find((row) => row.instanceId === "amp")).toMatchObject({
      behindLatest: false,
      canUpdate: false,
    });
    expect(mobileProviderUpdateCandidates(rows)).toHaveLength(1);
  });

  it("excludes providers whose update is already in flight", () => {
    const rows = buildMobileProviderVersionRows([
      provider({
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          updateCommand: "npm i -g x",
          canUpdate: true,
          checkedAt: null,
          message: null,
        },
        updateState: {
          status: "running",
          startedAt: null,
          finishedAt: null,
          message: null,
          output: null,
        },
      }),
    ]);
    expect(mobileProviderUpdateCandidates(rows)).toHaveLength(0);
    expect(rows[0]?.updateRunning).toBe(true);
  });

  it("prefers the instance display name, then the driver label", () => {
    expect(providerDisplayLabel({ driver: "codex", instanceId: "codex" })).toBe("Codex");
    expect(
      providerDisplayLabel({
        driver: "amp",
        displayName: "Amp iOS check",
        instanceId: "amp-ios",
      }),
    ).toBe("Amp iOS check");
  });
});
