const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

/**
 * Amp-only: headless execute mode has no UI attached, so Amp's native
 * question tool auto-answers and plugin dialogs would wait forever. The
 * bridge and the fallback are stated here because nothing else in the
 * session tells the model this.
 */
const AMP_INTERACTION_INSTRUCTIONS = `<user_interaction>
The person running this session reads the T3 Code conversation, not an Amp editor UI. When you need a decision, do one of these:
- When the t3-code MCP server exposes ask_user, call it with your question and the options. The question appears in T3 Code and the tool returns what the person picked.
- Otherwise, just ask in your normal reply text and end the turn; the person answers in a new message.
Never use built-in tools that pop up an interactive prompt (such as ask_user_choice), and never call plugin ui.confirm/ui.input/ui.select methods: with no UI attached they would stall this session instead of reaching the person.
</user_interaction>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const interaction = harness === "Amp" ? `\n\n${AMP_INTERACTION_INSTRUCTIONS}` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${interaction}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
