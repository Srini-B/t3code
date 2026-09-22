# Amp

Install [Amp CLI](https://ampcode.com/docs/cli) and run `amp login` on the machine
running your T3 environment. Enable **Amp** in **Settings > Providers**. Web,
desktop, iOS, and Android clients use that environment's Amp installation and login.

Amp runs through its native CLI. No ACP server or bridge is required.

## Configure an instance

Leave **Binary path** as `amp` when the executable is on the environment's `PATH`.
Otherwise enter its absolute path. Use **Settings file** to select an Amp settings
file, or leave it empty to use Amp's default configuration.

For an access token, add `AMP_API_KEY` to the instance's **Environment variables**
and mark it sensitive. Separate instances can use different tokens and settings.
Use **Refresh provider status** after changing a login outside T3.

## Use MCPs and skills

Amp keeps the MCP servers in its local settings and the remote MCP definitions
saved to your Amp account. Personal account definitions follow your login.
Workspace and project definitions depend on the Amp workspace and project matched
to the thread's directory. Manage these connections in
[Amp's MCP settings](https://ampcode.com/docs/customize/mcp).

Amp discovers your installed skills automatically and reads the full `SKILL.md`
when a skill is invoked. Mention `$skill-name` to request one. Put personal
instructions in `~/.config/amp/AGENTS.md` on the machine running Amp. New Amp
sessions include that file automatically. Start a new provider session after
changing local Amp settings or global instructions.

## Update Amp

Enable **Settings > General > Provider update checks** to check for new Amp CLI
versions. In **Settings > Providers**, select the environment and Amp instance,
then open its update control. T3 offers an update command when it recognizes the
installation method. For a native installation in a custom directory, set
`AMP_HOME` to that directory's absolute path in the instance's environment variables.

Instances that use the same binary share its installed version. Updating one
updates that installation; refresh the other instances to see the new version
immediately. Separate environments have separate installations. Provider update
controls are available in the web, desktop, and mobile clients. On mobile, open
**Settings > Environment > Maintenance > Provider versions**.

## Select an Amp mode

The model picker selects Amp's **Low**, **Medium**, **High**, or **Ultra** mode.
Amp chooses the underlying model and tools for that mode. Add a custom model
entry with your plugin mode's key to select a mode supplied by an Amp plugin.
Set **Fast** and **Pro** before the first message. Amp's headless runtime keeps
those features fixed for the native thread; use a new thread to change them.

## Permissions and tools

In supervised modes, local tool requests appear in T3 for approval. **Allow for
session** allows subsequent calls to that tool until the provider session ends.
**Auto-accept edits** allows file edits and asks before other tools. **Full access**
uses Amp's native unrestricted execution.

Account MCP tools run through Amp's cloud `tool_search` and `code_exec`. These
calls do not produce local T3 approval prompts. Manage their access in Amp.
To use T3 approvals for an MCP connection, configure it in `amp.mcpServers` on
the environment and authenticate that local connection. In the Amp settings file
used by that T3 instance, add `tool_search` and `code_exec` to `amp.tools.disable`
to remove the direct cloud MCP route from the session. This preserves the saved
account configuration for other clients. Other Amp cloud features and plugin
code remain outside the local tool approval boundary.

Amp workspace or managed settings can override tool permissions. T3 rejects
supervised sessions when those files contain conflicting permission settings.
Remove the reported overrides or choose Full access. Provider permissions govern
tool calls; they do not sandbox Amp plugins or their lifecycle hooks.

Image uploads, file attachments, skills, and T3's connected tools use the native
Amp runtime. T3 does not surface Amp's plan mode or a manual compaction
command. Ask for a plan in a normal message when needed.

Expand tool activity to see result previews. Completed tool rows keep a generous
bound of real output in the expanded view instead of a short snippet. When Amp
saves an image to disk (for example through `view_media`), the row shows the
image inline. Protected Amp image URLs are not downloaded automatically by T3.

Agents on this thread can ask you structured questions with the t3-code
`ask_user` tool: the question appears in T3 with clickable options and the
agent receives your choice. Amp's own `ask_user_choice` tool is redirected to
the same flow. Plugin confirmation, input, and selection dialogs (`ui.confirm`,
`ui.input`, `ui.select`) are not connected: with no Amp UI attached a plugin
waiting on one stalls, so stop that turn and use a plugin flow that accepts its
inputs through chat or tool arguments.

## Continue a conversation

T3 keeps the native Amp thread identifier with the conversation. Sending another
message after a process restart resumes that Amp thread. Stop a running turn
before changing its mode.

Amp no longer supports native thread forks or conversation rollback. T3 disables
conversation restore for Amp threads because restoring files alone would leave
the agent's history out of sync. Start a new thread when you need a separate
conversation.
