import type * as xrpc from "../mod.ts";
import { AuthRequiredError } from "../src/types.ts";

export async function createServer(
  server: xrpc.Server,
): Promise<Deno.HttpServer> {
  const abortController = new AbortController();
  let resolveServer: (value: number) => void;
  const portPromise = new Promise<number>((resolve) => {
    resolveServer = resolve;
  });
  
  const httpServer = Deno.serve({
    signal: abortController.signal,
    port: 0,
    onListen({ port }) {
      resolveServer(port);
    },
    handler: async (req) => {
      const response = await server.app.fetch(req);
      return response;
    },
  });

  // Add XRPC routes to the server
  server.app.route("", server.routes);
  server.app.all("/xrpc/:methodId", server.catchall.bind(server));

  // Attach the abort controller for cleanup
  (httpServer as any).abortController = abortController;
  
  // Wait for the port and attach it
  const port = await portPromise;
  (httpServer as any).port = port;

  return httpServer;
}

export async function closeServer(httpServer: Deno.HttpServer) {
  const abortController = (httpServer as any).abortController;
  if (abortController) {
    abortController.abort();
    await httpServer.finished;
  }
}

export function createBasicAuth(allowed: {
  username: string;
  password: string;
}) {
  const verifyAuth = (header?: string) => {
    if (!header || !header.startsWith("Basic ")) {
      throw new AuthRequiredError();
    }
    const original = header.replace("Basic ", "");
    const decoded = atob(original);
    const [username, password] = decoded.split(":");
    if (username !== allowed.username || password !== allowed.password) {
      throw new AuthRequiredError();
    }
    return {
      credentials: { username },
      artifacts: { original },
    };
  };

  return function (
    ctx: { c: { req: { header: (name: string) => string | undefined } } },
  ) {
    return verifyAuth(ctx.c.req.header("authorization"));
  };
}

export function createStreamBasicAuth(allowed: {
  username: string;
  password: string;
}) {
  const verifyAuth = (header?: string) => {
    if (!header || !header.startsWith("Basic ")) {
      throw new AuthRequiredError();
    }
    const original = header.replace("Basic ", "");
    const decoded = atob(original);
    const [username, password] = decoded.split(":");
    if (username !== allowed.username || password !== allowed.password) {
      throw new AuthRequiredError();
    }
    return {
      credentials: { username },
      artifacts: { original },
    };
  };

  return function (ctx: { req: { headers: { authorization?: string } } }) {
    return verifyAuth(ctx.req.headers.authorization);
  };
}

export function basicAuthHeaders(creds: {
  username: string;
  password: string;
}) {
  return {
    authorization: "Basic " +
      btoa(`${creds.username}:${creds.password}`),
  };
}
