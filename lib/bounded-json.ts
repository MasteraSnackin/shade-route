export type BoundedJsonErrorCode =
  | "empty_body"
  | "invalid_json"
  | "payload_too_large"
  | "unreadable_body";

const ERROR_MESSAGES: Record<BoundedJsonErrorCode, string> = {
  empty_body: "The JSON payload was empty.",
  invalid_json: "The payload was not valid JSON.",
  payload_too_large: "The JSON payload exceeded the permitted size.",
  unreadable_body: "The JSON payload could not be read.",
};

/** A narrow error contract for expected JSON transport failures. */
export class BoundedJsonError extends Error {
  readonly code: BoundedJsonErrorCode;

  constructor(code: BoundedJsonErrorCode, cause?: unknown) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "BoundedJsonError";
    this.code = code;
  }
}

/**
 * Read JSON without trusting Content-Length alone. The stream is counted as it
 * is consumed so chunked and incorrectly declared bodies remain bounded.
 */
export async function readBoundedJson(
  source: Request | Response,
  maximumBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximumBytes must be a positive safe integer.");
  }

  const contentLength = source.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new BoundedJsonError("payload_too_large");
    }
  }
  if (!source.body) throw new BoundedJsonError("empty_body");

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = source.body.getReader();
  } catch (cause) {
    throw new BoundedJsonError("unreadable_body", cause);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // A failed cleanup must not replace the actionable size error.
        }
        throw new BoundedJsonError("payload_too_large");
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof BoundedJsonError) throw cause;
    throw new BoundedJsonError("unreadable_body", cause);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already have released its lock after cancellation.
    }
  }

  if (totalBytes === 0) throw new BoundedJsonError("empty_body");
  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new BoundedJsonError("invalid_json", cause);
  }
}
