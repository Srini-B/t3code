// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { TurnId } from "@t3tools/contracts";

import { ampMessageEvents, makeAmpTurn, type AmpEvent, type AmpTurn } from "./AmpEvents.ts";
import { decodeAmpMessage, type AmpMessage } from "./AmpProtocol.ts";

const turnId = TurnId.make("turn-1");

function turnWithTools(): AmpTurn {
  const turn = makeAmpTurn(turnId);
  // The tool_use half of each pair, so tool_result blocks can resolve.
  ampMessageEvents(
    {
      session_id: "native-1",
      type: "assistant",
      message: {
        id: "msg-tools",
        content: [
          { type: "tool_use", id: "tool-bash", name: "bash", input: { cmd: "echo hi" } },
          { type: "tool_use", id: "tool-edit", name: "edit_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "tool-mcp", name: "mcp__svc__tool", input: {} },
          { type: "tool_use", id: "tool-media", name: "look_at", input: { path: "img.png" } },
        ],
      },
    } as unknown as AmpMessage,
    turn,
  );
  return turn;
}

function toolResultEvents(turn: AmpTurn, content: unknown, isError = false) {
  return ampMessageEvents(
    {
      session_id: "native-1",
      type: "assistant",
      message: {
        id: "msg-results",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-bash",
            content,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    } as unknown as AmpMessage,
    turn,
  );
}

describe("ampMessageEvents tool result normalization", () => {
  it.effect("treats an absent tool_result content as empty instead of failing to decode", () =>
    Effect.gen(function* () {
      const turn = turnWithTools();
      // The native stream omits tool_result.content entirely for void-returning
      // plugins; the protocol schema normalizes that absence to "".
      const message = yield* decodeAmpMessage(
        JSON.stringify({
          session_id: "native-1",
          type: "assistant",
          message: {
            id: "msg-void",
            content: [{ type: "tool_result", tool_use_id: "tool-bash" }],
          },
        }),
      );
      const events = ampMessageEvents(message, turn);
      const completed = events.find((event) => event.type === "item.completed");
      expect(completed).toBeDefined();
      // The item still completes; upstream then rejects its own next inference
      // for void-returning plugins, which T3 cannot fix.
      expect(completed!.payload.status).toBe("completed");
    }),
  );

  it("maps command JSON output to command output with exit-code failure detection", () => {
    const turn = turnWithTools();
    const events = toolResultEvents(
      turn,
      JSON.stringify({ output: "LOBSTER-AMP-42", exitCode: 0 }),
    );
    const completed = events.find((event) => event.type === "item.completed")!;
    expect(completed.payload.status).toBe("completed");
    expect((completed.payload.data as { output: string }).output).toBe("LOBSTER-AMP-42");

    const failing = toolResultEvents(
      turnWithTools(),
      JSON.stringify({ output: "boom", exitCode: 3 }),
    );
    const failedItem = failing.find((event) => event.type === "item.completed")!;
    expect(failedItem.payload.status).toBe("failed");
    expect((failedItem.payload.data as { exitCode: number }).exitCode).toBe(3);
  });

  it("maps file-change results to per-file changes with decoded paths", () => {
    const turn = turnWithTools();
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: {
          id: "msg-file",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-edit",
              content: JSON.stringify({
                summary: "Edited one file",
                files: [{ uri: "file:///ws/src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }],
              }),
            },
          ],
        },
      } as unknown as AmpMessage,
      turn,
    );
    const completed = events.find((event) => event.type === "item.completed")!;
    expect(completed.payload.itemType).toBe("file_change");
    expect((completed.payload.data as { changes: unknown }).changes).toEqual([
      { path: "/ws/src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b" },
    ]);
  });

  it("summarizes media results with a saved path and supplies the image preview", () => {
    const turn = turnWithTools();
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: {
          id: "msg-media",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-media",
              content: JSON.stringify([
                { type: "image", mimeType: "image/png", savedPath: "file:///ws/img.png" },
              ]),
            },
          ],
        },
      } as unknown as AmpMessage,
      turn,
    );
    const completed = events.find((event) => event.type === "item.completed")!;
    expect(completed.payload.itemType).toBe("image_view");
    // The saved artifact wins over the tool's input path: it is the file that
    // actually exists to render.
    expect((completed.payload.data as { imagePath?: string }).imagePath).toBe("/ws/img.png");
    expect(completed.payload.detail as string).toContain("/ws/img.png");
  });

  it("marks is_error results as failed and keeps generic detail for dynamic tools", () => {
    const turn = turnWithTools();
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: {
          id: "msg-generic",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-mcp",
              content: "mcp payload",
              is_error: true,
            },
          ],
        },
      } as unknown as AmpMessage,
      turn,
    );
    const completed = events.find((event) => event.type === "item.completed")!;
    expect(completed.payload.status).toBe("failed");
    expect(completed.payload.detail).toBe("mcp payload");
  });

  it("omits raw JSON detail so the row label falls back to the tool title", () => {
    const turn = turnWithTools();
    const json = JSON.stringify({
      data: { results: [{ index: 1, use_case: "inspect GitHub repositories" }] },
    });
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: {
          id: "msg-json",
          content: [{ type: "tool_result", tool_use_id: "tool-mcp", content: json }],
        },
      } as unknown as AmpMessage,
      turn,
    );
    const completed = events.find((event) => event.type === "item.completed")!;
    expect(completed.payload.detail).toBeUndefined();
    expect((completed.payload.data as { output: string }).output).toBe(json);
    expect(completed.payload.title).toBe("mcp__svc__tool");
  });
});

describe("ampMessageEvents lifecycle", () => {
  it("emits a started and completed item pair for text blocks", () => {
    const turn = makeAmpTurn(turnId);
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: { id: "msg-text", content: [{ type: "text", text: "Hello" }] },
      } as unknown as AmpMessage,
      turn,
    );
    expect(events.map((event) => event.type)).toEqual([
      "item.started",
      "content.delta",
      "item.completed",
    ]);
  });

  it("deduplicates assistant messages replayed by id", () => {
    const turn = makeAmpTurn(turnId);
    const message = {
      session_id: "native-1",
      type: "assistant",
      message: { id: "msg-dup", content: [{ type: "text", text: "Hello" }] },
    } as unknown as AmpMessage;
    expect(ampMessageEvents(message, turn)).toHaveLength(3);
    expect(ampMessageEvents(message, turn)).toHaveLength(0);
  });

  it("attributes subagent blocks through parent_tool_use_id and flags usage", () => {
    const turn = makeAmpTurn(turnId);
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        parent_tool_use_id: "agent-1",
        message: { id: "msg-sub", content: [{ type: "text", text: "sub" }] },
      } as unknown as AmpMessage,
      turn,
    );
    expect(turn.hasSubagents).toBe(true);
    for (const event of events.filter(
      (event) => event.type === "item.started" || event.type === "item.completed",
    )) {
      expect((event.payload as { parentToolUseId?: string }).parentToolUseId).toBe("agent-1");
    }
  });

  it("surfaces a saved image from a media result as a viewable imagePath", () => {
    const turn = turnWithTools();
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: {
          id: "msg-media",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-media",
              content: JSON.stringify([
                {
                  type: "image",
                  mimeType: "image/png",
                  savedPath: "file:///tmp/shot.png",
                },
              ]),
            },
          ],
        },
      } as unknown as AmpMessage,
      turn,
    );
    const completed = events.find((event) => event.type === "item.completed");
    expect(completed).toBeDefined();
    const data = completed!.payload.data as Record<string, unknown>;
    expect(data.imagePath).toBe("/tmp/shot.png");
  });

  it("maps tool names to canonical item types", () => {
    const turn = makeAmpTurn(turnId);
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: {
          id: "msg-mapping",
          content: [
            { type: "tool_use", id: "t1", name: "bash", input: {} },
            { type: "tool_use", id: "t2", name: "web_search", input: {} },
            { type: "tool_use", id: "t3", name: "task", input: {} },
            { type: "tool_use", id: "t4", name: "custom_thing", input: {} },
          ],
        },
      } as unknown as AmpMessage,
      turn,
    );
    const started = events.filter((event) => event.type === "item.started");
    expect(started.map((event) => event.payload.itemType)).toEqual([
      "command_execution",
      "web_search",
      "collab_agent_tool_call",
      "dynamic_tool_call",
    ]);
  });

  it("titles subagent tools from description or prompt instead of the tool name", () => {
    const turn = makeAmpTurn(turnId);
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: {
          id: "msg-task",
          content: [
            {
              type: "tool_use",
              id: "tool-task",
              name: "task",
              input: { description: "Audit auth flow", prompt: "Do the audit" },
            },
            {
              type: "tool_use",
              id: "tool-task-prompt",
              name: "task",
              input: { prompt: "Only a prompt".padEnd(300, "!") },
            },
          ],
        },
      } as unknown as AmpMessage,
      turn,
    );
    const taskItem = events.find(
      (event): event is Extract<AmpEvent, { type: "item.started" }> =>
        event.type === "item.started" && event.itemId === "tool-task",
    )!;
    expect(taskItem.payload.title).toBe("Audit auth flow");
    const taskStarted = events.find(
      (event): event is Extract<AmpEvent, { type: "task.started" }> =>
        event.type === "task.started",
    )!;
    expect(taskStarted.payload.title).toBe("Audit auth flow");
    expect(taskStarted.payload.description).toBe("Audit auth flow");
    const promptItem = events.find(
      (event): event is Extract<AmpEvent, { type: "item.started" }> =>
        event.type === "item.started" && event.itemId === "tool-task-prompt",
    )!;
    expect(promptItem.payload.title).toBe("Only a prompt".padEnd(200, "!"));
  });

  it("titles skill tool reads with the skill name from input", () => {
    const turn = makeAmpTurn(turnId);
    const events = ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: {
          id: "msg-skill",
          content: [
            {
              type: "tool_use",
              id: "tool-skill",
              name: "skill",
              input: { skill: "poteto-mode" },
            },
          ],
        },
      } as unknown as AmpMessage,
      turn,
    );
    const started = events.find(
      (event): event is Extract<AmpEvent, { type: "item.started" }> =>
        event.type === "item.started",
    )!;
    expect(started.payload.title).toBe("Reading poteto-mode");
  });
});

describe("ampMessageEvents usage", () => {
  it("accumulates usage including cache reads and writes", () => {
    const turn = makeAmpTurn(turnId);
    ampMessageEvents(
      {
        session_id: "native-1",
        type: "assistant",
        message: {
          id: "msg-usage",
          content: [],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      } as unknown as AmpMessage,
      turn,
    );
    const usage = turn;
    expect(usage.inputTokens).toBe(15);
    expect(usage.outputTokens).toBe(5);
    expect(usage.cachedInputTokens).toBe(3);
    expect(usage.cacheCreationTokens).toBe(2);
    expect(usage.hasUsage).toBe(true);
  });
});
