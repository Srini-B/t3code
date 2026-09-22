import * as Effect from "effect/Effect";

import type { UserInputQuestion } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readAmpUserInputBridge } from "../../../provider/amp/AmpUserInputBridge.ts";
import {
  AskUserFailedError,
  AskUserUnavailableError,
  AskUserToolkit,
  type AskUserQuestionInput,
} from "./tools.ts";

const MAX_OPTIONS = 8;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_QUESTION_CHARS = 2_000;

const cut = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/** A label that still has content after trimming. */
const isNonEmptyLabel = (value: string): boolean => value.trim().length > 0;

/**
 * Maps the tool's agent-facing shape onto T3's `UserInputQuestion` contract.
 * The option `value` carries the label back, so the answer needs no mapping on
 * the way out. Exported for the mapping regression tests.
 */
export function toContractQuestions(input: AskUserQuestionInput): ReadonlyArray<UserInputQuestion> {
  const trimmedOptions = input.options.flatMap((option) => {
    const label = option.label.trim();
    const description = (option.description ?? label).trim() || label;
    return label.length > 0
      ? [
          {
            label: cut(label, MAX_LABEL_CHARS),
            description: cut(description, MAX_DESCRIPTION_CHARS),
            value: label,
          },
        ]
      : [];
  });
  return [
    {
      id: "ask_user",
      header: cut((input.header ?? "Question").trim(), 60),
      question: cut(input.question.trim(), MAX_QUESTION_CHARS),
      options:
        trimmedOptions.length > 0
          ? trimmedOptions.slice(0, MAX_OPTIONS)
          : [{ label: "OK", description: "Continue", value: "OK" }],
      ...(input.allowCustomAnswer === true ? { allowCustomAnswer: true } : {}),
      multiSelect: false,
    },
  ];
}

/** Extracts the chosen labels from the recorded T3 answer record. Exported for the mapping regression tests. */
export function selectedLabelsOf(answer: Record<string, unknown>): Array<string> {
  const raw = answer.ask_user;
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === "string");
  if (typeof raw === "string") return [raw];
  return [];
}

const ask_user = (input: AskUserQuestionInput) =>
  McpInvocationContext.requireMcpCapability("ask-user").pipe(
    Effect.flatMap((scope) => askUserFor(scope, input)),
  );

const make = Effect.succeed({ ask_user });

const askUserFor = (scope: McpInvocationContext.McpInvocationScope, input: AskUserQuestionInput) =>
  Effect.gen(function* () {
    const bridge = readAmpUserInputBridge(scope.threadId, scope.environmentId);
    if (!bridge) {
      return yield* new AskUserUnavailableError({});
    }
    const questions = toContractQuestions(input);
    const answer = yield* Effect.tryPromise({
      try: () => bridge.openQuestion(questions),
      catch: (cause) => new AskUserFailedError({ cause }),
    });
    if (answer === undefined) {
      return { answered: false } as const;
    }
    const selected = selectedLabelsOf(answer).filter((label) => isNonEmptyLabel(label));
    if (selected.length === 0) {
      return { answered: false } as const;
    }
    const knownLabels = new Set((questions[0]?.options ?? []).map((option) => option.label));
    const custom = selected.filter((label) => !knownLabels.has(label));
    return {
      answered: true,
      selected: selected.slice(0, MAX_OPTIONS),
      ...(custom.length > 0 ? { customAnswer: cut(custom.join(" | "), MAX_LABEL_CHARS) } : {}),
    } as const;
  });

export const AskUserToolkitHandlersLive = AskUserToolkit.toLayer(make);
