import { once } from 'node:events'
import * as http from 'node:http'
import * as xrpc from '../src/index.ts'
import { AuthRequiredError } from '../src/types.ts'
import { serve } from '@hono/node-server'
import { Buffer } from 'node:buffer'

export async function createServer(
  server: xrpc.Server 
): Promise<http.Server> {
  const httpServer = serve({
    fetch: server.app.fetch,
    port: 0,
  }) as http.Server

  server.enableStreamingOnListen(httpServer)

  // Add XRPC routes to the server
  server.app.route('', server.routes)
  server.app.all('/xrpc/:methodId', server.catchall.bind(server))

  await once(httpServer, 'listening')
  return httpServer
}

export async function closeServer(httpServer: http.Server) {
  await new Promise((r) => {
    httpServer.close(() => r(undefined))
  })
}

export function createBasicAuth(allowed: {
  username: string
  password: string
}) {
  const verifyAuth = (header?: string) => {
    if (!header || !header.startsWith('Basic ')) {
      throw new AuthRequiredError()
    }
    const original = header.replace('Basic ', '')
    const [username, password] = Buffer.from(original, 'base64')
      .toString()
      .split(':')
    if (username !== allowed.username || password !== allowed.password) {
      throw new AuthRequiredError()
    }
    return {
      credentials: { username },
      artifacts: { original },
    }
  }

  return function (ctx: { c: { req: { header: (name: string) => string | undefined } } }) {
    return verifyAuth(ctx.c.req.header('authorization'))
  }
}

export function createStreamBasicAuth(allowed: {
  username: string
  password: string
}) {
  const verifyAuth = (header?: string) => {
    if (!header || !header.startsWith('Basic ')) {
      throw new AuthRequiredError()
    }
    const original = header.replace('Basic ', '')
    const [username, password] = Buffer.from(original, 'base64')
      .toString()
      .split(':')
    if (username !== allowed.username || password !== allowed.password) {
      throw new AuthRequiredError()
    }
    return {
      credentials: { username },
      artifacts: { original },
    }
  }

  return function (ctx: { req: { headers: { authorization?: string } } }) {
    return verifyAuth(ctx.req.headers.authorization)
  }
}

export function basicAuthHeaders(creds: {
  username: string
  password: string
}) {
  return {
    authorization:
      'Basic ' +
      Buffer.from(`${creds.username}:${creds.password}`).toString('base64'),
  }
}
