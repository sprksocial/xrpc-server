import assert from "node:assert";
import type { IncomingMessage } from "node:http";
import type { Duplex, Readable } from "node:stream";
import { jsonToLex } from "@atproto/lexicon";
import type {
  Lexicons,
  LexXrpcProcedure,
  LexXrpcQuery,
  LexXrpcSubscription,
} from "@atproto/lexicon";
import { handlerSuccess, InternalServerError, InvalidRequestError } from "./types.ts";
import type {
  HandlerInput,
  HandlerSuccess,
  Params,
  UndecodedParams,
} from "./types.ts";
import { Buffer } from "node:buffer";

// Add type at the top
type StreamDestination = Duplex | NodeJS.WritableStream;
type StreamListener = (...args: unknown[]) => void;
type ReadableStreamLike = Pick<Readable, "pipe" | "on" | "removeListener">;

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

// Update RequestLike interface
export type RequestLike =
  & {
    headers: { [key: string]: string | string[] | undefined };
    body?: unknown;
    readableEnded?: boolean;
    method?: string;
    url?: string;
  }
  & Partial<ReadableStreamLike>
  & {
    destroy?: () => void;
    resume?: () => void;
    pause?: () => void;
    unpipe?: (destination?: StreamDestination) => void;
  };

export async function validateInput(
  nsid: string,
  def: LexXrpcProcedure | LexXrpcQuery,
  body: unknown,
  contentType: string | undefined | null,
  lexicons: Lexicons,
): Promise<HandlerInput | undefined> {
  let processedBody = body;
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    processedBody = Buffer.concat(chunks);
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
  if (Buffer.isBuffer(body) && body.length === 0 && !contentType) {
    return "missing";
  }
  if (body instanceof Uint8Array && body.length === 0 && !contentType) {
    return "missing";
  }
  return "present";
}

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

export interface ServerTiming {
  name: string;
  duration?: number;
  description?: string;
}

export const parseReqNsid = (
  req: IncomingMessage & { originalUrl?: string },
): string =>
  parseUrlNsid(req.originalUrl || (req.url || "/"));

/**
 * Validates and extracts the nsid from an xrpc path
 */
export const parseUrlNsid = (url: string): string => {
  // /!\ Hot path

  if (
    // Ordered by likelihood of failure
    url.length <= 6 ||
    url[5] !== "/" ||
    url[4] !== "c" ||
    url[3] !== "p" ||
    url[2] !== "r" ||
    url[1] !== "x" ||
    url[0] !== "/"
  ) {
    throw new InvalidRequestError("invalid xrpc path");
  }

  const startOfNsid = 6;

  let curr = startOfNsid;
  let char: number;
  let alphaNumRequired = true;
  for (; curr < url.length; curr++) {
    char = url.charCodeAt(curr);
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
      if (curr === url.length - 1 || url.charCodeAt(curr + 1) === 63) {
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

  return url.slice(startOfNsid, curr);
};
