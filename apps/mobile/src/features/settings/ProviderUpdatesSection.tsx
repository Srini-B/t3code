import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "./components/SettingsSection";
import {
  buildMobileProviderVersionRows,
  mobileProviderUpdateCandidates,
  type MobileProviderVersionRow,
} from "./provider-updates.logic";

const UPDATE_STATUS_TEXT: Record<MobileProviderVersionRow["updateStatus"], string> = {
  idle: "",
  queued: "Update queued",
  running: "Updating…",
  succeeded: "Updated",
  failed: "Update failed",
  unchanged: "Still outdated after update",
};

const TEXT_CLASS =
  Platform.OS === "android" ? "text-base text-foreground" : "text-lg text-foreground";

function VersionRow(props: { readonly row: MobileProviderVersionRow }) {
  const { row } = props;
  const statusText = UPDATE_STATUS_TEXT[row.updateStatus];
  const version =
    row.updateRunning || statusText
      ? statusText
      : row.behindLatest && row.latestVersion
        ? `${row.version ?? "?"} → ${row.latestVersion}`
        : (row.version ?? "Unknown version");
  return (
    <View className="flex-row items-center gap-4 border-t border-border-subtle px-4 py-3 android:min-h-14">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className={TEXT_CLASS}>{row.label}</Text>
        <Text className="text-sm tabular-nums text-foreground-muted">{version}</Text>
      </View>
      {row.updateRunning ? <ActivityIndicator colorClassName="accent-icon" size="small" /> : null}
    </View>
  );
}

export function ProviderUpdatesSection(props: { readonly environmentId: EnvironmentId }) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const rows = buildMobileProviderVersionRows(providers ?? []);
  const candidates = mobileProviderUpdateCandidates(rows);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    label: "provider update",
    reportFailure: false,
  });
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const runUpdate = useCallback(
    (row: MobileProviderVersionRow) => {
      if (pendingIds.has(row.instanceId)) return;
      setPendingIds((previous) => new Set(previous).add(row.instanceId));
      // The live updateState arrives through the provider-status stream; the
      // pending flag only covers the dispatch window and re-entry guard.
      void updateProvider({
        environmentId: props.environmentId,
        input: {
          provider: row.driver as ProviderDriverKind,
          instanceId: row.instanceId as ProviderInstanceId,
        },
      }).finally(() => {
        setPendingIds((previous) => {
          const next = new Set(previous);
          next.delete(row.instanceId);
          return next;
        });
      });
    },
    [pendingIds, props.environmentId, updateProvider],
  );

  if (rows.length === 0) return null;
  return (
    <SettingsSection title="Provider versions">
      {candidates.map((row) => (
        <Pressable
          key={`update:${row.instanceId}`}
          accessibilityRole="button"
          accessibilityLabel={`Update ${row.label} to ${row.latestVersion}`}
          className="flex-row items-center gap-4 px-4 py-3 active:opacity-70 android:min-h-14"
          disabled={pendingIds.has(row.instanceId)}
          onPress={() => runUpdate(row)}
        >
          <SymbolView
            name="arrow.down.circle"
            size={Platform.OS === "android" ? 24 : 22}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="regular"
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className={TEXT_CLASS}>Update {row.label}</Text>
            <Text className="text-sm tabular-nums text-foreground-muted">
              {row.version ?? "?"} → {row.latestVersion}
            </Text>
          </View>
          {pendingIds.has(row.instanceId) ? (
            <ActivityIndicator colorClassName="accent-icon" size="small" />
          ) : null}
        </Pressable>
      ))}
      {rows.map((row) => (
        <VersionRow key={row.instanceId} row={row} />
      ))}
    </SettingsSection>
  );
}
