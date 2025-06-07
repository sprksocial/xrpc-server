import type { Context, HonoRequest, Next } from "hono";
import { isHttpError } from "http-errors";
import { z } from "zod";
import {
  httpResponseCodeToName,
  httpResponseCodeToString,
  ResponseType,
  ResponseTypeStrings,
  XRPCError as XRPCClientError,
} from "@atproto/xrpc";

/**
 * Options for error handling.
 * @property {unknown} [cause] - The cause of the error
 */
type ErrorOptions = {
  cause?: unknown;
};

/**
 * Handler for unmatched XRPC method calls.
 * Used to provide custom handling for methods not explicitly defined.
 */
export type CatchallHandler = (
  c: Context,
  next: () => Promise<void>,
) => unknown;

/**
 * Configuration options for the XRPC server.
 * @property {boolean} [validateResponse] - Whether to validate responses against lexicon schemas
 * @property {Function} [catchall] - Handler for unmatched XRPC method calls
 * @property {Object} [payload] - Request payload size limits
 * @property {number} [payload.jsonLimit] - Maximum size in bytes for JSON payloads
 * @property {number} [payload.blobLimit] - Maximum size in bytes for binary payloads
 * @property {number} [payload.textLimit] - Maximum size in bytes for text payloads
 * @property {Object} [rateLimits] - Rate limiting configuration
 * @property {Function} rateLimits.creator - Factory function for creating rate limiters
 * @property {ServerRateLimitDescription[]} [rateLimits.global] - Rate limits applied to all routes
 * @property {ServerRateLimitDescription[]} [rateLimits.shared] - Named rate limits that can be shared across routes
 * @property {Function} [errorParser] - Custom error parser for converting errors to XRPCError format
 */
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

/**
 * Raw query parameters before type conversion.
 * Maps parameter names to their string values or arrays of string values.
 */
export type UndecodedParams = Record<string, string | string[]>;

/**
 * Basic primitive types supported in XRPC parameters.
 */
export type Primitive = string | number | boolean;

/**
 * Decoded and type-converted query parameters.
 * Maps parameter names to their typed values or arrays of typed values.
 */
export type Params = Record<string, Primitive | Primitive[] | undefined>;

/**
 * Validated request input data.
 * @property {string} encoding - Content type/encoding of the input (e.g., 'application/json')
 * @property {unknown} body - The parsed request body
 */
export type HandlerInput = {
  encoding: string;
  body: unknown;
};

export const handlerInput = z.object({
  encoding: z.string(),
  body: z.unknown(),
}).required().strict() as z.ZodType<HandlerInput>;

/**
 * Authentication result data.
 * Contains both the credentials presented and any artifacts produced during verification.
 * @property {unknown} credentials - Authentication credentials (e.g., JWT claims)
 * @property {unknown} artifacts - Additional data produced during auth verification
 */
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
  artifacts: true,
}).strict() as z.ZodType<HandlerAuth>;

export const headersSchema: z.ZodType<Record<string, string>> = z.record(
  z.string(),
);

/**
 * Successful response from an XRPC method handler.
 * @property {string} encoding - Content type/encoding of the response (e.g., 'application/json')
 * @property {unknown} body - The response payload
 * @property {Record<string, string>} [headers] - Additional HTTP headers to include in the response
 */
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

/**
 * Stream-based response from an XRPC method handler.
 * Used for large responses that should be streamed rather than buffered.
 * @property {string} encoding - Content type/encoding of the stream
 * @property {ReadableStream<Uint8Array>} stream - The response data stream
 * @property {Record<string, string>} [headers] - Additional HTTP headers to include in the response
 */
export type HandlerPipeThroughStream = {
  encoding: string;
  stream: ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
};

export const handlerPipeThroughStream: z.ZodType<HandlerPipeThroughStream> = z
  .object({
    encoding: z.string(),
    stream: z.custom<ReadableStream<Uint8Array>>((val) =>
      val instanceof ReadableStream
    ),
    headers: headersSchema.optional(),
  });

/**
 * Buffer-based response from an XRPC method handler.
 * Used for binary responses that are fully loaded in memory.
 * @property {string} encoding - Content type/encoding of the buffer
 * @property {Uint8Array} buffer - The response data buffer
 * @property {Record<string, string>} [headers] - Additional HTTP headers to include in the response
 */
export type HandlerPipeThroughBuffer = {
  encoding: string;
  buffer: Uint8Array;
  headers?: Record<string, string>;
};

export const handlerPipeThroughBuffer: z.ZodType<HandlerPipeThroughBuffer> = z
  .object({
    encoding: z.string(),
    buffer: z.custom<Uint8Array>((val) => val instanceof Uint8Array),
    headers: headersSchema.optional(),
  });

/**
 * Union type for all streaming/buffer response types.
 */
export type HandlerPipeThrough =
  | HandlerPipeThroughBuffer
  | HandlerPipeThroughStream;

export const handlerPipeThrough: z.ZodType<HandlerPipeThrough> = z.union([
  handlerPipeThroughBuffer,
  handlerPipeThroughStream,
]);

/**
 * Error response from an XRPC method handler.
 * @property {number} status - HTTP status code
 * @property {string} [error] - Error code/type
 * @property {string} [message] - Human-readable error message
 */
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

/**
 * Union type for all possible handler responses.
 */
export type HandlerOutput = HandlerSuccess | HandlerPipeThrough | HandlerError;

/**
 * Context object passed to XRPC method handlers.
 * Contains all request data and utilities needed to process the request.
 * @property {Context} c - Hono context object
 * @property {Params} params - Decoded query parameters
 * @property {HandlerInput | undefined} input - Validated request body, if any
 * @property {HandlerAuth | undefined} auth - Authentication data, if auth was performed
 * @property {Function} resetRouteRateLimits - Function to reset rate limits for this route
 * @property {HonoRequest} [req] - Raw Hono request object
 */
export type XRPCReqContext = {
  c: Context;
  params: Params;
  input: HandlerInput | undefined;
  auth: HandlerAuth | undefined;
  resetRouteRateLimits: () => Promise<void>;
  req?: HonoRequest;
};

/**
 * Context object passed to streaming XRPC method handlers.
 * Contains request data and control signals for streaming responses.
 * @property {Request} req - Raw request object
 * @property {Params} params - Decoded query parameters
 * @property {HandlerAuth | undefined} auth - Authentication data, if auth was performed
 * @property {AbortSignal} signal - Signal for detecting client disconnection
 */
export type XRPCStreamReqContext = {
  req: Request;
  params: Params;
  auth: HandlerAuth | undefined;
  signal: AbortSignal;
};

/**
 * Handler function type for XRPC methods.
 * Processes requests and returns responses synchronously or asynchronously.
 */
export type XRPCHandler = (
  ctx: XRPCReqContext,
) => Promise<HandlerOutput> | HandlerOutput | undefined;

/**
 * Handler function type for streaming XRPC methods.
 * Returns an async iterable that yields response chunks.
 */
export type XRPCStreamHandler = (ctx: {
  auth: HandlerAuth | undefined;
  params: Params;
  req: Request;
  signal: AbortSignal;
}) => AsyncIterable<unknown>;

/**
 * Union type for authentication results.
 * Can be either successful auth data or an error response.
 */
export type AuthOutput = HandlerAuth | HandlerError;

/**
 * Context object passed to authentication verifiers.
 * Contains the raw request data needed for auth verification.
 */
export interface AuthVerifierContext {
  c: Context;
  req: HonoRequest;
}

/**
 * Authentication verifier function type.
 * Validates request authentication and returns auth data or an error.
 */
export interface AuthVerifier {
  (ctx: AuthVerifierContext): Promise<AuthOutput> | AuthOutput;
}

/**
 * Context object passed to streaming authentication verifiers.
 * Contains the raw request data needed for WebSocket auth verification.
 */
export type StreamAuthVerifierContext = {
  req: Request;
};

/**
 * Authentication verifier function type for streaming endpoints.
 * Validates WebSocket connection authentication.
 */
export type StreamAuthVerifier = (
  ctx: StreamAuthVerifierContext,
) => Promise<AuthOutput> | AuthOutput;

/**
 * Function type for calculating rate limit keys.
 * Returns a string key to identify the rate limit bucket, or null to skip rate limiting.
 */
export type CalcKeyFn = (ctx: XRPCReqContext) => string | null;

/**
 * Function type for calculating rate limit points.
 * Returns the number of points to consume for a request.
 */
export type CalcPointsFn = (ctx: XRPCReqContext) => number;

/**
 * Interface for rate limiter implementations.
 * Provides methods for consuming and resetting rate limits.
 */
export interface RateLimiterI {
  consume: RateLimiterConsume;
  reset: RateLimiterReset;
}

/**
 * Function type for consuming rate limit points.
 * Returns the current rate limit status or an error if limit is exceeded.
 * @property {CalcKeyFn} [opts.calcKey] - Custom function to calculate the rate limit key
 * @property {CalcPointsFn} [opts.calcPoints] - Custom function to calculate points to consume
 */
export type RateLimiterConsume = (
  ctx: XRPCReqContext,
  opts?: { calcKey?: CalcKeyFn; calcPoints?: CalcPointsFn },
) => Promise<RateLimiterStatus | RateLimitExceededError | null>;

/**
 * Function type for resetting rate limits.
 * @property {CalcKeyFn} [opts.calcKey] - Custom function to calculate the rate limit key
 */
export type RateLimiterReset = (
  ctx: XRPCReqContext,
  opts?: { calcKey?: CalcKeyFn },
) => Promise<void>;

/**
 * Factory function type for creating rate limiters.
 * @property {string} opts.keyPrefix - Prefix for rate limit keys
 * @property {number} opts.durationMs - Duration of the rate limit window in milliseconds
 * @property {number} opts.points - Maximum points allowed in the window
 * @property {CalcKeyFn} [opts.calcKey] - Custom function to calculate rate limit keys
 * @property {CalcPointsFn} [opts.calcPoints] - Custom function to calculate points
 */
export type RateLimiterCreator = (opts: {
  keyPrefix: string;
  durationMs: number;
  points: number;
  calcKey?: CalcKeyFn;
  calcPoints?: CalcPointsFn;
}) => RateLimiterI;

/**
 * Configuration for a server-wide rate limit.
 * @property {string} name - Unique identifier for the rate limit
 * @property {number} durationMs - Duration of the rate limit window in milliseconds
 * @property {number} points - Maximum points allowed in the window
 * @property {CalcKeyFn} [calcKey] - Custom function to calculate rate limit keys
 * @property {CalcPointsFn} [calcPoints] - Custom function to calculate points
 */
export type ServerRateLimitDescription = {
  name: string;
  durationMs: number;
  points: number;
  calcKey?: CalcKeyFn;
  calcPoints?: CalcPointsFn;
};

/**
 * Configuration for a shared rate limit that can be referenced by name.
 * @property {string} name - Name of the shared rate limit to use
 * @property {CalcKeyFn} [calcKey] - Custom function to calculate rate limit keys
 * @property {CalcPointsFn} [calcPoints] - Custom function to calculate points
 */
export type SharedRateLimitOpts = {
  name: string;
  calcKey?: CalcKeyFn;
  calcPoints?: CalcPointsFn;
};

/**
 * Configuration for a route-specific rate limit.
 * @property {number} durationMs - Duration of the rate limit window in milliseconds
 * @property {number} points - Maximum points allowed in the window
 * @property {CalcKeyFn} [calcKey] - Custom function to calculate rate limit keys
 * @property {CalcPointsFn} [calcPoints] - Custom function to calculate points
 */
export type RouteRateLimitOpts = {
  durationMs: number;
  points: number;
  calcKey?: CalcKeyFn;
  calcPoints?: CalcPointsFn;
};

/**
 * Union type for rate limit options.
 * Can be either a shared rate limit reference or a route-specific configuration.
 */
export type HandlerRateLimitOpts = SharedRateLimitOpts | RouteRateLimitOpts;

/**
 * Type guard to check if rate limit options are for a shared rate limit.
 */
export const isShared = (
  opts: HandlerRateLimitOpts,
): opts is SharedRateLimitOpts => {
  return "name" in opts &&
    typeof (opts as SharedRateLimitOpts).name === "string";
};

/**
 * Current status of a rate limit.
 * @property {number} limit - Maximum points allowed in the window
 * @property {number} duration - Duration of the window in milliseconds
 * @property {number} remainingPoints - Points remaining in the current window
 * @property {number} msBeforeNext - Milliseconds until the next window starts
 * @property {number} consumedPoints - Points consumed in the current window
 * @property {boolean} isFirstInDuration - Whether this is the first request in a new window
 */
export type RateLimiterStatus = {
  limit: number;
  duration: number;
  remainingPoints: number;
  msBeforeNext: number;
  consumedPoints: number;
  isFirstInDuration: boolean;
};

/**
 * Configuration options for a route handler.
 * @property {number} [blobLimit] - Maximum size in bytes for binary payloads on this route
 */
export type RouteOpts = {
  blobLimit?: number;
};

/**
 * Configuration for an XRPC method handler.
 * @property {RouteOpts} [opts] - Route-specific options
 * @property {HandlerRateLimitOpts | HandlerRateLimitOpts[]} [rateLimit] - Rate limit configuration(s)
 * @property {AuthVerifier} [auth] - Authentication verifier function
 * @property {XRPCHandler} handler - The method implementation
 */
export type XRPCHandlerConfig = {
  opts?: RouteOpts;
  rateLimit?: HandlerRateLimitOpts | HandlerRateLimitOpts[];
  auth?: AuthVerifier;
  handler: XRPCHandler;
};

/**
 * Configuration for a streaming XRPC method handler.
 * @property {StreamAuthVerifier} [auth] - Authentication verifier for WebSocket connections
 * @property {XRPCStreamHandler} handler - The streaming method implementation
 */
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

/**
 * Base class for XRPC errors.
 * Provides standardized error handling and formatting for XRPC responses.
 */
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
      error: this.customErrorName ?? this.typeName ?? "Unknown",
      message: this.type === ResponseType.InternalServerError
        ? this.typeStr ?? "Internal Server Error"
        : this.errorMessage || this.typeStr || "Unknown Error",
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

/**
 * Error thrown when the request format or parameters are invalid.
 */
export class InvalidRequestError extends XRPCError {
  constructor(message = "Invalid Request", error = "InvalidRequest") {
    super(ResponseType.InvalidRequest, message, error);
  }
}

/**
 * Error thrown when the request payload exceeds size limits.
 */
export class PayloadTooLargeError extends XRPCError {
  constructor(message = "Request entity too large", error = "PayloadTooLarge") {
    super(ResponseType.PayloadTooLarge, message, error);
  }
}

/**
 * Error thrown when authentication is required but not provided.
 */
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

/**
 * Error thrown when the authenticated user lacks permission.
 */
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

/**
 * Error thrown when rate limits are exceeded.
 * Includes the current rate limit status.
 */
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

/**
 * Error thrown for unexpected server-side errors.
 */
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

/**
 * Error thrown when a dependent service fails.
 */
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

/**
 * Error thrown when server resources are exhausted.
 */
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

/**
 * Error thrown when a dependent service times out.
 */
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

/**
 * Error thrown when the requested XRPC method is not implemented.
 */
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
