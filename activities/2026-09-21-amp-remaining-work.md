# 2026-09-21: Amp remaining work

The user asked for the remaining work from the Amp status report. Three T3-side
gaps were actionable from this host: the mobile provider-update UI, regression
tests for the adapter's native normalization, and the stale "mobile has no
provider-update UI" documentation. Everything else in the report is blocked by
upstream behavior, other machines, or by design decisions already recorded.

## Re-based verification after the fork sync

Re-ran the focused suites on the synced tree before changing anything: 593 tests
across contracts, provider registry, settings, and maintenance passed, plus 84
web/mobile client tests and 43 provider-update launch-notification tests. This
re-establishes the recorded 569-test baseline against the current fork head
(341 commits beyond the original Amp work).

## Mobile provider-update UI

Mobile previously exposed only the environment-wide "Check provider updates"
switch. New `ProviderUpdatesSection` on **Settings > Environment > Maintenance**
lists each enabled, installed provider instance of the selected environment with
its version, the upgrade target when behind latest, and live update status. A
row per updatable instance dispatches the existing `server.updateProvider` RPC;
row logic lives in pure `provider-updates.logic.ts` with unit tests. The section
renders only when exactly one environment is selected, because updates act on
one environment's installations.

This closes the parity gap where update controls existed on web and desktop but
not mobile. Launch-notification behavior is unchanged.

## Adapter regression tests

New `apps/server/src/provider/amp/AmpEvents.test.ts` locks the native-stream
normalizations that earlier verification established interactively:

- absent `tool_result.content` decodes as empty content instead of a broken
  stream (void-returning plugins);
- command results map JSON output to command output with exit-code failure
  detection;
- file-change results produce per-file paths and diffs;
- media results surface a saved local path and image preview;
- `is_error` marks the item failed while generic detail is preserved;
- dedup by native message id, subagent attribution, item-type mapping, and
  cache-aware usage accumulation.

## Documentation

The user guide now says provider update controls are available on web, desktop,
and mobile, with the mobile settings path. The 13 September activity record is
intentionally unchanged: it describes what was true when recorded.

## Verification

The four new/changed test files pass (113 tests). Server, web, and mobile
typechecks report no errors; targeted lint on the changed files is clean. No
native Amp turns were run in this pass; the adapter changes are test-only, and
the mobile change reuses the update RPC verified natively on 13 September.

## Still open, by cause

- Upstream: Amp's own next inference after a void-returning plugin
  (`400 Missing required parameter`), Ultra's unknown-provider 400, native
  response latency, and missing child subagent transcripts.
- Requires another machine: native Windows and Android execution; macOS x64 and
  Linux ARM64.
- Requires a production release: iOS App Store/Play builds were never exercised;
  the simulator checks used development builds.
- Design decisions, not gaps: protected Painter URL retrieval, plugin dialogs,
  conversation rollback, and universal update reporting across secondary remote
  environments.
