import { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { Context, Next } from 'hono'
import { isHttpError } from 'http-errors'
import { z } from 'zod'
import {
  ResponseType,
  ResponseTypeStrings,
  XRPCError as XRPCClientError,
  httpResponseCodeToName,
  httpResponseCodeToString,
} from '@atproto/xrpc'
import { LexiconDoc, Lexicons } from '@atproto/lexicon'
import { WebSocket } from 'ws'
import { Frame } from './stream'
import * as http from 'http'

type ErrorOptions = {
  cause?: unknown
}

export type CatchallHandler = (
  c: Context,
  next: () => Promise<void>,
) => unknown

export type Options = {
  validateResponse?: boolean
  catchall?: (c: Context, next: Next) => Promise<Response | void>
  payload?: {
    jsonLimit?: number
    blobLimit?: number
    textLimit?: number
  }
  rateLimits?: {
    creator: RateLimiterCreator
    global?: ServerRateLimitDescription[]
    shared?: ServerRateLimitDescription[]
  }
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
  errorParser?: (err: unknown) => XRPCError
}

export type UndecodedParams = Record<string, string | string[]>

export type Primitive = string | number | boolean
export type Params = Record<string, Primitive | Primitive[] | undefined>

export const handlerInput = z.object({
  encoding: z.string(),
  body: z.any(),
})
export type HandlerInput = z.infer<typeof handlerInput>

export const handlerAuth = z.object({
  credentials: z.any(),
  artifacts: z.any(),
})
export type HandlerAuth = z.infer<typeof handlerAuth>

export const headersSchema = z.record(z.string())

export const handlerSuccess = z.object({
  encoding: z.string(),
  body: z.any(),
  headers: headersSchema.optional(),
})
export type HandlerSuccess = z.infer<typeof handlerSuccess>

export const handlerPipeThroughBuffer = z.object({
  encoding: z.string(),
  buffer: z.instanceof(Buffer),
  headers: headersSchema.optional(),
})

export type HandlerPipeThroughBuffer = z.infer<typeof handlerPipeThroughBuffer>

export const handlerPipeThroughStream = z.object({
  encoding: z.string(),
  stream: z.instanceof(Readable),
  headers: headersSchema.optional(),
})

export type HandlerPipeThroughStream = z.infer<typeof handlerPipeThroughStream>

export const handlerPipeThrough = z.union([
  handlerPipeThroughBuffer,
  handlerPipeThroughStream,
])

export type HandlerPipeThrough = z.infer<typeof handlerPipeThrough>

export const handlerError = z.object({
  status: z.number(),
  error: z.string().optional(),
  message: z.string().optional(),
})
export type HandlerError = z.infer<typeof handlerError>

export type HandlerOutput = HandlerSuccess | HandlerPipeThrough | HandlerError

export type XRPCReqContext = {
  c: Context
  params: Params
  input: HandlerInput | undefined
  auth: HandlerAuth | undefined
  resetRouteRateLimits: () => Promise<void>
  req?: IncomingMessage
}

export type XRPCStreamReqContext = {
  req: http.IncomingMessage
  params: Params
  auth: HandlerAuth | undefined
  signal: AbortSignal
}

export type XRPCHandler = (
  ctx: XRPCReqContext,
) => Promise<HandlerOutput> | HandlerOutput | undefined

export type XRPCStreamHandler = (ctx: {
  auth: HandlerAuth | undefined
  params: Params
  req: IncomingMessage
  signal: AbortSignal
}) => AsyncIterable<unknown>

export type AuthOutput = HandlerAuth | HandlerError

export interface AuthVerifierContext {
  c: Context
}

export type AuthVerifier = (
  ctx: AuthVerifierContext,
) => Promise<AuthOutput> | AuthOutput

export interface StreamAuthVerifierContext {
  req: IncomingMessage
}

export type StreamAuthVerifier = (
  ctx: StreamAuthVerifierContext,
) => Promise<AuthOutput> | AuthOutput

export type CalcKeyFn = (ctx: XRPCReqContext) => string | null
export type CalcPointsFn = (ctx: XRPCReqContext) => number

export interface RateLimiterI {
  consume: RateLimiterConsume
  reset: RateLimiterReset
}

export type RateLimiterConsume = (
  ctx: XRPCReqContext,
  opts?: { calcKey?: CalcKeyFn; calcPoints?: CalcPointsFn },
) => Promise<RateLimiterStatus | RateLimitExceededError | null>

export type RateLimiterReset = (
  ctx: XRPCReqContext,
  opts?: { calcKey?: CalcKeyFn },
) => Promise<void>

export type RateLimiterCreator = (opts: {
  keyPrefix: string
  durationMs: number
  points: number
  calcKey?: CalcKeyFn
  calcPoints?: CalcPointsFn
}) => RateLimiterI

export type ServerRateLimitDescription = {
  name: string
  durationMs: number
  points: number
  calcKey?: CalcKeyFn
  calcPoints?: CalcPointsFn
}

export type SharedRateLimitOpts = {
  name: string
  calcKey?: CalcKeyFn
  calcPoints?: CalcPointsFn
}

export type RouteRateLimitOpts = {
  durationMs: number
  points: number
  calcKey?: CalcKeyFn
  calcPoints?: CalcPointsFn
}

export type HandlerRateLimitOpts = SharedRateLimitOpts | RouteRateLimitOpts

export const isShared = (
  opts: HandlerRateLimitOpts,
): opts is SharedRateLimitOpts => {
  return 'name' in opts && typeof (opts as SharedRateLimitOpts).name === 'string'
}

export type RateLimiterStatus = {
  limit: number
  duration: number
  remainingPoints: number
  msBeforeNext: number
  consumedPoints: number
  isFirstInDuration: boolean
}

export type RouteOpts = {
  blobLimit?: number
}

export type XRPCHandlerConfig = {
  opts?: RouteOpts
  rateLimit?: HandlerRateLimitOpts | HandlerRateLimitOpts[]
  auth?: AuthVerifier
  handler: XRPCHandler
}

export type XRPCStreamHandlerConfig = {
  auth?: StreamAuthVerifier
  handler: XRPCStreamHandler
}

export { ResponseType }

/**
 * Converts an upstream XRPC {@link ResponseType} into a downstream {@link ResponseType}.
 */
function mapFromClientError(error: XRPCClientError): {
  error: string
  message: string
  type: ResponseType
} {
  switch (error.status) {
    case ResponseType.InvalidResponse:
      // Upstream server returned an XRPC response that is not compatible with our internal lexicon definitions for that XRPC method.
      // @NOTE This could be reflected as both a 500 ("we" are at fault) and 502 ("they" are at fault). Let's be gents about it.
      return {
        error: httpResponseCodeToName(ResponseType.InternalServerError),
        message: httpResponseCodeToString(ResponseType.InternalServerError),
        type: ResponseType.InternalServerError,
      }
    case ResponseType.Unknown:
      // Typically a network error / unknown host
      return {
        error: httpResponseCodeToName(ResponseType.InternalServerError),
        message: httpResponseCodeToString(ResponseType.InternalServerError),
        type: ResponseType.InternalServerError,
      }
    default:
      return {
        error: error.error,
        message: error.message,
        type: error.status,
      }
  }
}

export class XRPCError extends Error {
  public cause?: unknown

  constructor(
    public type: ResponseType,
    public errorMessage?: string,
    public customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(errorMessage)
    if (options?.cause) {
      this.cause = options.cause
    }
  }

  get statusCode(): number {
    const { type } = this

    // Fool-proofing. `new XRPCError(123.5 as number, '')` does not generate a TypeScript error.
    // Because of this, we can end-up with any numeric value instead of an actual `ResponseType`.
    // For legacy reasons, the `type` argument is not checked in the constructor, so we check it here.
    if (type < 400 || type >= 600 || !Number.isFinite(type)) {
      return 500
    }

    return type
  }

  get payload() {
    return {
      error: this.customErrorName ?? this.typeName,
      message:
        this.type === ResponseType.InternalServerError
          ? this.typeStr // Do not respond with error details for 500s
          : this.errorMessage || this.typeStr,
    }
  }

  get typeName(): string | undefined {
    return ResponseType[this.type]
  }

  get typeStr(): string | undefined {
    return ResponseTypeStrings[this.type]
  }

  static fromError(cause: unknown): XRPCError {
    if (cause instanceof XRPCError) {
      return cause
    }

    if (cause instanceof XRPCClientError) {
      const { error, message, type } = mapFromClientError(cause)
      return new XRPCError(type, message, error, { cause })
    }

    if (isHttpError(cause)) {
      return new XRPCError(cause.status, cause.message, cause.name, { cause })
    }

    if (isHandlerError(cause)) {
      return this.fromHandlerError(cause)
    }

    if (cause instanceof Error) {
      return new InternalServerError(cause.message, undefined, { cause })
    }

    return new InternalServerError(
      'Unexpected internal server error',
      undefined,
      { cause },
    )
  }

  static fromHandlerError(err: HandlerError): XRPCError {
    return new XRPCError(err.status, err.message, err.error, { cause: err })
  }
}

export function isHandlerError(v: unknown): v is HandlerError {
  if (!v || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  return (
    typeof obj.status === 'number' &&
    (obj.error === undefined || typeof obj.error === 'string') &&
    (obj.message === undefined || typeof obj.message === 'string')
  )
}

export function isHandlerPipeThroughBuffer(
  v: HandlerOutput,
): v is HandlerPipeThroughBuffer {
  return 'buffer' in v && (v as HandlerPipeThroughBuffer).buffer !== undefined
}

export function isHandlerPipeThroughStream(
  v: HandlerOutput,
): v is HandlerPipeThroughStream {
  return 'stream' in v && (v as HandlerPipeThroughStream).stream !== undefined
}

export class InvalidRequestError extends XRPCError {
  constructor(message = 'Invalid Request', error = 'InvalidRequest') {
    super(ResponseType.InvalidRequest, message, error)
  }
}

export class PayloadTooLargeError extends XRPCError {
  constructor(message = 'Request entity too large', error = 'PayloadTooLarge') {
    super(ResponseType.PayloadTooLarge, message, error)
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
    )
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.AuthenticationRequired
    )
  }
}

export class ForbiddenError extends XRPCError {
  constructor(
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(ResponseType.Forbidden, errorMessage, customErrorName, options)
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError && instance.type === ResponseType.Forbidden
    )
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
    )
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.RateLimitExceeded
    )
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
    )
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.InternalServerError
    )
  }
}

export class UpstreamFailureError extends XRPCError {
  constructor(
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(ResponseType.UpstreamFailure, errorMessage, customErrorName, options)
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.UpstreamFailure
    )
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
    )
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.NotEnoughResources
    )
  }
}

export class UpstreamTimeoutError extends XRPCError {
  constructor(
    errorMessage?: string,
    customErrorName?: string,
    options?: ErrorOptions,
  ) {
    super(ResponseType.UpstreamTimeout, errorMessage, customErrorName, options)
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.UpstreamTimeout
    )
  }
}

export class MethodNotImplementedError extends XRPCError {
  constructor(message = 'Method Not Implemented', error = 'MethodNotImplemented') {
    super(ResponseType.MethodNotImplemented, message, error)
  }

  [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof XRPCError &&
      instance.type === ResponseType.MethodNotImplemented
    )
  }
}

export const nsid = (v: string) => {
  try {
    // ... existing code ...
  } catch (e) {
    // ... existing code ...
  }
}
