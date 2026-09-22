import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

const AskUserQuestionInput = Schema.Struct({
  question: TrimmedNonEmptyString.annotate({
    description: "The question to ask, phrased so a short answer resolves it.",
  }),
  header: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "A short label for the question, at most a few words.",
    }),
  ),
  options: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString.annotate({
        description: 'Short choice text shown on the button, for example "Use SQLite".',
      }),
      description: Schema.String.annotate({
        description: "One line explaining what choosing this does.",
      }),
    }),
  ).annotate({
    description:
      "Two to four choices. Each needs a label and a one-line description of what choosing it does.",
  }),
  allowCustomAnswer: Schema.optional(
    Schema.Boolean.annotate({
      description: "Allow a free-form answer in addition to the listed options.",
    }),
  ),
});
export type AskUserQuestionInput = typeof AskUserQuestionInput.Type;

export const AskUserAnswered = Schema.Struct({
  answered: Schema.Literal(true),
  /** Chosen labels, in order. Multiple entries only when multiSelect is enabled. */
  selected: Schema.Array(TrimmedNonEmptyString),
  /** Present when the user typed a custom answer instead of choosing. */
  customAnswer: Schema.optional(TrimmedNonEmptyString),
});
export type AskUserAnswered = typeof AskUserAnswered.Type;

export const AskUserDismissed = Schema.Struct({
  answered: Schema.Literal(false),
});
export type AskUserDismissed = typeof AskUserDismissed.Type;

export const AskUserResult = Schema.Union([AskUserAnswered, AskUserDismissed]);
export type AskUserResult = typeof AskUserResult.Type;

export class AskUserUnavailableError extends Schema.TaggedError<AskUserUnavailableError>()(
  "AskUserUnavailableError",
  {},
) {
  override get message(): string {
    return "The current provider session cannot ask structured questions. Ask in plain text instead.";
  }
}

export class AskUserFailedError extends Schema.TaggedError<AskUserFailedError>()(
  "AskUserFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Asking the user failed.";
  }
}

const AskUserToolError = Schema.Union([
  AskUserUnavailableError,
  AskUserFailedError,
  McpCapabilityUnavailableError,
]);

export const AskUserToolkit = Toolkit.make(
  Tool.make("ask_user", {
    description:
      "Ask the person driving this thread a structured question and wait for their answer. Use it when one of the options changes what you do next and guessing would waste a whole turn, for example choosing between two designs or confirming a destructive step. The question appears in the T3 Code UI with your options; this tool returns what they picked.",
    parameters: AskUserQuestionInput,
    success: AskUserResult,
    failure: AskUserToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Ask the user a question")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false),
);
