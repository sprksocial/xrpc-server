import type {
  Lexicons,
  LexXrpcProcedure,
  LexXrpcQuery,
  LexXrpcSubscription,
} from "@atproto/lexicon";
import { jsonToLex } from "@atproto/lexicon";
import {
  handlerSuccess,
  InternalServerError,
  InvalidRequestError,
} from "./types.ts";
import type {
  HandlerInput,
  HandlerSuccess,
  Params,
  UndecodedParams,
} from "./types.ts";
import type { HonoRequest } from "hono";

function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

/**
 * Decodes query parameters.
 * @param def - The definition of the method
 * @param params - The parameters to decode
 * @returns The decoded parameters
 */
export function decodeQueryParams(
  def: LexXrpcProcedure | LexXrpcQuery | LexXrpcSubscription,
  params: UndecodedParams,
): Params {
  const decoded: Params = {};
  for (const k in def.parameters?.properties) {
    const property = def.parameters?.properties[k];
    const val = params[k];
    if (property && val !== undefined) {
      if (property.type === "array") {
        const vals = (Array.isArray(val) ? val : [val]).filter(
          (v) => v !== undefined,
        );
        decoded[k] = vals
          .map((v) => decodeQueryParam(property.items.type, v))
          .filter((v) => v !== undefined) as (string | number | boolean)[];
      } else {
        const actualVal = Array.isArray(val) ? val[0] : val;
        decoded[k] = decodeQueryParam(property.type, actualVal);
      }
    }
  }
  return decoded;
}

/**
 * Decodes a query parameter.
 * @param type - The type of the parameter
 * @param value - The value of the parameter
 * @returns The decoded parameter
 */
export function decodeQueryParam(
  type: string,
  value: unknown,
): string | number | boolean | undefined {
  if (!value) {
    return undefined;
  }
  if (type === "string" || type === "datetime") {
    return String(value);
  }
  if (type === "float") {
    return Number(String(value));
  } else if (type === "integer") {
    return parseInt(String(value), 10) || 0;
  } else if (type === "boolean") {
    return value === "true";
  }
}

export function getQueryParams(url = ""): Record<string, string[]> {
  const { searchParams } = new URL(url ?? "", "http://x");
  const result: Record<string, string[]> = {};
  for (const key of searchParams.keys()) {
    result[key] = searchParams.getAll(key);
  }
  return result;
}

/**
 * Represents a request-like object with essential HTTP request properties.
 * Used for handling both standard HTTP requests and custom request implementations.
 * @interface
 * @property {Headers | { [key: string]: string | string[] | undefined }} [headers] - HTTP headers as either a Headers object or a key-value map
 * @property {ReadableStream | unknown} [body] - Request body as either a ReadableStream or any other data type
 * @property {string} [method] - HTTP method (GET, POST, etc.)
 * @property {string} [url] - Full URL of the request
 * @property {AbortSignal} [signal] - AbortSignal for request cancellation
 */
export type RequestLike = {
  headers: Headers | { [key: string]: string | string[] | undefined };
  body?: ReadableStream | unknown;
  method?: string;
  url?: string;
  signal?: AbortSignal;
};

/**
 * Validates the input of an xrpc method.
 * @param nsid - The NSID of the method
 * @param def - The definition of the method
 * @param body - The body of the request
 * @param contentType - The content type of the request
 * @param lexicons - The lexicons to use
 */
export async function validateInput(
  nsid: string,
  def: LexXrpcProcedure | LexXrpcQuery,
  body: unknown,
  contentType: string | undefined | null,
  lexicons: Lexicons,
): Promise<HandlerInput | undefined> {
  let processedBody: unknown | Uint8Array = body;
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const tempBody = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      tempBody.set(chunk, offset);
      offset += chunk.length;
    }
    processedBody = tempBody;
  }

  const bodyPresence = getBodyPresence(processedBody, contentType);
  if (bodyPresence === "present" && (def.type !== "procedure" || !def.input)) {
    throw new InvalidRequestError(
      `A request body was provided when none was expected`,
    );
  }
  if (def.type === "query") {
    return;
  }
  if (bodyPresence === "missing" && def.input) {
    throw new InvalidRequestError(
      `A request body is expected but none was provided`,
    );
  }

  // mimetype
  const inputEncoding = normalizeMime(contentType || "");
  if (
    def.input?.encoding &&
    (!inputEncoding || !isValidEncoding(def.input?.encoding, inputEncoding))
  ) {
    if (!inputEncoding) {
      throw new InvalidRequestError(
        `Request encoding (Content-Type) required but not provided`,
      );
    } else {
      throw new InvalidRequestError(
        `Wrong request encoding (Content-Type): ${inputEncoding}`,
      );
    }
  }

  if (!inputEncoding) {
    // no input body
    return undefined;
  }

  // if input schema, validate
  if (def.input?.schema) {
    try {
      const lexBody = processedBody ? jsonToLex(processedBody) : processedBody;
      processedBody = lexicons.assertValidXrpcInput(nsid, lexBody);
    } catch (e) {
      throw new InvalidRequestError(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    encoding: inputEncoding,
    body: processedBody,
  };
}

/**
 * Validates the output of an xrpc method.
 * @param nsid - The NSID of the method
 * @param def - The definition of the method
 * @param output - The output of the method
 * @param lexicons - The lexicons to use
 */
export function validateOutput(
  nsid: string,
  def: LexXrpcProcedure | LexXrpcQuery,
  output: HandlerSuccess | undefined,
  lexicons: Lexicons,
): void {
  // initial validation
  if (output) {
    handlerSuccess.parse(output);
  }

  // response expectation
  if (output?.body && !def.output) {
    throw new InternalServerError(
      `A response body was provided when none was expected`,
    );
  }
  if (!output?.body && def.output) {
    throw new InternalServerError(
      `A response body is expected but none was provided`,
    );
  }

  // mimetype
  if (
    def.output?.encoding &&
    (!output?.encoding ||
      !isValidEncoding(def.output?.encoding, output?.encoding))
  ) {
    throw new InternalServerError(
      `Invalid response encoding: ${output?.encoding}`,
    );
  }

  // output schema
  if (def.output?.schema) {
    try {
      const result = lexicons.assertValidXrpcOutput(nsid, output?.body);
      if (output) {
        output.body = result;
      }
    } catch (e) {
      throw new InternalServerError(e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Normalize a mime type
 * @param mime - The mime type to normalize
 * @returns The normalized mime type
 */
export function normalizeMime(mime: string): string {
  const [base] = mime.split(";");
  return base.trim().toLowerCase();
}

function isValidEncoding(expected: string, actual: string): boolean {
  if (expected === "*/*") return true;
  if (expected === actual) return true;
  if (expected === "application/json" && actual === "json") return true;
  return false;
}

function getBodyPresence(
  body: unknown,
  contentType: string | undefined | null,
): "present" | "missing" {
  if (body === undefined || body === null) {
    return "missing";
  }
  if (typeof body === "string" && body.length === 0 && !contentType) {
    return "missing";
  }
  if (body instanceof Uint8Array && body.length === 0 && !contentType) {
    return "missing";
  }
  return "present";
}

/**
 * Server timing header
 * @param timings - The timings to format
 * @returns The formatted header
 */
export function serverTimingHeader(timings: ServerTiming[]): string {
  return timings
    .map((timing) => {
      let header = timing.name;
      if (timing.duration) header += `;dur=${timing.duration}`;
      if (timing.description) header += `;desc="${timing.description}"`;
      return header;
    })
    .join(", ");
}

/**
 * Server timer
 * @prop name - The name of the timer
 * @prop description - The description of the timer
 * @prop duration - The duration of the timer
 */
export class ServerTimer implements ServerTiming {
  public duration?: number;
  private startMs?: number;
  constructor(
    public name: string,
    public description?: string,
  ) {}
  start(): ServerTimer {
    this.startMs = Date.now();
    return this;
  }
  stop(): ServerTimer {
    assert(this.startMs, "timer hasn't been started");
    this.duration = Date.now() - this.startMs;
    return this;
  }
}

/**
 * Represents timing information for server-side operations.
 * Used for performance monitoring and debugging.
 * @interface
 * @property {string} name - Identifier for the timing measurement
 * @property {number} [duration] - Duration of the operation in milliseconds
 * @property {string} [description] - Optional description of what was timed
 */
export interface ServerTiming {
  name: string;
  duration?: number;
  description?: string;
}

/**
 * Represents a minimal HTTP request with essential properties.
 * Used when full request information is not needed.
 * @interface
 * @property {string} [url] - The URL of the request
 * @property {string} [method] - The HTTP method (GET, POST, etc.)
 * @property {Headers | { [key: string]: string | string[] | undefined }} headers - Request headers as either a Headers object or a key-value map
 */
export interface MinimalRequest {
  url?: string;
  method?: string;
  headers: Headers | { [key: string]: string | string[] | undefined };
}

/**
 * Validates and extracts the NSID from a request.
 * Can be used for auth verifiers.
 * @param req - The request to parse
 * @returns The extracted NSID
 */
export const parseReqNsid = (
  req: MinimalRequest | HonoRequest,
): string => parseUrlNsid(req.url || "/");

/**
 * Validates and extracts the NSID from a URL.
 * @param url - The URL to parse
 * @returns The extracted NSID
 */
export const parseUrlNsid = (url: string): string => {
  // Extract path from full URL if needed
  let path = url;
  try {
    const urlObj = new URL(url);
    path = urlObj.pathname;
  } catch {
    // If URL parsing fails, assume it's already a path
  }

  if (
    // Ordered by likelihood of failure
    path.length <= 6 ||
    path[5] !== "/" ||
    path[4] !== "c" ||
    path[3] !== "p" ||
    path[2] !== "r" ||
    path[1] !== "x" ||
    path[0] !== "/"
  ) {
    throw new InvalidRequestError("invalid xrpc path");
  }

  const startOfNsid = 6;

  let curr = startOfNsid;
  let char: number;
  let alphaNumRequired = true;
  for (; curr < path.length; curr++) {
    char = path.charCodeAt(curr);
    if (
      (char >= 48 && char <= 57) || // 0-9
      (char >= 65 && char <= 90) || // A-Z
      (char >= 97 && char <= 122) // a-z
    ) {
      alphaNumRequired = false;
    } else if (char === 45 /* "-" */ || char === 46 /* "." */) {
      if (alphaNumRequired) {
        throw new InvalidRequestError("invalid xrpc path");
      }
      alphaNumRequired = true;
    } else if (char === 47 /* "/" */) {
      // Allow trailing slash (next char is either EOS or "?")
      if (curr === path.length - 1 || path.charCodeAt(curr + 1) === 63) {
        break;
      }
      throw new InvalidRequestError("invalid xrpc path");
    } else if (char === 63 /* "?"" */) {
      break;
    } else {
      throw new InvalidRequestError("invalid xrpc path");
    }
  }

  // last char was one of: '-', '.', '/'
  if (alphaNumRequired) {
    throw new InvalidRequestError("invalid xrpc path");
  }

  // A domain name consists of minimum two characters
  if (curr - startOfNsid < 2) {
    throw new InvalidRequestError("invalid xrpc path");
  }

  // @TODO is there a max ?

  return path.slice(startOfNsid, curr);
};
