import { EnvironmentId, ThreadId, type UserInputQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clearAllAmpUserInputBridges,
  clearAmpUserInputBridge,
  readAmpUserInputBridge,
  setAmpUserInputBridge,
} from "./AmpUserInputBridge.ts";

const threadId = ThreadId.make("thread-1");
const environmentId = EnvironmentId.make("env-1");

const question: UserInputQuestion = {
  id: "ask_user",
  header: "Question",
  question: "Which color?",
  options: [{ label: "Red", description: "Red", value: "Red" }],
  multiSelect: false,
};

const bridge = {
  openQuestion: () => Promise.resolve(undefined),
};

describe("AmpUserInputBridge", () => {
  it("returns the bridge for a matching thread and environment", () => {
    setAmpUserInputBridge({ threadId, environmentId, bridge });
    try {
      expect(readAmpUserInputBridge(threadId, environmentId)).toBe(bridge);
    } finally {
      clearAmpUserInputBridge(threadId);
    }
  });

  it("rejects a different environment's credential for the same thread", () => {
    setAmpUserInputBridge({ threadId, environmentId, bridge });
    try {
      expect(readAmpUserInputBridge(threadId, EnvironmentId.make("env-2"))).toBeUndefined();
    } finally {
      clearAmpUserInputBridge(threadId);
    }
  });

  it("does not match when no bridge was installed or after clearing", () => {
    expect(readAmpUserInputBridge(threadId, environmentId)).toBeUndefined();
    setAmpUserInputBridge({ threadId, environmentId, bridge });
    clearAmpUserInputBridge(threadId);
    expect(readAmpUserInputBridge(threadId, environmentId)).toBeUndefined();
    setAmpUserInputBridge({ threadId, environmentId, bridge });
    clearAllAmpUserInputBridges();
    expect(readAmpUserInputBridge(threadId, environmentId)).toBeUndefined();
  });

  it("matches a bridge installed with an undefined environment id only when the scope has none", () => {
    setAmpUserInputBridge({ threadId, environmentId: undefined, bridge });
    try {
      expect(readAmpUserInputBridge(threadId, undefined)).toBe(bridge);
      expect(readAmpUserInputBridge(threadId, environmentId)).toBeUndefined();
    } finally {
      clearAmpUserInputBridge(threadId);
    }
  });

  it("openQuestion resolves with the recorded answers", async () => {
    const questions = [question];
    const recorded: unknown[] = [];
    setAmpUserInputBridge({
      threadId,
      environmentId,
      bridge: {
        openQuestion: async (input) => {
          recorded.push(input);
          return { ask_user: ["Red"] };
        },
      },
    });
    try {
      const resolved = readAmpUserInputBridge(threadId, environmentId);
      expect(resolved).toBeDefined();
      const answer = await resolved!.openQuestion(questions);
      expect(answer).toEqual({ ask_user: ["Red"] });
      expect(recorded).toEqual([questions]);
    } finally {
      clearAmpUserInputBridge(threadId);
    }
  });
});
