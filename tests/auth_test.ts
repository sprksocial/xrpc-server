import * as jose from "jose";
import { MINUTE } from "@atproto/common";
import { Secp256k1Keypair } from "@atproto/crypto";
import type { LexiconDoc } from "@atproto/lexicon";
import { XrpcClient, XRPCError } from "@atproto/xrpc";
import * as xrpcServer from "../mod.ts";
import {
  basicAuthHeaders,
  closeServer,
  createBasicAuth,
  createServer,
} from "./_util.ts";
import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertRejects,
} from "jsr:@std/assert";
import { encodeBase64 } from "jsr:@std/encoding";

const LEXICONS: LexiconDoc[] = [
  {
    lexicon: 1,
    id: "io.example.authTest",
    defs: {
      main: {
        type: "procedure",
        input: {
          encoding: "application/json",
          schema: {
            type: "object",
            properties: {
              present: { type: "boolean", const: true },
            },
          },
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            properties: {
              username: { type: "string" },
              original: { type: "string" },
            },
          },
        },
      },
    },
  },
];

let s: Deno.HttpServer;
let client: XrpcClient;
const server = xrpcServer.createServer(LEXICONS);

type AuthTestResponse = {
  username: string | undefined;
  original: string | undefined;
};

type AuthTestAuth = {
  credentials: { username: string };
  artifacts: { original: string };
};

server.method("io.example.authTest", {
  auth: createBasicAuth({ username: "admin", password: "password" }),
  handler: ({ auth }: xrpcServer.XRPCReqContext) => {
    const credentials = auth?.credentials as { username: string } | undefined;
    const artifacts = auth?.artifacts as { original: string } | undefined;
    return {
      encoding: "application/json",
      body: {
        username: credentials?.username,
        original: artifacts?.original,
      } satisfies AuthTestResponse,
    };
  },
});

Deno.test({
  name: "Auth Tests",
  async fn() {
    // Setup
    s = await createServer(server);
    const port = (s as Deno.HttpServer & { port: number }).port;
    client = new XrpcClient(`http://localhost:${port}`, LEXICONS);

    // Tests
    await Deno.test("creates and validates service auth headers", async () => {
      const keypair = await Secp256k1Keypair.create();
      const iss = "did:example:alice";
      const aud = "did:example:bob";
      const token = await xrpcServer.createServiceJwt({
        iss,
        aud,
        keypair,
        lxm: null,
      });
      const validated = await xrpcServer.verifyJwt(
        token,
        null,
        null,
        async () => await keypair.did(),
      );
      assertEquals(validated.iss, iss);
      assertEquals(validated.aud, aud);
      // should expire within the minute when no exp is provided
      assert(validated.exp > Date.now() / 1000);
      assert(validated.exp < Date.now() / 1000 + 60);
      assert(typeof validated.jti === "string");
      assert(validated.lxm === undefined);
    });

    await Deno.test("creates and validates service auth headers bound to a particular method", async () => {
      const keypair = await Secp256k1Keypair.create();
      const iss = "did:example:alice";
      const aud = "did:example:bob";
      const lxm = "com.atproto.repo.createRecord";
      const token = await xrpcServer.createServiceJwt({
        iss,
        aud,
        keypair,
        lxm,
      });
      const validated = await xrpcServer.verifyJwt(
        token,
        null,
        lxm,
        async () => await keypair.did(),
      );
      assertEquals(validated.iss, iss);
      assertEquals(validated.aud, aud);
      assertEquals(validated.lxm, lxm);
    });

    await Deno.test("fails on bad auth before invalid request payload", async () => {
      try {
        await client.call(
          "io.example.authTest",
          {},
          { present: false },
          {
            headers: basicAuthHeaders({
              username: "admin",
              password: "wrong",
            }),
          },
        );
        throw new Error("Didnt throw");
      } catch (e) {
        assert(e instanceof XRPCError);
        assert(!e.success);
        assertEquals(e.error, "AuthenticationRequired");
        assertEquals(e.message, "Authentication Required");
        assertEquals(e.status, 401);
      }
    });

    await Deno.test("fails on invalid request payload after good auth", async () => {
      try {
        await client.call(
          "io.example.authTest",
          {},
          { present: false },
          {
            headers: basicAuthHeaders({
              username: "admin",
              password: "password",
            }),
          },
        );
        throw new Error("Didnt throw");
      } catch (e) {
        assert(e instanceof XRPCError);
        assert(!e.success);
        assertEquals(e.error, "InvalidRequest");
        assertEquals(e.message, "Input/present must be true");
        assertEquals(e.status, 400);
      }
    });

    await Deno.test("succeeds on good auth and payload", async () => {
      const res = await client.call(
        "io.example.authTest",
        {},
        { present: true },
        {
          headers: basicAuthHeaders({
            username: "admin",
            password: "password",
          }),
        },
      );
      assert(res.success);
      assertEquals(res.data, {
        username: "admin",
        original: "YWRtaW46cGFzc3dvcmQ=",
      });
    });

    await Deno.test("verifyJwt tests", async (t) => {
      await t.step("fails on expired jwt", async () => {
        const keypair = await Secp256k1Keypair.create();
        const jwt = await xrpcServer.createServiceJwt({
          aud: "did:example:aud",
          iss: "did:example:iss",
          keypair,
          exp: Math.floor((Date.now() - MINUTE) / 1000),
          lxm: null,
        });
        await assertRejects(
          () =>
            xrpcServer.verifyJwt(
              jwt,
              "did:example:aud",
              null,
              async () => await keypair.did(),
            ),
          Error,
          "jwt expired",
        );
      });

      await t.step("fails on bad audience", async () => {
        const keypair = await Secp256k1Keypair.create();
        const jwt = await xrpcServer.createServiceJwt({
          aud: "did:example:aud1",
          iss: "did:example:iss",
          keypair,
          lxm: null,
        });
        await assertRejects(
          () =>
            xrpcServer.verifyJwt(
              jwt,
              "did:example:aud2",
              null,
              async () => await keypair.did(),
            ),
          Error,
          "jwt audience does not match service did",
        );
      });

      await t.step("fails on bad lxm", async () => {
        const keypair = await Secp256k1Keypair.create();
        const jwt = await xrpcServer.createServiceJwt({
          aud: "did:example:aud1",
          iss: "did:example:iss",
          keypair,
          lxm: "com.atproto.repo.createRecord",
        });
        await assertRejects(
          () =>
            xrpcServer.verifyJwt(
              jwt,
              "did:example:aud1",
              "com.atproto.repo.putRecord",
              async () => await keypair.did(),
            ),
          Error,
          "bad jwt lexicon method",
        );
      });

      await t.step("fails on null lxm when lxm is required", async () => {
        const keypair = await Secp256k1Keypair.create();
        const jwt = await xrpcServer.createServiceJwt({
          aud: "did:example:aud1",
          iss: "did:example:iss",
          keypair,
          lxm: null,
        });
        await assertRejects(
          () =>
            xrpcServer.verifyJwt(
              jwt,
              "did:example:aud1",
              "com.atproto.repo.putRecord",
              async () => await keypair.did(),
            ),
          Error,
          "missing jwt lexicon method",
        );
      });

      await t.step("refreshes key on verification failure", async () => {
        const keypair1 = await Secp256k1Keypair.create();
        const keypair2 = await Secp256k1Keypair.create();
        const jwt = await xrpcServer.createServiceJwt({
          aud: "did:example:aud",
          iss: "did:example:iss",
          keypair: keypair2,
          lxm: null,
        });
        let usedKeypair1 = false;
        let usedKeypair2 = false;
        const tryVerify = await xrpcServer.verifyJwt(
          jwt,
          "did:example:aud",
          null,
          async (_did, forceRefresh) => {
            if (forceRefresh) {
              usedKeypair2 = true;
              return await keypair2.did();
            } else {
              usedKeypair1 = true;
              return await keypair1.did();
            }
          },
        );
        assertObjectMatch(tryVerify, {
          aud: "did:example:aud",
          iss: "did:example:iss",
        });
        assert(usedKeypair1);
        assert(usedKeypair2);
      });

      await t.step(
        "interoperates with jwts signed by other libraries",
        async () => {
          const keypair = await Secp256k1Keypair.create({ exportable: true });
          const signingKey = await createPrivateKeyObject(keypair);
          const payload = {
            aud: "did:example:aud",
            iss: "did:example:iss",
            exp: Math.floor((Date.now() + MINUTE) / 1000),
          };
          const jwt = await new jose.SignJWT(payload)
            .setProtectedHeader({ typ: "JWT", alg: keypair.jwtAlg })
            .sign(signingKey);
          const tryVerify = await xrpcServer.verifyJwt(
            jwt,
            "did:example:aud",
            null,
            async () => {
              return await keypair.did();
            },
          );
          assertEquals(tryVerify, payload);
        },
      );
    });

    // Cleanup
    await closeServer(s);
  },
});

async function createPrivateKeyObject(
  privateKey: Secp256k1Keypair,
): Promise<CryptoKey> {
  const raw = await privateKey.export();
  const pemKey = `-----BEGIN EC PRIVATE KEY-----\n${
    encodeBase64(raw)
  }\n-----END EC PRIVATE KEY-----`;
  
  // Convert PEM to CryptoKey
  const binaryDer = new TextEncoder().encode(pemKey);
  return await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign"]
  );
}
