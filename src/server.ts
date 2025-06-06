import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib'
import { Hono } from 'hono'
import { check, schema } from '@atproto/common'
import {
  LexXrpcProcedure,
  LexXrpcQuery,
  LexXrpcSubscription,
  LexiconDoc,
  Lexicons,
  lexToJson,
} from '@atproto/lexicon'
import log, { LOGGER_NAME } from './logger.ts'
import { consumeMany, resetMany } from './rate-limiter.ts'
import { ErrorFrame, Frame, MessageFrame, XrpcStreamServer } from './stream/index.ts'
import {
  AuthVerifier,
  HandlerAuth,
  HandlerPipeThrough,
  HandlerSuccess,
  InternalServerError,
  InvalidRequestError,
  MethodNotImplementedError,
  Options,
  Params,
  PayloadTooLargeError,
  RateLimitExceededError,
  RateLimiterI,
  XRPCError,
  XRPCHandler,
  XRPCHandlerConfig,
  XRPCReqContext,
  XRPCStreamHandler,
  XRPCStreamHandlerConfig,
  isHandlerError,
  isHandlerPipeThroughBuffer,
  isHandlerPipeThroughStream,
  isShared,
} from './types.ts'
import {
  decodeQueryParams,
  getQueryParams,
  validateInput,
  validateOutput,
} from './util.ts'
import { WebSocket } from 'ws'
import { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Context, Next, MiddlewareHandler } from 'hono'
import { Buffer } from 'node:buffer'

const REQUEST_LOCALS_KEY = '_xrpcLocals'

export function createServer(lexicons?: LexiconDoc[], options?: Options) {
  return new Server(lexicons, options)
}

export class Server {
  app: Hono = new Hono()
  routes: Hono = new Hono()
  subscriptions = new Map<string, XrpcStreamServer>()
  lex = new Lexicons()
  options: Options
  middleware: Record<'json' | 'text', { limit?: number }>
  globalRateLimiters: RateLimiterI[]
  sharedRateLimiters: Record<string, RateLimiterI>
  routeRateLimiters: Record<string, RateLimiterI[]>
  abortController?: AbortController

  constructor(lexicons?: LexiconDoc[], opts: Options = {}) {
    if (lexicons) {
      this.addLexicons(lexicons)
    }
    this.app = new Hono()
    this.routes = new Hono()
    this.app.route('', this.routes)
    this.app.all('/xrpc/:methodId', this.catchall.bind(this))
    this.app.onError(createErrorMiddleware(opts))
    this.options = opts
    this.middleware = {
      json: { limit: opts?.payload?.jsonLimit },
      text: { limit: opts?.payload?.textLimit },
    }
    this.globalRateLimiters = []
    this.sharedRateLimiters = {}
    this.routeRateLimiters = {}
    if (opts?.rateLimits?.global) {
      for (const limit of opts.rateLimits.global) {
        const rateLimiter = opts.rateLimits.creator({
          ...limit,
          keyPrefix: `rl-${limit.name}`,
        })
        this.globalRateLimiters.push(rateLimiter)
      }
    }
    if (opts?.rateLimits?.shared) {
      for (const limit of opts.rateLimits.shared) {
        const rateLimiter = opts.rateLimits.creator({
          ...limit,
          keyPrefix: `rl-${limit.name}`,
        })
        this.sharedRateLimiters[limit.name] = rateLimiter
      }
    }
  }

  // handlers
  // =

  method(nsid: string, configOrFn: XRPCHandlerConfig | XRPCHandler) {
    this.addMethod(nsid, configOrFn)
  }

  addMethod(nsid: string, configOrFn: XRPCHandlerConfig | XRPCHandler) {
    const config =
      typeof configOrFn === 'function' ? { handler: configOrFn } : configOrFn
    const def = this.lex.getDef(nsid)
    if (def?.type === 'query' || def?.type === 'procedure') {
      this.addRoute(nsid, def, config)
    } else {
      throw new Error(`Lex def for ${nsid} is not a query or a procedure`)
    }
  }

  streamMethod(
    nsid: string,
    configOrFn: XRPCStreamHandlerConfig | XRPCStreamHandler,
  ) {
    this.addStreamMethod(nsid, configOrFn)
  }

  addStreamMethod(
    nsid: string,
    configOrFn: XRPCStreamHandlerConfig | XRPCStreamHandler,
  ) {
    const config =
      typeof configOrFn === 'function' ? { handler: configOrFn } : configOrFn
    const def = this.lex.getDef(nsid)
    if (def?.type === 'subscription') {
      this.addSubscription(nsid, def, config)
    } else {
      throw new Error(`Lex def for ${nsid} is not a subscription`)
    }
  }

  // schemas
  // =

  addLexicon(doc: LexiconDoc) {
    this.lex.add(doc)
  }

  addLexicons(docs: LexiconDoc[]) {
    for (const doc of docs) {
      this.addLexicon(doc)
    }
  }

  // http
  // =
  protected addRoute(
    nsid: string,
    def: LexXrpcQuery | LexXrpcProcedure,
    config: XRPCHandlerConfig,
  ) {
    const verb: 'post' | 'get' = def.type === 'procedure' ? 'post' : 'get'
    const middleware: MiddlewareHandler[] = []
    middleware.push(createLocalsMiddleware(nsid))
    if (config.auth) {
      middleware.push(createAuthMiddleware(config.auth))
    }
    this.setupRouteRateLimits(nsid, config)
    
    const routeOpts = {
      blobLimit: config.opts?.blobLimit ?? this.options.payload?.blobLimit,
    }
    
    // Add body parsing middleware for POST requests
    if (verb === 'post') {
      this.routes.post(
        `/xrpc/${nsid}`,
        ...middleware,
        async (c: Context, next: Next): Promise<Response | void> => {
          try {
            const contentType = c.req.header('content-type')
            const contentEncoding = c.req.header('content-encoding')
            const contentLength = c.req.header('content-length')

            // Check if we need a body
            const needsBody =
              def.type === 'procedure' && 'input' in def && def.input
            if (needsBody && !contentType) {
              throw new InvalidRequestError(
                'Request encoding (Content-Type) required but not provided',
              )
            }

            // Handle content encoding (compression)
            let encodings: string[] = []
            if (contentEncoding) {
              encodings = contentEncoding.split(',').map((s) => s.trim())
              // Filter out 'identity' since it means no transformation
              encodings = encodings.filter((e) => e !== 'identity')
              for (const encoding of encodings) {
                if (!['gzip', 'deflate', 'br'].includes(encoding)) {
                  throw new InvalidRequestError('unsupported content-encoding')
                }
              }
            }

            // Handle content length
            if (contentLength) {
              const length = parseInt(contentLength, 10)
              if (isNaN(length)) {
                throw new InvalidRequestError('invalid content-length')
              }
              if (routeOpts.blobLimit && length > routeOpts.blobLimit) {
                throw new PayloadTooLargeError('request entity too large')
              }
            }

            // Get the raw body
            let body: unknown
            if (contentType) {
              if (contentType.includes('application/json')) {
                body = await c.req.json()
              } else if (contentType.includes('text/')) {
                body = await c.req.text()
              } else {
                const buffer = Buffer.from(await c.req.arrayBuffer())
                if (
                  encodings.length === 0 &&
                  routeOpts.blobLimit &&
                  buffer.length > routeOpts.blobLimit
                ) {
                  throw new PayloadTooLargeError('request entity too large')
                }
                body = buffer
              }
            }

            // Handle decompression if needed
            if (encodings.length > 0 && body instanceof Buffer) {
              let currentBody = body
              let totalSize = 0
              for (const encoding of encodings.reverse()) {
                const source = Readable.from([currentBody])
                let transform
                switch (encoding) {
                  case 'gzip':
                    transform = createGunzip()
                    break
                  case 'deflate':
                    transform = createInflate()
                    break
                  case 'br':
                    transform = createBrotliDecompress()
                    break
                  default:
                    throw new InvalidRequestError('unsupported content-encoding')
                }

                const chunks: Buffer[] = []
                try {
                  await pipeline(source, transform, async function* (source) {
                    for await (const chunk of source) {
                      const buffer = Buffer.from(chunk)
                      totalSize += buffer.length
                      if (routeOpts.blobLimit && totalSize > routeOpts.blobLimit) {
                        throw new PayloadTooLargeError('request entity too large')
                      }
                      chunks.push(buffer)
                      yield buffer
                    }
                  })
                  currentBody = Buffer.concat(chunks)
                } catch (err) {
                  if (err instanceof PayloadTooLargeError) {
                    throw err
                  }
                  throw new InvalidRequestError('unable to read input')
                }
              }
              body = currentBody
            }

            // Validate the input against the lexicon schema
            const input = await validateInput(
              nsid,
              def,
              body,
              contentType,
              this.lex,
            )
            c.set('validatedInput', input)
            await next()
          } catch (err) {
            if (err instanceof XRPCError) {
              throw err
            }
            if (err instanceof Error) {
              throw new InvalidRequestError(err.message)
            }
            throw new InvalidRequestError('Invalid request body')
          }
        },
        this.createHandler(nsid, def, config),
      )
    } else {
      this.routes.get(
        `/xrpc/${nsid}`,
        ...middleware,
        this.createHandler(nsid, def, config),
      )
    }
  }

  async catchall(c: Context, next: Next): Promise<Response | void> {
    if (this.globalRateLimiters) {
      try {
        const rlRes = await consumeMany(
          {
            c,
            req: c.env.incoming as IncomingMessage,
            auth: undefined,
            params: {},
            input: undefined,
            resetRouteRateLimits: async () => {},
          },
          this.globalRateLimiters.map(
            (rl) => (ctx: XRPCReqContext) => rl.consume(ctx)
          )
        )
        if (rlRes instanceof RateLimitExceededError) {
          throw rlRes
        }
      } catch (err) {
        throw err
      }
    }

    if (this.options.catchall) {
      const result = await this.options.catchall(c, next)
      if (result instanceof Response) {
        return result
      }
      return
    }

    const methodId = c.req.param('methodId')
    const def = this.lex.getDef(methodId)
    if (!def) {
      throw new MethodNotImplementedError()
    }
    // validate method
    if (def.type === 'query' && c.req.method !== 'GET') {
      throw new InvalidRequestError(
        `Incorrect HTTP method (${c.req.method}) expected GET`,
      )
    } else if (def.type === 'procedure' && c.req.method !== 'POST') {
      throw new InvalidRequestError(
        `Incorrect HTTP method (${c.req.method}) expected POST`,
      )
    }
    await next()
  }

  createHandler(
    nsid: string,
    def: LexXrpcQuery | LexXrpcProcedure,
    routeCfg: XRPCHandlerConfig,
  ): MiddlewareHandler {
    const validateReqInput = async (c: Context) => {
      return (
        c.get('validatedInput') ||
        (await validateInput(
          nsid,
          def,
          undefined,
          c.req.header('content-type'),
          this.lex,
        ))
      )
    }
    const validateResOutput =
      this.options.validateResponse === false
        ? null
        : (output: undefined | HandlerSuccess) =>
            validateOutput(nsid, def, output, this.lex)
    const assertValidXrpcParams = (params: unknown) =>
      this.lex.assertValidXrpcParams(nsid, params)
    const rls = this.routeRateLimiters[nsid] ?? []
    const consumeRateLimit = (reqCtx: XRPCReqContext) =>
      consumeMany(
        reqCtx,
        rls.map((rl) => (ctx: XRPCReqContext) => rl.consume(ctx)),
      )

    const resetRateLimit = (reqCtx: XRPCReqContext) =>
      resetMany(
        reqCtx,
        rls.map((rl) => (ctx: XRPCReqContext) => rl.reset(ctx)),
      )

    return async (c: Context): Promise<Response> => {
      try {
        // validate request
        let params = decodeQueryParams(def, c.req.queries())
        try {
          params = assertValidXrpcParams(params) as Params
        } catch (e) {
          throw new InvalidRequestError(String(e))
        }
        const input = await validateReqInput(c)

        const locals: RequestLocals = c.get(REQUEST_LOCALS_KEY)

        const reqCtx: XRPCReqContext = {
          params,
          input,
          auth: locals.auth,
          c,
          req: c.env.incoming as IncomingMessage,
          resetRouteRateLimits: () => resetRateLimit(reqCtx),
        }

        // handle rate limits
        const result = await consumeRateLimit(reqCtx)
        if (result instanceof RateLimitExceededError) {
          throw result
        }

        // run the handler
        const output = await routeCfg.handler(reqCtx)

        if (!output) {
          validateResOutput?.(output)
          return new Response(null, { status: 200 })
        } else if (isHandlerPipeThroughStream(output)) {
          const headers = new Headers()
          setHeaders(headers, output)
          headers.set('Content-Type', output.encoding)
          return new Response(output.stream as unknown as ReadableStream<Uint8Array>, { 
            status: 200,
            headers 
          })
        } else if (isHandlerPipeThroughBuffer(output)) {
          const headers = new Headers()
          setHeaders(headers, output)
          headers.set('Content-Type', output.encoding as string)
          return new Response(output.buffer as Buffer, {
            status: 200,
            headers
          })
        } else if (isHandlerError(output)) {
          throw XRPCError.fromError(output)
        } else {
          validateResOutput?.(output)
          const headers = new Headers()
          setHeaders(headers, output)

          if (
            output.encoding === 'application/json' ||
            output.encoding === 'json'
          ) {
            headers.set('Content-Type', 'application/json; charset=utf-8')
            return new Response(JSON.stringify(lexToJson(output.body)), {
              status: 200,
              headers,
            })
          } else if (output.body instanceof Readable) {
            headers.set('Content-Type', output.encoding)
            return new Response(output.body as unknown as BodyInit, {
              status: 200,
              headers
            })
          } else {
            let contentType = output.encoding
            if (contentType.startsWith('text/')) {
              contentType = `${contentType}; charset=utf-8`
            }
            headers.set('Content-Type', contentType)
            return new Response(output.body as unknown as BodyInit, {
              status: 200,
              headers
            })
          }
        }
      } catch (err: unknown) {
        if (!err) {
          throw new InternalServerError()
        } else {
          throw err
        }
      }
    }
  }

  protected addSubscription(
    nsid: string,
    def: LexXrpcSubscription,
    config: XRPCStreamHandlerConfig,
  ) {
    const assertValidXrpcParams = (params: unknown) =>
      this.lex.assertValidXrpcParams(nsid, params)
    this.subscriptions.set(
      nsid,
      new XrpcStreamServer({
        noServer: true,
        handler: async function* (req: IncomingMessage, signal: AbortSignal) {
          try {
            // authenticate request
            const auth = await config.auth?.({ req })
            if (isHandlerError(auth)) {
              throw XRPCError.fromHandlerError(auth)
            }
            // validate request
            let params = decodeQueryParams(def, getQueryParams(req.url))
            try {
              params = assertValidXrpcParams(params) as Params
            } catch (e) {
              throw new InvalidRequestError(String(e))
            }
            // stream
            const items = config.handler({ req, params, auth, signal })
            for await (const item of items) {
              if (item instanceof Frame) {
                yield item
                continue
              }
              const itemObj = item as Record<string, unknown>
              const type = itemObj['$type']
              if (!check.is(item, schema.map) || typeof type !== 'string') {
                yield new MessageFrame(item)
                continue
              }
              const split = type.split('#')
              let t: string
              if (
                split.length === 2 &&
                (split[0] === '' || split[0] === nsid)
              ) {
                t = `#${split[1]}`
              } else {
                t = type
              }
              const clone = { ...itemObj }
              delete clone['$type']
              yield new MessageFrame(clone, { type: t })
            }
          } catch (err) {
            const xrpcErrPayload = XRPCError.fromError(err).payload
            yield new ErrorFrame({
              error: xrpcErrPayload.error ?? 'Unknown',
              message: xrpcErrPayload.message,
            })
          }
        },
      }),
    )
  }

  public enableStreamingOnListen(httpServer: HttpServer) {
    // For now, we'll keep the Node.js WebSocket server but add Deno WebSocket support later
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '', 'http://x')
      const sub = url.pathname.startsWith('/xrpc/')
        ? this.subscriptions.get(url.pathname.replace('/xrpc/', ''))
        : undefined
      if (!sub) return socket.destroy()
      sub.wss.handleUpgrade(req, socket, head, (client: WebSocket) =>
        sub.wss.emit('connection', client, req),
      )
    })
  }

  private setupRouteRateLimits(nsid: string, config: XRPCHandlerConfig) {
    this.routeRateLimiters[nsid] = []
    for (const limit of this.globalRateLimiters) {
      this.routeRateLimiters[nsid].push({
        consume: (ctx: XRPCReqContext) => limit.consume(ctx),
        reset: (ctx: XRPCReqContext) => limit.reset(ctx),
      })
    }

    if (config.rateLimit) {
      const limits = Array.isArray(config.rateLimit)
        ? config.rateLimit
        : [config.rateLimit]
      this.routeRateLimiters[nsid] = []
      for (let i = 0; i < limits.length; i++) {
        const limit = limits[i]
        const { calcKey, calcPoints } = limit
        if (isShared(limit)) {
          const rateLimiter = this.sharedRateLimiters[limit.name]
          if (rateLimiter) {
            this.routeRateLimiters[nsid].push({
              consume: (ctx: XRPCReqContext) =>
                rateLimiter.consume(ctx, {
                  calcKey,
                  calcPoints,
                }),
              reset: (ctx: XRPCReqContext) =>
                rateLimiter.reset(ctx, {
                  calcKey,
                }),
            })
          }
        } else {
          const { durationMs, points } = limit
          const rateLimiter = this.options.rateLimits?.creator({
            keyPrefix: `nsid-${i}`,
            durationMs,
            points,
            calcKey,
            calcPoints,
          })
          if (rateLimiter) {
            this.sharedRateLimiters[nsid] = rateLimiter
            this.routeRateLimiters[nsid].push({
              consume: (ctx: XRPCReqContext) =>
                rateLimiter.consume(ctx, {
                  calcKey,
                  calcPoints,
                }),
              reset: (ctx: XRPCReqContext) =>
                rateLimiter.reset(ctx, {
                  calcKey,
                }),
            })
          }
        }
      }
    }
  }
}

function setHeaders(
  headers: Headers,
  result: HandlerSuccess | HandlerPipeThrough,
) {
  const resultHeaders = result.headers
  if (resultHeaders) {
    for (const [name, val] of Object.entries(resultHeaders)) {
      if (val != null) headers.set(name, val)
    }
  }
}

function createLocalsMiddleware(nsid: string): MiddlewareHandler {
  return async function (c: Context, next: Next): Promise<Response | void> {
    const locals: RequestLocals = { auth: undefined, nsid }
    c.set(REQUEST_LOCALS_KEY, locals)
    await next()
  }
}

type RequestLocals = {
  auth: HandlerAuth | undefined
  nsid: string
}

function createAuthMiddleware(verifier: AuthVerifier): MiddlewareHandler {
  return async function (c: Context, next: Next): Promise<Response | void> {
    try {
      const result = await verifier({ c })
      if (isHandlerError(result)) {
        throw XRPCError.fromHandlerError(result)
      }
      const locals: RequestLocals = c.get(REQUEST_LOCALS_KEY)
      locals.auth = result
      await next()
    } catch (err: unknown) {
      throw err
    }
  }
}

function createErrorMiddleware({
  errorParser = (err) => XRPCError.fromError(err),
}: Options) {
  return (err: Error, c: Context) => {
    const locals: RequestLocals | undefined = c.get(REQUEST_LOCALS_KEY)
    const methodSuffix = locals ? ` method ${locals.nsid}` : ''

    const xrpcError = errorParser(err)

    const logger = isPinoHttpRequest(c.req.raw) ? c.req.raw.log : log

    const isInternalError = xrpcError instanceof InternalServerError

    logger.error(
      {
        err:
          isInternalError || Deno.env.get('NODE_ENV') === 'development'
            ? err
            : toSimplifiedErrorLike(err),
        nsid: locals?.nsid,
        type: xrpcError.type,
        status: xrpcError.statusCode,
        payload: xrpcError.payload,
        name: LOGGER_NAME,
      },
      isInternalError
        ? `unhandled exception in xrpc${methodSuffix}`
        : `error in xrpc${methodSuffix}`,
    )

    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
    })
    return new Response(JSON.stringify(xrpcError.payload), {
      status: xrpcError.statusCode,
      headers,
    })
  }
}

type PinoLike = { log: { error: (obj: unknown, msg: string) => void } };

function isPinoHttpRequest(req: unknown): req is PinoLike {
  if (!req || typeof req !== 'object') return false;
  const maybeLogger = req as Partial<PinoLike>;
  return !!(maybeLogger.log?.error && typeof maybeLogger.log.error === 'function');
}

function toSimplifiedErrorLike(err: unknown): unknown {
  if (err instanceof Error) {
    // Transform into an "ErrorLike" for pino's std "err" serializer
    return {
      ...err,
      // Carry over non-enumerable properties
      message: err.message,
      name:
        !Object.prototype.hasOwnProperty.call(err, 'name') &&
        Object.prototype.toString.call(err.constructor) === '[object Function]'
          ? err.constructor.name // extract the class name for sub-classes of Error
          : err.name,
      // @NOTE Error.stack, Error.cause and AggregateError.error are non
      // enumerable properties so they won't be spread to the ErrorLike
    }
  }

  return err
}
