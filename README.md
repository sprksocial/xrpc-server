[![JSR](https://jsr.io/badges/@sprk/xrpc-server)](https://jsr.io/@sprk/xrpc-server)
# xrpc-server: atproto HTTP API server library

A TypeScript library for implementing [atproto](https://atproto.com) HTTP API services, with Lexicon schema validation. This is a port of the original [@atproto/xrpc-server](https://www.npmjs.com/package/@atproto/xrpc-server) package to use Hono and Deno.

## Features

- Full Lexicon schema validation
- Built on [Hono](https://hono.dev/) for high performance
- TypeScript support
- Rate limiting capabilities
- Authentication support
- Streaming support

## Usage

```typescript
import { LexiconDoc } from "@atproto/lexicon";
import * as xrpcServer from "jsr:@sprk/xrpc-server";

const lexicons: LexiconDoc[] = [
  {
    lexicon: 1,
    id: "io.example.ping",
    defs: {
      main: {
        type: "query",
        parameters: {
          type: "params",
          properties: { message: { type: "string" } },
        },
        output: {
          encoding: "application/json",
        },
      },
    },
  },
];

// Create xrpc server
const server = xrpcServer.createServer(lexicons);

// Add a method handler
server.method("io.example.ping", {
  handler: ({ params }: xrpcServer.XRPCReqContext) => {
    return {
      encoding: "application/json",
      body: { message: params.message },
    };
  },
});

// Start the server
const port = 8080;
Deno.serve({ port }, server.app.fetch);
```

## Authentication

The library supports various authentication methods including Basic Auth and JWT:

```typescript
server.method("io.example.authTest", {
  auth: createBasicAuth({ username: "admin", password: "password" }),
  handler: ({ auth }) => {
    return {
      encoding: "application/json",
      body: {
        username: auth?.credentials?.username,
      },
    };
  },
});
```

## Rate Limiting

Rate limiting can be configured globally or per-route:

```typescript
const options = {
  rateLimits: {
    creator: createRateLimiter,
    global: [{
      name: "global",
      durationMs: 60000,
      points: 100,
    }],
  },
};

const server = xrpcServer.createServer(lexicons, options);
```

## License

MIT License
