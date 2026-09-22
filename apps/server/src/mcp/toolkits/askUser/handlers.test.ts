import { describe, expect, it } from "vite-plus/test";

import { toContractQuestions, selectedLabelsOf } from "./handlers.ts";

describe("ask_user question mapping", () => {
  it("maps the agent-facing input onto the contract question with label values", () => {
    const [question] = toContractQuestions({
      question: "Which storage engine?",
      header: "Storage",
      options: [
        { label: "SQLite", description: "Embedded, zero setup" },
        { label: "Postgres", description: "Networked server" },
      ],
      allowCustomAnswer: true,
    });

    expect(question?.id).toBe("ask_user");
    expect(question?.header).toBe("Storage");
    expect(question?.question).toBe("Which storage engine?");
    expect(question?.allowCustomAnswer).toBe(true);
    expect(question?.multiSelect).toBe(false);
    expect(question?.options).toEqual([
      { label: "SQLite", description: "Embedded, zero setup", value: "SQLite" },
      { label: "Postgres", description: "Networked server", value: "Postgres" },
    ]);
  });

  it("falls back to a single OK option and trims blanks out of the list", () => {
    const [question] = toContractQuestions({
      question: "Proceed?",
      options: [
        { label: "   ", description: "blank labels are dropped" },
        { label: "Go", description: "" },
      ],
    });
    expect(question?.options).toEqual([{ label: "Go", description: "Go", value: "Go" }]);

    const [fallback] = toContractQuestions({ question: "Proceed?", options: [] });
    expect(fallback?.options).toEqual([{ label: "OK", description: "Continue", value: "OK" }]);
    // A missing header falls back to the generic label.
    expect(fallback?.header).toBe("Question");
  });

  it("bounds oversized question text and labels with an ellipsis", () => {
    const [question] = toContractQuestions({
      question: "q".repeat(3_000),
      options: [{ label: "l".repeat(400), description: "d".repeat(900) }],
    });
    expect(question?.question.length).toBeLessThanOrEqual(2_001);
    expect(question?.question.endsWith("…")).toBe(true);
    expect(question?.options[0]?.label.length).toBeLessThanOrEqual(201);
    expect(question?.options[0]?.description.length).toBeLessThanOrEqual(501);
  });
});

describe("ask_user answer extraction", () => {
  it("reads label arrays and single strings, and ignores non-strings", () => {
    expect(selectedLabelsOf({ ask_user: ["A", "B"] })).toEqual(["A", "B"]);
    expect(selectedLabelsOf({ ask_user: "A" })).toEqual(["A"]);
    expect(selectedLabelsOf({ ask_user: [1, "A", null] })).toEqual(["A"]);
    expect(selectedLabelsOf({ ask_user: { nested: true } })).toEqual([]);
    expect(selectedLabelsOf({})).toEqual([]);
  });
});
