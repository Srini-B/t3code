import type { ProviderSendTurnInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import type { AmpInputBlock } from "./AmpProtocol.ts";
const requestError = (method: string, cause: unknown) =>
  new ProviderAdapterRequestError({
    provider: "amp",
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
export const buildAmpPrompt = Effect.fn("buildAmpPrompt")(function* (
  input: ProviderSendTurnInput,
  attachmentsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const content: Array<AmpInputBlock> = [];
  if (input.input?.trim()) content.push({ type: "text", text: input.input });
  for (const attachment of input.attachments ?? []) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: attachmentsDir,
      attachment,
    });
    if (!attachmentPath)
      return yield* requestError("attachment/read", `Invalid attachment id '${attachment.id}'.`);
    if (attachment.type !== "image") {
      content.push({ type: "text", text: `Attached file: ${attachmentPath}` });
      continue;
    }
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mimeType))
      return yield* requestError(
        "attachment/read",
        `Amp does not support ${attachment.mimeType} images.`,
      );
    const bytes = yield* fs
      .readFile(attachmentPath)
      .pipe(Effect.mapError((cause) => requestError("attachment/read", cause)));
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      },
    });
  }
  if (content.length === 0)
    return yield* new ProviderAdapterValidationError({
      provider: "amp",
      operation: "sendTurn",
      issue: "Turn requires text or attachments.",
    });
  return content;
});
