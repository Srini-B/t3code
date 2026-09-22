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

- Upstream Amp behavior: the next inference after a void-returning plugin fails
  (`400 Missing required parameter`) and native response latency can run to
  minutes. Ultra's unknown-provider 400 no longer reproduces (see the 22
  September section).
- Requires another machine: native Windows and Android execution; macOS x64 and
  Linux ARM64.
- Open design decisions: plan mode (kept unsupported by choice).

## 22 September follow-up: the four open design decisions

The user chose to proceed on all remaining decisions: rich tool output "for all,
no limitation", bridge plugin dialogs into T3 approvals, wire structured
questions into the user-input flow, and skip plan mode. All four are now
resolved in code or by probe:

### Ultra mode re-verified

A native headless Ultra turn succeeded (8.6s inference, no 400). Ultra also
resolves an expanded toolset (`painter`, `code_exec`, `tool_search`,
`view_media`, `ask_user_choice`). The earlier unknown-provider failure was on
Amp's side and is gone.

### Structured questions: real bridge, not a redirect

Probes established the constraints: Amp's native `ask_user_choice` auto-answers
in headless execute mode ("User selected option 1") with no external answer
channel — stdin JSONL, permission allow/deny, and `--dangerously-allow-all` all
cannot supply the chosen option, and a pending call hangs the turn. The t3-code
permission delegate sees the call but cannot answer it.

So the bridge is a new MCP tool instead. The Amp adapter registers a
per-thread bridge at session start (`AmpUserInputBridge.ts`); the t3-code MCP
server gains an `ask_user` toolkit (`mcp/toolkits/askUser/`) whose handler
emits T3's standard `user-input.requested` flow and awaits the answer; the
adapter's `respondToUserInput` (previously a hard failure) resolves it and the
MCP handler maps the recorded answers back to the tool result. Question
mapping, bounds, and answer extraction have unit tests. `ask-user` joins the
MCP capability set granted to every provider session credential.

### Plugin dialogs and native ask_user_choice: guided away, honestly

There is no external channel to answer plugin `ui.confirm/ui.input/ui.select`
or native `ask_user_choice` (probes above), so bridging them is impossible
without an Amp upstream change. Instead the runtime instructions now carry an
Amp-only `<user_interaction>` block: use t3-code `ask_user` when available,
otherwise ask in plain text and end the turn, and never call the interactive
prompt tools that would stall the session. The user guide documents the
behavior as it is.

### Rich tool output

- Terminal `tool.completed` rows now persist up to 8,000 characters of real
  detail (bounded with an explicit truncation notice) instead of the 180-char
  cap; in-flight `tool.updated` rows still summarize to keep streaming O(1).
- Media results with a saved path now set `data.imagePath` (saved artifact
  wins over the tool input path), so `view_media` images render inline in web
  and mobile.

### Verification

Server typecheck clean; 107 tests across the amp/mcp scope plus the ingestion
activity tests pass (118 with the RuntimeInstructions scope); targeted lint on
all changed files is clean. Native probes: Ultra turn succeeded;
`ask_user_choice` auto-answer and stdin/deny/allow-all answer-channel probes
were all negative, establishing the bridge design. The full MCP ask_user flow
was not exercised against a live Amp session yet — the adapter, toolkit, and
answer path are unit-tested separately.

### Handoff: next steps (noted 2026-09-22)

Everything through this commit is delivered and pushed to the fork's `main`
(`ae6257b89`); the working tree was left clean. The remaining work, in order:

1. Live `ask_user` end-to-end check (any host with Amp credentials): start a
   supervised disposable Amp session, make the agent call t3-code `ask_user`,
   answer it in the T3 client, and confirm the answer reaches the tool result
   and the turn completes.
2. Integrated web pass on the rich-output changes: expanded completed tool rows
   show up to 8,000 characters, and saved media renders as an inline preview.
3. macOS (ARM) native checks: Amp install/ownership probes, one supervised
   turn, and the ask_user flow above; the Mac mini already paired successfully
   on 13 September, so this is a re-run on current code rather than first
   coverage.
4. Still blocked elsewhere: native Windows and Android execution; Linux ARM64.
5. Upstream, unchanged: void-returning plugins break Amp's own next inference
   (`400 Missing required parameter`); inference latency can run to minutes.

## Accepted limitations (decided 2026-09-21)

- Subagent transcripts: Amp exposes the parent task and its result only. The
  user guide documents this as expected behavior.
- Production release coverage: App Store and Play builds are out of scope for
  now; all mobile verification used development builds.
- Universal update reporting across secondary remote environments:
  deprioritized.
- Protected Painter URL retrieval and conversation rollback stay as documented
  design decisions in the user guide.
