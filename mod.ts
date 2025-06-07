/**
 * XRPC Server implementation for atproto services.
 *
 * This module provides a Hono-based server implementation for atproto's XRPC protocol,
 * with support for Lexicon schema validation, authentication, rate limiting, and streaming.
 *
 * ## Features
 * - Full Lexicon schema validation
 * - Built on Hono for high performance
 * - Authentication (Basic Auth, JWT)
 * - Rate limiting (global, shared, and per-route)
 * - Streaming support
 * - Server timing utilities
 *
 * @example Basic server setup with a simple endpoint
 * ```ts
 * import { createServer } from "jsr:@sprk/xrpc-server";
 * import type { LexiconDoc } from "@atproto/lexicon";
 *
 * const lexicons: LexiconDoc[] = [{
 *   lexicon: 1,
 *   id: "com.example.ping",
 *   defs: {
 *     main: {
 *       type: "query",
 *       parameters: {
 *         type: "params",
 *         properties: { message: { type: "string" } },
 *       },
 *       output: {
 *         encoding: "application/json",
 *       },
 *     },
 *   },
 * }];
 *
 * const server = createServer(lexicons);
 * server.method("com.example.ping", {
 *   handler: ({ params }) => ({
 *     encoding: "application/json",
 *     body: { message: params.message }
 *   })
 * });
 *
 * Deno.serve(server.app.fetch);
 * ```
 *
 * @example Authentication with Basic Auth and JWT
 * ```ts
 * import { createBasicAuth, createServer } from "jsr:@sprk/xrpc-server";
 *
 * const server = createServer(lexicons);
 *
 * // Basic Auth
 * server.method("com.example.protected", {
 *   auth: createBasicAuth({ username: "admin", password: "secret" }),
 *   handler: ({ auth }) => ({
 *     encoding: "application/json",
 *     body: { user: auth?.credentials?.username }
 *   })
 * });
 *
 * // JWT Auth
 * server.method("com.example.jwtProtected", {
 *   auth: async ({ req }) => {
 *     const token = req.header("Authorization")?.split(" ")[1];
 *     if (!token) return { error: "Missing token" };
 *     const validated = await verifyJwt(token, serviceDid);
 *     return { credentials: validated };
 *   },
 *   handler: ({ auth }) => ({
 *     encoding: "application/json",
 *     body: { user: auth?.credentials?.sub }
 *   })
 * });
 * ```
 *
 * @example Rate limiting configuration
 * ```ts
 * import { createServer } from "jsr:@sprk/xrpc-server";
 *
 * const server = createServer(lexicons, {
 *   rateLimits: {
 *     creator: createRateLimiter,
 *     global: [{
 *       name: "global",
 *       durationMs: 60000,  // 1 minute
 *       points: 100
 *     }],
 *     shared: [{
 *       name: "auth",
 *       durationMs: 300000,  // 5 minutes
 *       points: 20
 *     }]
 *   }
 * });
 *
 * // Per-route rate limiting
 * server.method("com.example.limited", {
 *   rateLimit: {
 *     durationMs: 60000,
 *     points: 10
 *   },
 *   handler: () => ({
 *     encoding: "application/json",
 *     body: { status: "ok" }
 *   })
 * });
 * ```
 *
 * @example Streaming endpoint
 * ```ts
 * import { createServer } from "jsr:@sprk/xrpc-server";
 *
 * const server = createServer(lexicons);
 *
 * server.streamMethod("com.example.stream", {
 *   handler: async function* ({ signal }) {
 *     while (!signal.aborted) {
 *       yield { time: new Date().toISOString() };
 *       await new Promise(r => setTimeout(r, 1000));
 *     }
 *   }
 * });
 * ```
 *
 * @module
 */

export * from "./src/types.ts";
export * from "./src/auth.ts";
export * from "./src/server.ts";
export * from "./src/stream/index.ts";
export * from "./src/rate-limiter.ts";

export type { ServerTiming } from "./src/util.ts";
export { parseReqNsid, ServerTimer, serverTimingHeader } from "./src/util.ts";
