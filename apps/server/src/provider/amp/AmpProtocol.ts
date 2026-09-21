import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
export const encodeAmpPermissionInput = Schema.encodeSync(Schema.fromJsonString(JsonObject));
const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const ThinkingBlock = Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String });
const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: JsonObject,
});
const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(TextBlock)]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
  ),
  is_error: Schema.optionalKey(Schema.Boolean),
});
const RedactedBlock = Schema.Struct({ type: Schema.Literal("redacted_thinking") });
const ContentBlock = Schema.Union([
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  RedactedBlock,
]);
export type AmpContentBlock = typeof ContentBlock.Type;

export const AmpUsage = Schema.Struct({
  input_tokens: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  output_tokens: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cache_creation_input_tokens: Schema.optionalKey(Schema.Finite),
  cache_read_input_tokens: Schema.optionalKey(Schema.Finite),
  max_tokens: Schema.optionalKey(Schema.Finite),
});
export type AmpUsage = typeof AmpUsage.Type;

const SessionFields = { session_id: Schema.optionalKey(Schema.String) };
const ParentFields = { parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)) };
export const AmpMessage = Schema.Union([
  Schema.Struct({
    ...SessionFields,
    type: Schema.Literal("system"),
    subtype: Schema.String,
    cwd: Schema.optionalKey(Schema.String),
    agent_mode: Schema.optionalKey(Schema.String),
    tools: Schema.optionalKey(Schema.Array(Schema.String)),
    error: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...SessionFields,
    ...ParentFields,
    type: Schema.Literal("assistant"),
    message: Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.String),
      content: Schema.Array(ContentBlock),
      stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
      usage: Schema.optionalKey(AmpUsage),
    }),
  }),
  Schema.Struct({
    ...SessionFields,
    ...ParentFields,
    type: Schema.Literal("user"),
    message: Schema.Struct({ content: Schema.Array(ContentBlock) }),
  }),
  Schema.Struct({
    ...SessionFields,
    type: Schema.Literal("result"),
    subtype: Schema.String,
    is_error: Schema.Boolean,
    result: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
    errors: Schema.optionalKey(Schema.Array(Schema.String)),
    duration_ms: Schema.optionalKey(Schema.Finite),
    usage: Schema.optionalKey(AmpUsage),
  }),
]);
export type AmpMessage = typeof AmpMessage.Type;
export const decodeAmpMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(AmpMessage));

export const AmpResume = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
  turnIds: Schema.Array(Schema.String),
  turnPromptOffsets: Schema.optionalKey(
    Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  promptCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  features: Schema.optionalKey(Schema.Array(Schema.Literals(["fast", "pro"]))),
});
export const decodeAmpResume = Schema.decodeUnknownExit(AmpResume);

export type AmpInputBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source: {
        readonly type: "base64";
        readonly media_type: string;
        readonly data: string;
      };
    };

export function encodeAmpInput(
  content: ReadonlyArray<AmpInputBlock>,
  requestId: string,
  steer: boolean,
) {
  return (
    JSON.stringify({
      type: "user",
      request_id: requestId,
      ...(steer ? { steer: true } : {}),
      message: { role: "user", content },
    }) + "\n"
  );
}

export const AmpPermissionRequest = Schema.Struct({
  tool: Schema.String,
  input: JsonObject,
});
export type AmpPermissionRequest = typeof AmpPermissionRequest.Type;
