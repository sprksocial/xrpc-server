import type { Context, Next, HonoRequest } from "hono";
import { isHttpError } from "http-errors";
import { z } from "zod";
import {
  httpResponseCodeToName,
  httpResponseCodeToString,
  ResponseType,
  ResponseTypeStrings,
  XRPCError as XRPCClientError,
} from "@atproto/xrpc";

type ErrorOptions = {
  cause?: unknown;
};

export type CatchallHandler = (
  c: Context,
  next: () => Promise<void>,
) => unknown;

export type Options = {
  validateResponse?: boolean;
  catchall?: (c: Context, next: Next) => Promise<Response | void>;
  payload?: {
    jsonLimit?: number;
    blobLimit?: number;
    textLimit?: number;
  };
  rateLimits?: {
    creator: RateLimiterCreator;
    global?: ServerRateLimitDescription[];
    shared?: ServerRateLimitDescription[];
  };
  /**
   * By default, errors are converted to {@link XRPCError} using
   * {@link XRPCError.fromError} before being rendered. If method handlers throw
   * error objects that are not properly rendered in the HTTP response, this
   * function can be used to properly convert them to {@link XRPCError}. The
   * provided function will typically fallback to the default error conversion
   * (`return XRPCError.fromError(err)`) if the error is not recognized.
   *
   * @note This function should not throw errors.
   */
  errorParser?: (err: unknown) => XRPCError;
};

export type UndecodedParams = Record<string, string | string[]>;

export type Primitive = string | number | boolean;
export type Params = Record<string, Primitive | Primitive[] | undefined>;

export type HandlerInput = {
  encoding: string;
  body: unknown;
};

export const handlerInput = z.object({
  encoding: z.string(),
  body: z.unknown(),
}).required().strict() as z.ZodType<HandlerInput>;

export type HandlerAuth = {
  credentials: unknown;
  artifacts: unknown;
};

export type NullAuthOutput = HandlerAuth & {
  credentials: {
    type: "none";
    iss: null;
  };
  artifacts: Record<string, never>;
};

export type StandardAuthOutput = HandlerAuth & {
  credentials: {
    type: "standard";
    aud: string;
    iss: string;
  };
  artifacts: Record<string, never>;
};

export type RoleAuthOutput = HandlerAuth & {
  credentials: {
    type: "role";
    admin: boolean;
  };
  artifacts: Record<string, never>;
};

export type ModServiceAuthOutput = HandlerAuth & {
  credentials: {
    type: "mod_service";
    aud: string;
    iss: string;
  };
  artifacts: Record<string, never>;
};

export const handlerAuth = z.object({
  credentials: z.unknown(),
  artifacts: z.unknown(),
}).required({
  credentials: true,
  artifacts: true
}).strict() as z.ZodType<HandlerAuth>;

export const headersSchema: z.ZodType<Record<string, string>> = z.record(z.string());

export type HandlerSuccess = {
  encoding: string;
  body: unknown;
  headers?: Record<string, string>;
};

export const handlerSuccess = z.object({
  encoding: z.string(),
  body: z.unknown(),
  headers: headersSchema.optional(),
}).strict() as z.ZodType<HandlerSuccess>;

export type HandlerPipeThroughStream = {
  encoding: string;
  stream: ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
};

export const handlerPipeThroughStream: z.ZodType<HandlerPipeThroughStream> = z.object({
  encoding: z.string(),
  stream: z.custom<ReadableStream<Uint8Array>>((val) => val instanceof ReadableStream),
  headers: headersSchema.optional(),
});

export type HandlerPipeThroughBuffer = {
  encoding: string;
  buffer: Uint8Array;
  headers?: Record<string, string>;
};

export const handlerPipeThroughBuffer: z.ZodType<HandlerPipeThroughBuffer> = z.object({
  encoding: z.string(),
  buffer: z.custom<Uint8Array>((val) => val instanceof Uint8Array),
  headers: headersSchema.optional(),
});

export type HandlerPipeThrough = HandlerPipeThroughBuffer | HandlerPipeThroughStream;

export const handlerPipeThrough: z.ZodType<HandlerPipeThrough> = z.union([
  handlerPipeThroughBuffer,
  handlerPipeThroughStream,
]);

export type HandlerError = {
  status: number;
  error?: string;
  message?: string;
};

export const handlerError: z.ZodType<HandlerError> = z.object({
  status: z.number(),
  error: z.string().optional(),
  message: z.string().optional(),
});

export type HandlerOutput = HandlerSuccess | HandlerPipeThrough | HandlerError;

export type XRPCReqContext = {
  c: Context;
  params: Params;
  input: HandlerInput | undefined;
  auth: HandlerAuth | undefined;
  resetRouteRateLimits: () => Promise<void>;
  req?: HonoRequest;
};

export type XRPCStreamReqContext = {
  req: Request;
  params: Params;
  auth: HandlerAuth | undefined;
  signal: AbortSignal;
};

export type XRPCHandler = (
  ctx: XRPCReqContext,
) => Promise<HandlerOutput> | HandlerOutput | undefined;

export type XRPCStreamHandler = (ctx: {
  auth: HandlerAuth | undefined;
  params: Params;
  req: Request;
  signal: AbortSignal;
}) => AsyncIterable<unknown>;

export type AuthOutput = HandlerAuth | HandlerError;

export interface AuthVerifierContext {
  c: Context;
  req: HonoRequest;
}


export interface AuthVerifier {
  (ctx: AuthVerifierContext): Promise<AuthOutput> | AuthOutput;
}

export type StreamAuthVerifierContext = {
  req: Request;
};

export type StreamAuthVerifier = (
  ctx: StreamAuthVerifierContext,
) => Promise<AuthOutput> | AuthOutput;

export type CalcKeyFn = (ctx: XRPCReqContext) => string | null;
export type CalcPointsFn = (ctx: XRPCReqContext) => number;

export interface RateLimiterI {
  consume: RateLimiterConsume;
  reset: RateLimiterReset;
}

export type RateLimiterConsume = (
  ctx: XRPCReqContext,
  opts?: { calcKey?: CalcKeyFn; calcPoints?: CalcPointsFn },
) => Promise<RateLimiterStatus | RateLimitExceededError | null>;

export type RateLimiterReset = (
  ctx: XRPCReqContext,
  opts?: { calcKey?: CalcKeyFn },
) => Promise<void>;

export type RateLimiterCreator = (opts: {
  keyPrefix: string;
  durationMs: number;
  points: number;
  calcKey?: CalcKeyFn;
  calcPoints?: CalcPointsFn;
}) => RateLimiterI;

export type ServerRateLimitDescription = {
  name: string;
  durationMs: number;
  points: number;
  calcKey?: CalcKeyFn;
  calcPoints?: CalcPointsFn;
};

export type SharedRateLimitOpts = {
  name: string;
  calcKey?: CalcKeyFn;
  calcPoints?: CalcPointsFn;
};

export type RouteRateLimitOpts = {
  durationMs: number;
  points: number;
  calcKey?: CalcKeyFn;
  calcPoints?: CalcPointsFn;
};

export type HandlerRateLimitOpts = SharedRateLimitOpts | RouteRateLimitOpts;

export const isShared = (
  opts: HandlerRateLimitOpts,
): opts is SharedRateLimitOpts => {
  return "name" in opts &&
    typeof (opts as SharedRateLimitOpts).name === "string";
};

export type RateLimiterStatus = {
  limit: number;
  duration: number;
  remainingPoints: number;
  msBeforeNext: number;
  consumedPoints: number;
  isFirstInDuration: boolean;
};

export type RouteOpts = {
  blobLimit?: number;
};

export type XRPCHandlerConfig = {
  opts?: RouteOpts;
  rateLimit?: HandlerRateLimitOpts | HandlerRateLimitOpts[];
  auth?: AuthVerifier;
  handler: XRPCHandler;
};

export type XRPCStreamHandlerConfig = {
  auth?: StreamAuthVerifier;
  handler: XRPCStreamHandler;
};

export { ResponseType };

/**
 * Converts an upstream XRPC {@link ResponseType} into a downstream {@link ResponseType}.
 */
function mapFromClientError(error: XRPCClientError): {
  error: string;
  message: string;
  type: ResponseType;
} {
  switch (error.status) {
    case ResponseType.InvalidResponse:
      // Upstream server returned an XRPC response that is not compatible with our internal lexicon definitions for that XRPC method.
      // @NOTE This could be reflected as both a 500 ("we" are at fault) and 502 ("they" are at fault). Let's be gents about it.
      return {
        error: httpResponseCodeToName(ResponseType.InternalServerError),
        message: httpResponseCodeToString(ResponseType.InternalServerError),
        type: ResponseType.InternalServerError,
      };
    case ResponseType.Unknown:
      // Typically a network error / unknown host
      return {
        error: httpResponseCodeToName(ResponseType.InternalServerError),
        message: httpResponseCodeToString(ResponseType.InternalServerError),
        type: ResponseType.InternalServerError,
      };
    default:
      return {
        error: error.error,
        message: error.message,
        type: error.status,
      };
  }
}

export class XRPCError extends Error {
  public override cause?: unknown;

  constructor(
    public type: ResponseType,
    public errorMessage?: string,
    public customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(errorMessage);
    if (options?.cause) {
      this.cause = options.cause;
    }
  }

  get statusCode(): number {
    const { type } = this;

    // Fool-proofing. `new XRPCError(123.5 as number, '')` does not generate a TypeScript error.
    // Because of this, we can end-up with any numeric value instead of an actual `ResponseType`.
    // For legacy reasons, the `type` argument is not checked in the constructor, so we check it here.
    if (type < 400 || type >= 600 || !Number.isFinite(type)) {
      return 500;
    }

    return type;
  }

  get payload(): { error: string; message: string } {
    return {
      error: this.customErrorName ?? this.typeName ?? 'Unknown',
      message: this.type === ResponseType.InternalServerError
        ? this.typeStr ?? 'Internal Server Error'
        : this.errorMessage || this.typeStr || 'Unknown Error',
    };
  }

  get typeName(): string | undefined {
    return ResponseType[this.type];
  }

  get typeStr(): string | undefined {
    return ResponseTypeStrings[this.type];
  }

  static fromError(cause: unknown): XRPCError {
    if (cause instanceof XRPCError) {
      return cause;
    }

    if (cause instanceof XRPCClientError) {
      const { error, message, type } = mapFromClientError(cause);
      return new XRPCError(type, message, error, { cause });
    }

    if (isHttpError(cause)) {
      const httpError = cause as {
        status: number;
        message: string;
        name: string;
      };
      return new XRPCError(
        httpError.status,
        httpError.message,
        httpError.name,
        { cause },
      );
    }

    if (isHandlerError(cause)) {
      return this.fromHandlerError(cause);
    }

    if (cause instanceof Error) {
      return new InternalServerError(cause.message, undefined, { cause });
    }

    return new InternalServerError(
      "Unexpected internal server error",
      undefined,
      { cause },
    );
  }

  static fromHandlerError(err: HandlerError): XRPCError {
    return new XRPCError(err.status, err.message, err.error, { cause: err });
  }
}

export function isHandlerError(v: unknown): v is HandlerError {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.status === "number" &&
    (obj.error === undefined || typeof obj.error === "string") &&
    (obj.message === undefined || typeof obj.message === "string")
  );
}

export function isHandlerPipeThroughBuffer(
  v: HandlerOutput,
): v is HandlerPipeThroughBuffer {
  return "buffer" in v && (v as HandlerPipeThroughBuffer).buffer !== undefined;
}

export function isHandlerPipeThroughStream(
  v: HandlerOutput,
): v is HandlerPipeThroughStream {
  return "stream" in v && (v as HandlerPipeThroughStream).stream !== undefined;
}

export class InvalidRequestError extends XRPCError {
  constructor(message = "Invalid Request", error = "InvalidRequest") {
    super(ResponseType.InvalidRequest, message, error);
  }
}

export class PayloadTooLargeError extends XRPCError {
  constructor(message = "Request entity too large", error = "PayloadTooLarge") {
    super(ResponseType.PayloadTooLarge, message, error);
  }
}

export class AuthRequiredError extends XRPCError {
  constructor(
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(
      ResponseType.AuthenticationRequired,
      errorMessage,
      customErrorName,
      options,
    );
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.AuthenticationRequired
    );
  }
}

export class ForbiddenError extends XRPCError {
  constructor(
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(ResponseType.Forbidden, errorMessage, customErrorName, options);
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError && instance.type === ResponseType.Forbidden
    );
  }
}

export class RateLimitExceededError extends XRPCError {
  constructor(
    public status: RateLimiterStatus,
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(
      ResponseType.RateLimitExceeded,
      errorMessage,
      customErrorName,
      options,
    );
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.RateLimitExceeded
    );
  }
}

export class InternalServerError extends XRPCError {
  constructor(
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(
      ResponseType.InternalServerError,
      errorMessage,
      customErrorName,
      options,
    );
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.InternalServerError
    );
  }
}

export class UpstreamFailureError extends XRPCError {
  constructor(
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(ResponseType.UpstreamFailure, errorMessage, customErrorName, options);
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.UpstreamFailure
    );
  }
}

export class NotEnoughResourcesError extends XRPCError {
  constructor(
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(
      ResponseType.NotEnoughResources,
      errorMessage,
      customErrorName,
      options,
    );
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.NotEnoughResources
    );
  }
}

export class UpstreamTimeoutError extends XRPCError {
  constructor(
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(ResponseType.UpstreamTimeout, errorMessage, customErrorName, options);
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.UpstreamTimeout
    );
  }
}

export class MethodNotImplementedError extends XRPCError {
  constructor(
    message = "Method Not Implemented",
    error = "MethodNotImplemented",
  ) {
    super(ResponseType.MethodNotImplemented, message, error);
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.MethodNotImplemented
    );
  }
}
