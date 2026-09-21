# 2026-09-21: Amp integration on the current fork

The user requested a sync with the fork's `origin/main`, followed by a commit and
push to the fork without a pull request. GitHub metadata confirmed that `origin`
is `Srini-B/t3code`, a fork of `pingdotgg/t3code`.

Preserved the uncommitted Amp work, fast-forwarded 341 commits from `20363c32c`
to `b379b5b14`, and restored the Amp changes without merge conflicts. No original
repository remote was added. Credentials and disposable verification artifacts
are outside the committed source tree.

Installed dependencies from the unchanged lockfile. All 569 existing tests in
12 focused files passed, covering provider registration, status caching, settings,
onboarding, model selection, and activity projection in web and mobile clients.
Server, web, and mobile typechecks passed. Changed-file lint and formatting checks
passed, with existing lint warnings. The comment review found no actionable
changes. React Doctor's comparison of the three flagged files returned the same
74/100 score and 10 findings for both the fork baseline and the Amp changes.
No new regression tests were added.

This sync does not repeat the earlier native CLI, browser, or iOS Simulator runs.
Their results and remaining Amp limitations are recorded in
[the integration activity](2026-09-13-amp-provider.md). No installed T3 service was
deployed or restarted. To undo the Amp integration after delivery, revert its
commit and rebuild; preserve the synced fork history and conversation state.
