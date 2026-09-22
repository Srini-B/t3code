import * as NodeURL from "node:url";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import {
  RuntimeItemId,
  RuntimeTaskId,
  type CanonicalItemType,
  type ProviderRuntimeEvent,
  type TurnId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AmpMessage, AmpUsage } from "./AmpProtocol.ts";

const decodeCommandResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      output: Schema.String,
      exitCode: Schema.optionalKey(Schema.Int),
    }),
  ),
);

const decodeFileResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      summary: Schema.String,
      files: Schema.Array(Schema.Struct({ uri: Schema.String, diff: Schema.String })),
    }),
  ),
);
const decodeMediaResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Union([
        Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
        Schema.Struct({
          type: Schema.Literal("image"),
          mimeType: Schema.optionalKey(Schema.String),
          savedPath: Schema.optionalKey(Schema.String),
        }),
      ]),
    ),
  ),
);

function filePath(uri: string): string | undefined {
  try {
    return NodeURL.fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/** Minified MCP/dynamic results start with a brace or bracket and read as noise in a row label. */
function looksLikeJsonDump(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function stringInput(
  input: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Amp's `task` tool carries the human-readable goal on the request. Raw
 * `block.name` ("task") is what shows up in the sub-agents panel otherwise;
 * Claude surfaces `description` the same way.
 */
function subagentTitle(
  input: Readonly<Record<string, unknown>> | undefined,
  fallback: string,
): string {
  const description = stringInput(input, "description");
  if (description) return description.slice(0, 200);
  const prompt = stringInput(input, "prompt");
  if (prompt) return prompt.slice(0, 200);
  return fallback;
}

/** Amp loads skills through a tool named `skill` (see AmpSkills). */
function isSkillToolName(name: string | undefined): boolean {
  return name !== undefined && name.toLowerCase() === "skill";
}

function skillTitle(
  name: string | undefined,
  input: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!isSkillToolName(name)) return undefined;
  const skillName =
    stringInput(input, "skill") ??
    stringInput(input, "name") ??
    stringInput(input, "skill_name") ??
    stringInput(input, "skillName");
  return skillName ? `Reading ${skillName.slice(0, 120)}` : "Reading a skill";
}

function itemTitle(
  name: string | undefined,
  input: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (name === undefined) return undefined;
  const skill = skillTitle(name, input);
  if (skill !== undefined) return skill;
  const normalized = name.toLowerCase();
  if (normalized === "task" || normalized === "subagent") return subagentTitle(input, name);
  return name;
}

/**
 * Collapsed work-log labels fall through to `detail` when the tool has no
 * presentation and no command. Command and file rows want the real text; MCP
 * and dynamic results are often raw JSON dumps, so omit them and let the label
 * fall back to the tool title. Full output stays on `data.output`.
 */
function completionDetail(itemType: CanonicalItemType, output: string): string | undefined {
  if (!output) return undefined;
  if (itemType !== "command_execution" && itemType !== "file_change" && looksLikeJsonDump(output)) {
    return undefined;
  }
  return output;
}

function toolData(
  itemType: CanonicalItemType,
  name: string | undefined,
  input: Readonly<Record<string, unknown>> | undefined,
) {
  return {
    toolName: name,
    input,
    ...(typeof input?.path === "string" &&
    itemType === "image_view" &&
    isWorkspaceImagePreviewPath(input.path)
      ? { imagePath: input.path }
      : {}),
    ...(itemType === "command_execution"
      ? {
          command: input?.command ?? input?.cmd,
          cwd: input?.workdir ?? input?.cwd,
        }
      : {}),
  };
}

type EventType = ProviderRuntimeEvent["type"];
export type AmpEvent = {
  [K in EventType]: Omit<
    Extract<ProviderRuntimeEvent, { type: K }>,
    "provider" | "providerInstanceId" | "threadId" | "eventId" | "createdAt"
  >;
}[EventType];

export interface AmpTurn {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  readonly messages: Set<string>;
  readonly tools: Map<
    string,
    { readonly name: string; readonly input: Readonly<Record<string, unknown>> }
  >;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  hasUsage: boolean;
  hasSubagents: boolean;
}

export function makeAmpTurn(id: TurnId): AmpTurn {
  return {
    id,
    items: [],
    messages: new Set(),
    tools: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    hasUsage: false,
    hasSubagents: false,
  };
}

export function ampToolType(name: string): CanonicalItemType {
  const normalized = name.toLowerCase();
  if (normalized === "bash" || normalized === "shell_command") return "command_execution";
  if (["edit_file", "create_file", "apply_patch", "delete_file", "undo_edit"].includes(normalized))
    return "file_change";
  if (normalized.startsWith("mcp__")) return "mcp_tool_call";
  if (["task", "subagent"].includes(normalized)) return "collab_agent_tool_call";
  if (["web_search", "read_web_page"].includes(normalized)) return "web_search";
  if (["look_at", "read_image", "view_media"].includes(normalized)) return "image_view";
  return "dynamic_tool_call";
}

export function ampTurnUsage(turn: AmpTurn): TurnTokenUsage {
  return turn.hasUsage
    ? {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: turn.hasSubagents,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cachedInputTokens: turn.cachedInputTokens,
        cacheCreationTokens: turn.cacheCreationTokens,
      }
    : { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: turn.hasSubagents };
}

function recordUsage(turn: AmpTurn, usage: AmpUsage) {
  const cached = Math.max(0, Math.trunc(usage.cache_read_input_tokens ?? 0));
  const creation = Math.max(0, Math.trunc(usage.cache_creation_input_tokens ?? 0));
  const input = Math.trunc(usage.input_tokens) + cached + creation;
  const output = Math.trunc(usage.output_tokens);
  turn.hasUsage = true;
  turn.inputTokens += input;
  turn.outputTokens += output;
  turn.cachedInputTokens += cached;
  turn.cacheCreationTokens += creation;
  return { input, output, cached };
}

export function ampMessageEvents(message: AmpMessage, turn: AmpTurn): ReadonlyArray<AmpEvent> {
  const events: Array<AmpEvent> = [];
  const turnId = turn.id;
  const raw = { source: "amp.cli", method: message.type, payload: message } as const;
  if (message.type !== "assistant" && message.type !== "user") return events;
  const parent = message.parent_tool_use_id || undefined;
  const attribution = parent ? { agentId: parent, parentToolUseId: parent } : {};
  if (parent) turn.hasSubagents = true;
  if (message.type === "assistant") {
    if (message.message.id && turn.messages.has(message.message.id)) return events;
    if (message.message.id) turn.messages.add(message.message.id);
    if (message.message.usage && !parent) {
      const usage = recordUsage(turn, message.message.usage);
      events.push({
        type: "thread.token-usage.updated",
        turnId,
        payload: {
          usage: {
            usedTokens: usage.input + usage.output,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cachedInputTokens: usage.cached,
            ...(message.message.usage.max_tokens && message.message.usage.max_tokens > 0
              ? { maxTokens: Math.trunc(message.message.usage.max_tokens) }
              : {}),
            totalProcessedTokens: turn.inputTokens + turn.outputTokens,
          },
        },
        raw,
      });
    }
  }
  turn.items.push(message);
  const blocks = message.message.content;
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text" || block.type === "thinking") {
      if (message.type !== "assistant") continue;
      const itemId = RuntimeItemId.make(
        `${message.message.id ?? `${turn.id}:${turn.items.length}`}:${index}`,
      );
      const reasoning = block.type === "thinking";
      const text = reasoning ? block.thinking : block.text;
      const itemType = reasoning ? "reasoning" : "assistant_message";
      events.push({
        type: "item.started",
        turnId,
        itemId,
        payload: { itemType, status: "inProgress", ...attribution },
        raw,
      });
      if (text)
        events.push({
          type: "content.delta",
          turnId,
          itemId,
          payload: {
            streamKind: reasoning ? "reasoning_text" : "assistant_text",
            delta: text,
            contentIndex: index,
          },
          raw,
        });
      events.push({
        type: "item.completed",
        turnId,
        itemId,
        payload: { itemType, status: "completed", ...attribution },
        raw,
      });
    } else if (block.type === "tool_use") {
      if (turn.tools.has(block.id)) continue;
      turn.tools.set(block.id, { name: block.name, input: block.input });
      const itemType = ampToolType(block.name);
      const title = itemTitle(block.name, block.input);
      events.push({
        type: "item.started",
        turnId,
        itemId: RuntimeItemId.make(block.id),
        payload: {
          itemType,
          title,
          status: "inProgress",
          data: toolData(itemType, block.name, block.input),
          ...attribution,
        },
        raw,
      });
      if (itemType === "collab_agent_tool_call") {
        turn.hasSubagents = true;
        const description =
          stringInput(block.input, "description") ?? stringInput(block.input, "prompt");
        events.push({
          type: "task.started",
          turnId,
          payload: {
            taskId: RuntimeTaskId.make(block.id),
            taskType: "subagent",
            agentKind: "agent",
            toolUseId: block.id,
            title: title ?? block.name,
            ...(description ? { description: description.slice(0, 200) } : {}),
            ...attribution,
          },
          raw,
        });
      }
    } else if (block.type === "tool_result") {
      const tool = turn.tools.get(block.tool_use_id);
      const itemType = ampToolType(tool?.name ?? "");
      const rawOutput =
        typeof block.content === "string"
          ? block.content
          : block.content.map((part) => part.text).join("\n");
      const result =
        itemType === "command_execution"
          ? Option.getOrUndefined(decodeCommandResult(rawOutput))
          : undefined;
      const fileResult =
        itemType === "file_change" ? Option.getOrUndefined(decodeFileResult(rawOutput)) : undefined;
      const mediaResult = Option.getOrUndefined(decodeMediaResult(rawOutput));
      const output =
        result?.output ??
        (fileResult
          ? [fileResult.summary, ...fileResult.files.map((file) => file.diff)].join("\n\n")
          : mediaResult
              ?.map((part) =>
                part.type === "text"
                  ? part.text
                  : part.savedPath
                    ? `Image: ${filePath(part.savedPath) ?? part.savedPath}`
                    : `Image${part.mimeType ? ` (${part.mimeType})` : ""}`,
              )
              .join("\n")) ??
        rawOutput;
      const failed = block.is_error || (result?.exitCode !== undefined && result.exitCode !== 0);
      const itemId = RuntimeItemId.make(block.tool_use_id);
      // Media saved to disk by the provider (e.g. view_media) is surfaced as a
      // viewable preview: `data.imagePath` is what both clients render.
      const savedImagePath = mediaResult
        ?.flatMap((part) =>
          part.type === "image" && part.savedPath
            ? [filePath(part.savedPath) ?? part.savedPath]
            : [],
        )
        .find((candidate) => isWorkspaceImagePreviewPath(candidate));
      if (output && (itemType === "command_execution" || itemType === "file_change")) {
        events.push({
          type: "content.delta",
          turnId,
          itemId,
          payload: {
            streamKind: itemType === "command_execution" ? "command_output" : "file_change_output",
            delta: output,
          },
          raw,
        });
      }
      const detail = completionDetail(itemType, output);
      events.push({
        type: "item.completed",
        turnId,
        itemId,
        payload: {
          itemType,
          title: itemTitle(tool?.name, tool?.input) ?? tool?.name,
          status: failed ? "failed" : "completed",
          ...(detail !== undefined ? { detail } : {}),
          data: {
            ...toolData(itemType, tool?.name, tool?.input),
            output,
            ...(savedImagePath ? { imagePath: savedImagePath } : {}),
            ...(itemType === "mcp_tool_call" ? { result: { ...block, content: output } } : {}),
            ...(fileResult
              ? {
                  changes: fileResult.files.map((file) => ({
                    path: filePath(file.uri),
                    diff: file.diff,
                  })),
                }
              : {}),
            ...(result?.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          },
          ...attribution,
        },
        raw,
      });
      if (itemType === "collab_agent_tool_call")
        events.push({
          type: "task.completed",
          turnId,
          payload: {
            taskId: RuntimeTaskId.make(block.tool_use_id),
            status: block.is_error ? "failed" : "completed",
            summary: output || undefined,
            taskType: "subagent",
            agentKind: "agent",
            toolUseId: block.tool_use_id,
            ...attribution,
          },
          raw,
        });
    }
  }
  return events;
}
