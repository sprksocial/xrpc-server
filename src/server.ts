import { Hono } from "hono";
import { check, schema } from "@atproto/common";
import { Lexicons, lexToJson } from "@atproto/lexicon";
import type {
  LexiconDoc,
  LexXrpcProcedure,
  LexXrpcQuery,
  LexXrpcSubscription,
} from "@atproto/lexicon";
import log, { LOGGER_NAME } from "./logger.ts";
import { consumeMany, resetMany } from "./rate-limiter.ts";
import {
  ErrorFrame,
  Frame,
  MessageFrame,
  XrpcStreamServer,
} from "./stream/index.ts";
import {
  InternalServerError,
  InvalidRequestError,
  isHandlerError,
  isHandlerPipeThroughBuffer,
  isHandlerPipeThroughStream,
  isShared,
  MethodNotImplementedError,
  PayloadTooLargeError,
  RateLimitExceededError,
  XRPCError,
} from "./types.ts";
import type {
  AuthVerifier,
  HandlerAuth,
  HandlerPipeThrough,
  HandlerSuccess,
  Options,
  Params,
  RateLimiterI,
  XRPCHandler,
  XRPCHandlerConfig,
  XRPCReqContext,
  XRPCStreamHandler,
  XRPCStreamHandlerConfig,
} from "./types.ts";
import {
  decodeQueryParams,
  getQueryParams,
  validateInput,
  validateOutput,
} from "./util.ts";
import type { Context, Env, MiddlewareHandler, Next, Schema } from "hono";

const REQUEST_LOCALS_KEY = "_xrpcLocals";

/**
 * Create a new XRPC server for a given group of lexicons.
 * Should generally be used once per application.
 *
 * @template E - The environment type for Hono app, defaults to Env
 * @template P - The path parameter type for Hono app, defaults to string
 * @template S - The schema type for Hono app, defaults to Schema
 *
 * @param lexicons - The lexicons to use for the server. These define the API schema and methods.
 * @param options - Configuration options for the server including:
 *                 - payload limits
 *                 - rate limiting
 *                 - error handling
 *                 - response validation
 *                 - custom catchall handler
 *
 * @example
 * ```typescript
 * // Use as a standalone application
 * const server = createServer([myLexicon], {
 *   payload: { jsonLimit: 100_000 },
 *   rateLimits: { ... }
 * });
 * Deno.serve(server.app.fetch);
 * ```
 *
 * @example
 * ```typescript
 * // Use as part of a larger Hono application
 * const server = createServer();
 * const app = new Hono();
 * app.route("/", server.routes);
 * Deno.serve(app.fetch);
 * ```
 *
 * @returns A new XRPC server instance configured with the provided lexicons and options
 */
export function createServer<
  E extends Env = Env,
  P extends string = string,
  S extends Schema = Schema,
>(
  lexicons?: LexiconDoc[],
  options?: Options,
): Server<E, P, S> {
  return new Server<E, P, S>(lexicons, options);
}

/**
 * The XRPC server class that handles API routing, validation, and request processing.
 * Provides a complete server implementation with support for:
 * - HTTP and WebSocket endpoints
 * - Request/response validation against lexicon schemas
 * - Authentication and authorization
 * - Rate limiting
 * - Error handling
 * - Streaming responses
 *
 * @template E - The environment type for Hono app, defaults to Env
 * @template P - The path parameter type for Hono app, defaults to string
 * @template S - The schema type for Hono app, defaults to Schema
 *
 * @property {Hono<E, S, P>} app - The main Hono application instance
 * @property {Hono<E, S, P>} routes - The router handling XRPC-specific routes
 * @property {Map<string, XrpcStreamServer>} subscriptions - WebSocket subscription handlers by method ID
 * @property {Lexicons} lex - The lexicon schemas used for validation
 * @property {Options} options - Server configuration options
 * @property {Record<string, { limit?: number }>} middleware - Middleware configuration for different content types
 * @property {RateLimiterI[]} globalRateLimiters - Rate limiters applied to all routes
 * @property {Record<string, RateLimiterI>} sharedRateLimiters - Named rate limiters that can be shared across routes
 * @property {Record<string, RateLimiterI[]>} routeRateLimiters - Rate limiters specific to individual routes
 */
export class Server<
  E extends Env = Env,
  P extends string = string,
  S extends Schema = Schema,
> {
  public app: Hono<E, S, P> = new Hono<E, S, P>();
  public routes: Hono<E, S, P> = new Hono<E, S, P>();
  subscriptions: Map<string, XrpcStreamServer> = new Map<
    string,
    XrpcStreamServer
  >();
  lex: Lexicons = new Lexicons();
  options: Options;
  middleware: Record<"json" | "text", { limit?: number }>;
  globalRateLimiters: RateLimiterI[];
  sharedRateLimiters: Record<string, RateLimiterI>;
  routeRateLimiters: Record<string, RateLimiterI[]>;
  abortController?: AbortController;

  constructor(lexicons?: LexiconDoc[], opts: Options = {}) {
    if (lexicons) {
      this.addLexicons(lexicons);
    }
    this.app = new Hono<E, S, P>();
    this.routes = new Hono<E, S, P>();
    this.app.route("", this.routes);
    this.app.all("/xrpc/:methodId", this.catchall.bind(this));
    this.app.onError(createErrorMiddleware(opts));
    this.options = opts;
    this.middleware = {
      json: { limit: opts?.payload?.jsonLimit },
      text: { limit: opts?.payload?.textLimit },
    };
    this.globalRateLimiters = [];
    this.sharedRateLimiters = {};
    this.routeRateLimiters = {};
    if (opts?.rateLimits?.global) {
      for (const limit of opts.rateLimits.global) {
        const rateLimiter = opts.rateLimits.creator({
          ...limit,
          keyPrefix: `rl-${limit.name}`,
        });
        this.globalRateLimiters.push(rateLimiter);
      }
    }
    if (opts?.rateLimits?.shared) {
      for (const limit of opts.rateLimits.shared) {
        const rateLimiter = opts.rateLimits.creator({
          ...limit,
          keyPrefix: `rl-${limit.name}`,
        });
        this.sharedRateLimiters[limit.name] = rateLimiter;
      }
    }
  }

  // handlers
  // =

  method(nsid: string, configOrFn: XRPCHandlerConfig | XRPCHandler) {
    this.addMethod(nsid, configOrFn);
  }

  addMethod(nsid: string, configOrFn: XRPCHandlerConfig | XRPCHandler) {
    const config = typeof configOrFn === "function"
      ? { handler: configOrFn }
      : configOrFn;
    const def = this.lex.getDef(nsid);
    if (def?.type === "query" || def?.type === "procedure") {
      this.addRoute(nsid, def, config);
    } else {
      throw new Error(`Lex def for ${nsid} is not a query or a procedure`);
    }
  }

  streamMethod(
    nsid: string,
    configOrFn: XRPCStreamHandlerConfig | XRPCStreamHandler,
  ) {
    this.addStreamMethod(nsid, configOrFn);
  }

  addStreamMethod(
    nsid: string,
    configOrFn: XRPCStreamHandlerConfig | XRPCStreamHandler,
  ) {
    const config = typeof configOrFn === "function"
      ? { handler: configOrFn }
      : configOrFn;
    const def = this.lex.getDef(nsid);
    if (def?.type === "subscription") {
      this.addSubscription(nsid, def, config);
    } else {
      throw new Error(`Lex def for ${nsid} is not a subscription`);
    }
  }

  // schemas
  // =

  addLexicon(doc: LexiconDoc) {
    this.lex.add(doc);
  }

  addLexicons(docs: LexiconDoc[]) {
    for (const doc of docs) {
      this.addLexicon(doc);
    }
  }

  // http
  // =
  protected addRoute(
    nsid: string,
    def: LexXrpcQuery | LexXrpcProcedure,
    config: XRPCHandlerConfig,
  ) {
    const verb: "post" | "get" = def.type === "procedure" ? "post" : "get";
    const middleware: MiddlewareHandler[] = [];
    middleware.push(createLocalsMiddleware(nsid));
    if (config.auth) {
      middleware.push(createAuthMiddleware(config.auth));
    }
    this.setupRouteRateLimits(nsid, config);

    const routeOpts = {
      blobLimit: config.opts?.blobLimit ?? this.options.payload?.blobLimit,
    };

    // Add body parsing middleware for POST requests
    if (verb === "post") {
      this.routes.post(
        `/xrpc/${nsid}`,
        ...middleware,
        async (c: Context, next: Next): Promise<Response | void> => {
          try {
            const contentType = c.req.header("content-type");
            const contentEncoding = c.req.header("content-encoding");
            const contentLength = c.req.header("content-length");

            // Check if we need a body
            const needsBody = def.type === "procedure" && "input" in def &&
              def.input;
            if (needsBody && !contentType) {
              throw new InvalidRequestError(
                "Request encoding (Content-Type) required but not provided",
              );
            }

            // Handle content encoding (compression)
            let encodings: string[] = [];
            if (contentEncoding) {
              encodings = contentEncoding.split(",").map((s) => s.trim());
              // Filter out 'identity' since it means no transformation
              encodings = encodings.filter((e) => e !== "identity");
              for (const encoding of encodings) {
                if (!["gzip", "deflate", "br"].includes(encoding)) {
                  throw new InvalidRequestError("unsupported content-encoding");
                }
              }
            }

            // Handle content length
            if (contentLength) {
              const length = parseInt(contentLength, 10);
              if (isNaN(length)) {
                throw new InvalidRequestError("invalid content-length");
              }
              if (routeOpts.blobLimit && length > routeOpts.blobLimit) {
                throw new PayloadTooLargeError("request entity too large");
              }
            }

            // Get the raw body
            let body: unknown;
            if (contentType) {
              if (contentType.includes("application/json")) {
                body = await c.req.json();
              } else if (contentType.includes("text/")) {
                body = await c.req.text();
              } else {
                const data = new Uint8Array(await c.req.arrayBuffer());
                if (routeOpts.blobLimit && data.length > routeOpts.blobLimit) {
                  throw new PayloadTooLargeError("request entity too large");
                }
                body = data;
              }
            }

            // Handle decompression if needed
            if (encodings.length > 0 && body instanceof Uint8Array) {
              let currentBody = body;
              let totalSize = 0;
              for (const encoding of encodings.reverse()) {
                let transform;
                switch (encoding) {
                  case "gzip":
                  case "deflate":
                    transform = new DecompressionStream(encoding);
                    break;
                  case "br":
                    transform = new DecompressionStream("deflate"); // Fallback for browsers that don't support brotli
                    break;
                  default:
                    throw new InvalidRequestError(
                      "unsupported content-encoding",
                    );
                }

                const chunks: Uint8Array[] = [];
                try {
                  const stream = new ReadableStream({
                    start(controller) {
                      controller.enqueue(currentBody);
                      controller.close();
                    },
                  });

                  const transformedStream = stream.pipeThrough(transform);
                  const reader = transformedStream.getReader();

                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    totalSize += value.length;
                    if (
                      routeOpts.blobLimit && totalSize > routeOpts.blobLimit
                    ) {
                      throw new PayloadTooLargeError(
                        "request entity too large",
                      );
                    }
                    chunks.push(value);
                  }

                  currentBody = new Uint8Array(totalSize);
                  let offset = 0;
                  for (const chunk of chunks) {
                    currentBody.set(chunk, offset);
                    offset += chunk.length;
                  }
                } catch (err) {
                  if (err instanceof PayloadTooLargeError) {
                    throw err;
                  }
                  throw new InvalidRequestError("unable to read input");
                }
              }
              body = currentBody;
            }

            // Validate the input against the lexicon schema
            const input = await validateInput(
              nsid,
              def,
              body,
              contentType,
              this.lex,
            );
            c.set("validatedInput", input);
            await next();
          } catch (err) {
            if (err instanceof XRPCError) {
              throw err;
            }
            if (err instanceof Error) {
              throw new InvalidRequestError(err.message);
            }
            throw new InvalidRequestError("Invalid request body");
          }
        },
        this.createHandler(nsid, def, config),
      );
    } else {
      this.routes.get(
        `/xrpc/${nsid}`,
        ...middleware,
        this.createHandler(nsid, def, config),
      );
    }
  }

  async catchall(c: Context, next: Next): Promise<Response | void> {
    if (this.globalRateLimiters) {
      try {
        const rlRes = await consumeMany(
          {
            c,
            req: c.req,
            auth: undefined,
            params: {},
            input: undefined,
            resetRouteRateLimits: async () => {},
          },
          this.globalRateLimiters.map(
            (rl) => (ctx: XRPCReqContext) => rl.consume(ctx),
          ),
        );
        if (rlRes instanceof RateLimitExceededError) {
          throw rlRes;
        }
      } catch (err) {
        throw err;
      }
    }

    if (this.options.catchall) {
      const result = await this.options.catchall(c, next);
      if (result instanceof Response) {
        return result;
      }
      return;
    }

    const methodId = c.req.param("methodId");
    const def = this.lex.getDef(methodId);
    if (!def) {
      throw new MethodNotImplementedError();
    }
    // validate method
    if (def.type === "query" && c.req.method !== "GET") {
      throw new InvalidRequestError(
        `Incorrect HTTP method (${c.req.method}) expected GET`,
      );
    } else if (def.type === "procedure" && c.req.method !== "POST") {
      throw new InvalidRequestError(
        `Incorrect HTTP method (${c.req.method}) expected POST`,
      );
    }
    await next();
  }

  createHandler(
    nsid: string,
    def: LexXrpcQuery | LexXrpcProcedure,
    routeCfg: XRPCHandlerConfig,
  ): MiddlewareHandler {
    const validateReqInput = async (c: Context) => {
      return (
        c.get("validatedInput") ||
        (await validateInput(
          nsid,
          def,
          undefined,
          c.req.header("content-type"),
          this.lex,
        ))
      );
    };
    const validateResOutput = this.options.validateResponse === false
      ? null
      : (output: undefined | HandlerSuccess) =>
        validateOutput(nsid, def, output, this.lex);
    const assertValidXrpcParams = (params: unknown) =>
      this.lex.assertValidXrpcParams(nsid, params);
    const rls = this.routeRateLimiters[nsid] ?? [];
    const consumeRateLimit = (reqCtx: XRPCReqContext) =>
      consumeMany(
        reqCtx,
        rls.map((rl) => (ctx: XRPCReqContext) => rl.consume(ctx)),
      );

    const resetRateLimit = (reqCtx: XRPCReqContext) =>
      resetMany(
        reqCtx,
        rls.map((rl) => (ctx: XRPCReqContext) => rl.reset(ctx)),
      );

    return async (c: Context): Promise<Response> => {
      try {
        // validate request
        let params = decodeQueryParams(def, c.req.queries());
        try {
          params = assertValidXrpcParams(params) as Params;
        } catch (e) {
          throw new InvalidRequestError(String(e));
        }
        const input = await validateReqInput(c);

        const locals: RequestLocals = c.get(REQUEST_LOCALS_KEY);

        const reqCtx: XRPCReqContext = {
          params,
          input,
          auth: locals.auth,
          c,
          req: c.req,
          resetRouteRateLimits: () => resetRateLimit(reqCtx),
        };

        // handle rate limits
        const result = await consumeRateLimit(reqCtx);
        if (result instanceof RateLimitExceededError) {
          throw result;
        }

        // run the handler
        const output = await routeCfg.handler(reqCtx);

        if (!output) {
          validateResOutput?.(output);
          return new Response(null, { status: 200 });
        } else if (isHandlerPipeThroughStream(output)) {
          const headers = new Headers();
          setHeaders(headers, output);
          headers.set("Content-Type", output.encoding);
          return new Response(output.stream, {
            status: 200,
            headers,
          });
        } else if (isHandlerPipeThroughBuffer(output)) {
          const headers = new Headers();
          setHeaders(headers, output);
          headers.set("Content-Type", output.encoding);
          return new Response(output.buffer, {
            status: 200,
            headers,
          });
        } else if (isHandlerError(output)) {
          throw XRPCError.fromError(output);
        } else {
          validateResOutput?.(output);
          const headers = new Headers();
          setHeaders(headers, output);

          if (
            output.encoding === "application/json" || output.encoding === "json"
          ) {
            headers.set("Content-Type", "application/json; charset=utf-8");
            return new Response(JSON.stringify(lexToJson(output.body)), {
              status: 200,
              headers,
            });
          } else {
            let contentType = output.encoding;
            if (contentType.startsWith("text/")) {
              contentType = `${contentType}; charset=utf-8`;
            }
            headers.set("Content-Type", contentType);
            return new Response(
              output.body as string | Uint8Array | ReadableStream<Uint8Array>,
              {
                status: 200,
                headers,
              },
            );
          }
        }
      } catch (err: unknown) {
        if (!err) {
          throw new InternalServerError();
        } else {
          throw err;
        }
      }
    };
  }

  protected addSubscription(
    nsid: string,
    def: LexXrpcSubscription,
    config: XRPCStreamHandlerConfig,
  ) {
    const assertValidXrpcParams = (params: unknown) =>
      this.lex.assertValidXrpcParams(nsid, params);
    this.subscriptions.set(
      nsid,
      new XrpcStreamServer({
        noServer: true,
        handler: async function* (req: Request, signal: AbortSignal) {
          try {
            // authenticate request
            const auth = await config.auth?.({ req });
            if (isHandlerError(auth)) {
              throw XRPCError.fromHandlerError(auth);
            }
            // validate request
            let params = decodeQueryParams(def, getQueryParams(req.url));
            try {
              params = assertValidXrpcParams(params) as Params;
            } catch (e) {
              throw new InvalidRequestError(String(e));
            }
            // stream
            const items = config.handler({ req, params, auth, signal });
            for await (const item of items) {
              if (item instanceof Frame) {
                yield item;
                continue;
              }
              const itemObj = item as Record<string, unknown>;
              const type = itemObj["$type"];
              if (!check.is(item, schema.map) || typeof type !== "string") {
                yield new MessageFrame(item);
                continue;
              }
              const split = type.split("#");
              let t: string;
              if (
                split.length === 2 &&
                (split[0] === "" || split[0] === nsid)
              ) {
                t = `#${split[1]}`;
              } else {
                t = type;
              }
              const clone = { ...itemObj };
              delete clone["$type"];
              yield new MessageFrame(clone, { type: t });
            }
          } catch (err) {
            const xrpcErrPayload = XRPCError.fromError(err).payload;
            yield new ErrorFrame({
              error: xrpcErrPayload.error ?? "Unknown",
              message: xrpcErrPayload.message,
            });
          }
        },
      }),
    );
  }

  public enableStreamingOnListen(
    handler: (req: Request) => Promise<Response>,
  ): (req: Request) => Response | Promise<Response> {
    return (req: Request) => {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const url = new URL(req.url);
        const sub = url.pathname.startsWith("/xrpc/")
          ? this.subscriptions.get(url.pathname.replace("/xrpc/", ""))
          : undefined;

        if (!sub) return new Response("Not Found", { status: 404 });

        // Return a response that indicates WebSocket upgrade
        const headers = new Headers({
          "Upgrade": "websocket",
          "Connection": "Upgrade",
        });

        return new Response(null, {
          status: 101, // Switching Protocols
          headers,
        });
      }
      return handler(req);
    };
  }

  private setupRouteRateLimits(nsid: string, config: XRPCHandlerConfig) {
    this.routeRateLimiters[nsid] = [];
    for (const limit of this.globalRateLimiters) {
      this.routeRateLimiters[nsid].push({
        consume: (ctx: XRPCReqContext) => limit.consume(ctx),
        reset: (ctx: XRPCReqContext) => limit.reset(ctx),
      });
    }

    if (config.rateLimit) {
      const limits = Array.isArray(config.rateLimit)
        ? config.rateLimit
        : [config.rateLimit];
      this.routeRateLimiters[nsid] = [];
      for (let i = 0; i < limits.length; i++) {
        const limit = limits[i];
        const { calcKey, calcPoints } = limit;
        if (isShared(limit)) {
          const rateLimiter = this.sharedRateLimiters[limit.name];
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
            });
          }
        } else {
          const { durationMs, points } = limit;
          const rateLimiter = this.options.rateLimits?.creator({
            keyPrefix: `nsid-${i}`,
            durationMs,
            points,
            calcKey,
            calcPoints,
          });
          if (rateLimiter) {
            this.sharedRateLimiters[nsid] = rateLimiter;
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
            });
          }
        }
      }
    }
  }

  public router(): Hono {
    const router = new Hono();
    router.route("/", this.routes);
    return router;
  }
}

function setHeaders(
  headers: Headers,
  result: HandlerSuccess | HandlerPipeThrough,
) {
  const resultHeaders = result.headers;
  if (resultHeaders) {
    for (const [name, val] of Object.entries(resultHeaders)) {
      if (val != null) headers.set(name, val);
    }
  }
}

/**
 * Internal request context data shared between middleware and handlers.
 * Stores authentication results and method identification.
 * @internal
 * @property {HandlerAuth | undefined} auth - Authentication data if auth middleware was used
 * @property {string} nsid - The NSID (namespace identifier) of the XRPC method being called
 */
type RequestLocals = {
  auth: HandlerAuth | undefined;
  nsid: string;
};

/**
 * Creates middleware that initializes request-local storage.
 * Sets up a context for storing method-specific data that can be accessed by subsequent middleware and handlers.
 * @internal
 * @param nsid - The NSID of the XRPC method being handled
 * @returns Middleware function that initializes request locals
 */
function createLocalsMiddleware(nsid: string): MiddlewareHandler {
  return async function (c: Context, next: Next): Promise<Response | void> {
    const locals: RequestLocals = { auth: undefined, nsid };
    c.set(REQUEST_LOCALS_KEY, locals);
    await next();
  };
}

/**
 * Creates middleware that handles authentication for an XRPC method.
 * Executes the provided auth verifier and stores the result in request locals.
 * If authentication fails, throws an appropriate XRPCError.
 * @internal
 * @param verifier - The authentication verification function to use
 * @returns Middleware function that performs authentication
 */
function createAuthMiddleware(verifier: AuthVerifier): MiddlewareHandler {
  return async function (c: Context, next: Next): Promise<Response | void> {
    try {
      const result = await verifier({ c, req: c.req });
      if (isHandlerError(result)) {
        throw XRPCError.fromHandlerError(result);
      }
      const locals: RequestLocals = c.get(REQUEST_LOCALS_KEY);
      locals.auth = result;
      await next();
    } catch (err: unknown) {
      throw err;
    }
  };
}

/**
 * Creates middleware that handles error responses for the XRPC server.
 * Formats errors according to the XRPC specification and includes appropriate logging.
 * @internal
 * @param options - Server options containing error parsing configuration
 * @returns Middleware function that handles errors
 */
function createErrorMiddleware({
  errorParser = (err) => XRPCError.fromError(err),
}: Options) {
  return (err: Error, c: Context) => {
    const locals: RequestLocals | undefined = c.get(REQUEST_LOCALS_KEY);
    const methodSuffix = locals ? ` method ${locals.nsid}` : "";

    const xrpcError = errorParser(err);
    const logger = isPinoHttpRequest(c.req) ? c.req.log : log;
    const isInternalError = xrpcError instanceof InternalServerError;
    const isDevelopment = globalThis?.process?.env?.NODE_ENV === "development";

    logger.error(
      {
        err: isInternalError || isDevelopment
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
    );

    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
    });
    return new Response(JSON.stringify(xrpcError.payload), {
      status: xrpcError.statusCode,
      headers,
    });
  };
}

type PinoLike = { log: { error: (obj: unknown, msg: string) => void } };

function isPinoHttpRequest(req: unknown): req is PinoLike {
  if (!req || typeof req !== "object") return false;
  const maybeLogger = req as Partial<PinoLike>;
  return !!(maybeLogger.log?.error &&
    typeof maybeLogger.log.error === "function");
}

function toSimplifiedErrorLike(err: unknown): unknown {
  if (err instanceof Error) {
    // Transform into an "ErrorLike" for pino's std "err" serializer
    return {
      ...err,
      // Carry over non-enumerable properties
      message: err.message,
      name: !Object.prototype.hasOwnProperty.call(err, "name") &&
          Object.prototype.toString.call(err.constructor) ===
            "[object Function]"
        ? err.constructor.name // extract the class name for sub-classes of Error
        : err.name,
      // @NOTE Error.stack, Error.cause and AggregateError.error are non
      // enumerable properties so they won't be spread to the ErrorLike
    };
  }

  return err;
}
