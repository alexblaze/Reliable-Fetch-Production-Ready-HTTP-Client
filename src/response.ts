import { ParseError } from "./errors/errors.js";
import { discardBody } from "./utils/abort.js";

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface ParseContext {
  requestId?: string | undefined;
  attempts?: number | undefined;
  url?: string | undefined;
  maxBytes?: number;
}

function meta(response: Response, ctx: ParseContext) {
  return {
    requestId: ctx.requestId,
    attempts: ctx.attempts,
    url: ctx.url,
    status: response.status,
  };
}

/** Reads the body as text with a hard size limit, never buffering more than `maxBytes`. */
export async function readTextLimited(response: Response, ctx: ParseContext = {}): Promise<string> {
  const maxBytes = ctx.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const contentType = response.headers.get("content-type");
  if (response.bodyUsed)
    throw new ParseError("Response body was already consumed", contentType, meta(response, ctx));

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discardBody(response.body);
    throw new ParseError(
      `Response body exceeds maxResponseBytes (${maxBytes})`,
      contentType,
      meta(response, ctx),
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        discardBody(reader);
        throw new ParseError(
          `Response body exceeds maxResponseBytes (${maxBytes})`,
          contentType,
          meta(response, ctx),
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null || contentType === "") return true; // no declared type: try to parse
  const essence = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return essence === "application/json" || essence.endsWith("+json");
}

/**
 * Strict JSON parsing: rejects non-JSON content types, empty bodies, and malformed JSON.
 * Error messages never include body content.
 */
export async function parseJsonResponse<T>(response: Response, ctx: ParseContext = {}): Promise<T> {
  const contentType = response.headers.get("content-type");
  if (!isJsonContentType(contentType)) {
    discardBody(response.body);
    throw new ParseError(
      `Expected a JSON response but received "${contentType}"`,
      contentType,
      meta(response, ctx),
    );
  }
  const text = await readTextLimited(response, ctx);
  if (text.trim() === "") {
    throw new ParseError("Response body is empty; expected JSON", contentType, meta(response, ctx));
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ParseError("Response body is not valid JSON", contentType, meta(response, ctx));
  }
}
