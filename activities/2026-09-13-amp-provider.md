# 2026-09-13: Native Amp provider

Added Amp to the provider registry, settings and onboarding, web/desktop controls,
and the mobile provider/model picker. The environment owns installation and
credentials. Remote clients use the same provider instance and WebSocket contracts.
No deployment or live T3 state migration was performed.

The native CLI JSONL interface was selected because the SDK wrapper drops image
and steering fields. No ACP protocol, server, or dependency was added. Native
permission delegates connect to T3 approvals through an instance-scoped Node
preload and a per-session loopback listener. Workspace and managed settings can
override native user permissions, so supervised sessions reject conflicting
configuration. Headless Fast/Pro settings are fixed at native thread creation.

Verification on BlueLobster used an isolated T3 home and disposable project. The
browser selected Amp High, observed authenticated settings, received `READY 42`,
approved a real `cat README.md` request, and received `LOBSTER-AMP-42`. Disabling
Amp in Settings and enabling it through onboarding persisted correctly. Native
connection errors appeared in the conversation without disabling the composer.
Separate native probes verified image input, multiple prompts, continuation,
thread export, skills, and all four auxiliary text-generation methods.

The production permission helper passed native macOS ARM64 allow/reject and
failure-path checks, including executable and preload paths with spaces. Windows
installation follows the native PowerShell installer because the npm wrapper does
not select a Windows ARM64 binary. Native Windows execution, Linux ARM64/macOS x64
execution, and Android app launches remain unverified. The iOS follow-up below
verified the mobile client against BlueLobster.

Focused contracts, web, mobile, provider registry, and settings checks passed.
Server and web production bundles built successfully. Existing settings and
registry expectations were updated for the new provider; no new regression test
cases were added. Existing frontend lint/React Doctor findings remain unchanged.

Amp inference intermittently returned `Connection error.` before tool execution,
including the bounded native steering/cancellation probe. Native live coverage of
those actions remains incomplete. A controlled protocol fixture verified unique
steering IDs within one turn,
stale-stop protection, actual fixture child termination, immediate cancellation
before initialization, single failure emission, fixed feature settings after
resume, and image byte preservation. These checks are separate from native
verification.

Rollback is a local source revert and rebuild. Deactivate Amp in Settings before
removing the integration; preserve T3 and Amp conversation state. Amp does not
provide native conversation rollback or forks, so these capabilities remain
unavailable for Amp threads. See [the user guide](../docs/user/providers-amp.md)
and [provider constraints](../docs/internals/providers.md).

## iOS and provider-update follow-up

The user requested iOS Simulator verification on the Mac mini. A development
build on iPhone 17 Pro with iOS 26.5 passed from the transferred source snapshot;
all 4,103 source files matched their hashes. The initial signing-disabled build
failed secure storage with `errSecMissingEntitlement` (`-34018`). Rebuilding with
Xcode's normal simulator ad-hoc signing restored the keychain entitlements without
changing app source. One development-client reload crashed in ExpoNotifications
delegate teardown; a clean launch ran the requested flow successfully.

The simulator paired with the disposable BlueLobster environment over Tailscale.
Both Amp instances and all four modes rendered. Selecting High on `Amp iOS check`
and Supervised persisted `amp-ios-verification`, `high`, and `approval-required`.
A real native `cat README.md` request appeared on iOS. Allow once resolved it, and
the app displayed `IOS LOBSTER-AMP-42`. The server persisted the answer, accepted
approval, and completed checkpoint. Amp credentials stayed on BlueLobster. The
radio controls were available through semantic touch references in the tooling's
full accessibility snapshot; no accessibility source changes were needed.
A cold app restart retained the pairing, conversation, resolved approval, and
final answer. After verification, the disposable connection was removed through
the app, the simulator was shut down, and the owned Metro and backend processes
were stopped. Their ports had no remaining listeners. The development build and
verification evidence remain available in the isolated job directory.

Amp update checks use the existing environment and provider-instance machinery.
The review found that native Amp updates target `AMP_HOME`, regardless of the
executable invoked. The resolver now derives ownership from the physical binary
and pins `AMP_HOME` for both T3's update action and its copyable command. Package
manager ownership is preserved for symlinks into npm or Homebrew. No provider
update was executed. Ten ownership probes, a harmless POSIX command probe with
shell characters in the installation path, 54 existing maintenance tests, server
typecheck, lint, formatting, and the server/web build passed. PowerShell command
quoting was checked without a Windows runtime.

Web and desktop Settings show version advisories for the selected environment and
instance. Instances sharing a binary share its installation; sibling snapshots
refresh on the normal schedule or explicit refresh. Mobile has no provider-update
UI. Existing launch notifications cover the primary environment and desktop-local
WSL environments, not every secondary remote environment. Those generic client
behaviors were not changed.

## Account MCP, skills, and global instructions

The user requested authenticated account MCP and skill verification, then clarified
that the file to copy was `~/.codex/AGENTS.md`. On each host, that host's file was
copied atomically to `~/.config/amp/AGENTS.md` with mode `0600`. Both copies match
their source bytes. Neither destination existed, so no backup was necessary.
Fresh native sessions on Linux and Mac mini identified the configured default
`pstack:poteto-mode` and skill entry path without file-reading tool calls.

Both hosts discovered the enabled personal Composio MCP and its seven tools. The
checked workspace scope contained no additional servers. Native skill discovery
returned 152 skills on Linux and 155 on Mac mini, with no discovery errors.
A supervised session through the current T3 adapter loaded
`cross-device-verification` and `using-my-mac-mini`. Independent comparison found
the complete current skill bodies in both native tool results. In the same
session, native `code_exec` successfully called the account MCP's
`COMPOSIO_SEARCH_TOOLS` for a read-only capability. It did not execute the
discovered integration tools.

A second adapter session registered a disposable MCP fixture through T3's normal
per-thread injection. Its local tool returned `AMP-T3-MCP-COEXISTS-42`, while the
account Composio call also succeeded. This proves the additional `--mcp-config`
entry preserves account tools. The first attempt briefly failed native session
refresh. Direct `amp usage` and the subsequent adapter run succeeded without
changing credentials. The cause of that transient authentication failure was not
established.

Native skill and local MCP calls generated T3 approvals. Account cloud
`tool_search` and `code_exec` calls did not invoke the local permission delegate.
The user guide and provider constraints now distinguish these behaviors. No
runtime code change was required. The direct assertions and `git diff --check`
passed. Owned adapter processes and the MCP fixture stopped after verification.
The installed T3 services and databases were not changed.

Rollback for the global instruction copies is removal of only the newly created
`~/.config/amp/AGENTS.md` on each host, after checking for subsequent edits. The
original Codex instruction files remain unchanged. Verification artifacts are
retained under `/tmp/t3-amp-work/mcp-skill-followup` on BlueLobster and the isolated
cross-device job directory on Mac mini.

## Cloud approval options audit

The user asked how to enable approval prompts for account MCPs and which other
Amp capabilities remain limited. A disposable native policy plugin loaded
successfully with an explicit readiness wait. It received `tool.call` and
`tool.result` for its local control tool, but neither cloud `tool_search` nor
`code_exec` reached its rejection hook. Search succeeded. The submitted code
reached evaluation and failed because the probe used `console`, which that runtime
does not define. This was an evaluation error, not a permission denial.

A second native session added `tool_search` and `code_exec` to `amp.tools.disable`.
Both tools disappeared from the emitted initialization catalog and were not
called. The local control tool and its hook still worked. This provides a
per-instance way to remove the cloud MCP route while retaining the saved account
configuration. A locally configured and authenticated MCP connection can then use
T3's existing approvals. The user's Composio configuration was not migrated, and
no account-wide settings were changed.

The tool coverage audit distinguishes tools that execute from T3 presentation and
control limits. Generic top-level native tools are forwarded without a name
allowlist. Native subagent detail, rich tool outputs, plugin dialogs, structured
questions, plan mode, manual compaction, and conversation rewind each need their
own capability decision. Unexercised tools remain unverified. The policy probes
exited, their direct assertions passed, and their evidence is retained under
`/tmp/t3-amp-work/permission-audit`. Only documentation changed in the repository.

## Remaining tools and browser verification

The follow-up used a fresh disposable Chromium session against the retained test
home at `/tmp/t3-amp-work/app-home`. Native Oracle, Librarian, Task, Finder, web
search, page reading, patch creation, shell success and failure, and media viewing
all executed. The Task card displayed its result and duration. Its child tool
transcript was absent from the native stream.

The browser exposed missing result previews for generic tools. Amp saved the
result in `data.output`, while both clients expected canonical detail. The adapter
now supplies detail, MCP metadata, patch paths and diffs, and local media paths.
Image content blocks become text summaries without embedded image data. Existing
ingestion keeps ordinary tool detail previews to 180 characters.

A disposable plugin returning no value reproduced a stream decode failure. The
native thread export showed a completed tool without a result. The protocol now
normalizes absent `tool_result.content` to an empty string. A separate plugin
confirmation remained pending without a T3 dialog and was stopped. An invalid
PNG in the first fixture caused a visible native 400 error; the fixture was
replaced with a valid generated PNG before retrying.

Clicking Stop during a controlled native shell command terminated its recorded
child PID and returned the session to ready. A later steering message reached Amp
while the command was running. After release, Amp returned the requested marker
and the session became ready. Native response latency was several minutes in
some probes.

Painter returned a 1254 by 1254 PNG. Unauthenticated retrieval returned 401.
Retrieval with the existing Amp credential, restricted to the exact Amp origin
with redirects disabled, succeeded. Visual inspection confirmed the blue circle.
No credential value was printed or stored in evidence. Automatic retrieval of
protected Painter URLs is not implemented by this change.

Ultra failed before tool execution with `400 unknown provider for model
anthropic/claude-fable-5-1`. A direct CLI run reproduced the same error. Ultra's
separate file tools remain unverified. Cloud writes, schedules, messages, and
account changes were excluded from these disposable diagnostics.

The focused activity-projection, web, and mobile checks passed 215 tests. Server
typecheck, targeted lint, and whitespace checks passed. No new regression tests
were added. The disposable server was restarted to load the changes. Installed
T3 services and live data were not modified. Patches and native evidence remain
under `/tmp/t3-amp-work/ui-rest`; reversing the two patches reverts these adapter
changes without changing provider configuration.

After restart, native calls confirmed that empty, text, image, and intentionally
failed plugin results all reached their correct T3 completion states. The browser
showed text and image summaries and the failed-tool marker. Amp then rejected its
own next inference request with `400 Missing required parameter: 'input[7].output'`.
The T3 decode fix therefore does not make native void-returning plugins fully
usable. The native result event identifies this as an upstream execution error.
A separate run without the void tool returned Oracle's answer and loaded the
saved Painter image in T3's media preview at its full 1254 by 1254 resolution.

Read-only native thread status, thread reading, and mode listing succeeded.
`get_schedule` correctly returned a flagged error because the disposable thread
has no schedule. Amp invoked T3's `preview_status` and `device_list` MCP tools;
they returned environment errors for a missing preview automation host and
disabled agent device access. These results prove invocation and error display,
not browser or device control by Amp. The disposable Playwright session used for
this verification is separate from T3's embedded automation host.

The read-only diagnostics completed their six tool calls, but the native final
inference later returned `Request timed out.`. The combined image and file probe
was stopped after its completed image, Oracle, and shell-read calls waited several
minutes for another model response. The patch operation was isolated into a new
short turn for its final display check. Completed tool results are distinguished
from completion of the whole native turn.
That isolated retry also returned native `Request timed out.` before calling
`apply_patch`. The final patch-display check therefore has captured-message
replay and focused-check evidence, but no successful fresh native browser run.
The earlier native patch creation passed. All verification turns are now idle
or stopped, and the disposable server and paired browser remain available.
