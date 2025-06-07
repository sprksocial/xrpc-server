import { XRPCError } from "@atproto/xrpc";
import {
  byFrame,
  byMessage,
  ErrorFrame,
  type Frame,
  MessageFrame,
  XrpcStreamServer,
} from "../mod.ts";
import { assertEquals, assertInstanceOf } from "jsr:@std/assert";

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Helper to create a test server
function createTestServer(
  handlerFn: () => AsyncGenerator<Frame, void, unknown>,
) {
  const server = new XrpcStreamServer({
    noServer: true,
    handler: handlerFn,
  });

  const httpServer = Deno.serve({ port: 0 }, (req) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      server.wss.emit("connection", socket, req);
      return response;
    }
    return new Response("Not Found", { status: 404 });
  });

  const addr = httpServer.addr as Deno.NetAddr;
  return {
    server,
    url: `ws://localhost:${addr.port}`,
    close: () => {
      server.wss.close();
      httpServer.unref();
    },
  };
}

Deno.test({
  name: "Stream Tests",
  async fn() {
    await Deno.test("streams message and info frames", async () => {
      const { url, close } = createTestServer(async function* () {
        await wait(1);
        yield new MessageFrame(1);
        await wait(1);
        yield new MessageFrame(2);
        await wait(1);
        yield new MessageFrame(3);
        return;
      });

      const ws = new WebSocket(url);
      const frames: Frame[] = [];
      for await (const frame of byFrame(ws)) {
        frames.push(frame);
      }

      assertEquals(frames, [
        new MessageFrame(1),
        new MessageFrame(2),
        new MessageFrame(3),
      ]);

      close();
    });

    await Deno.test("kills handler and closes on error frame", async () => {
      let proceededAfterError = false;
      const { url, close } = createTestServer(async function* () {
        await wait(1);
        yield new MessageFrame(1);
        await wait(1);
        yield new MessageFrame(2);
        await wait(1);
        yield new ErrorFrame({ error: "BadOops" });
        proceededAfterError = true;
        await wait(1);
        yield new MessageFrame(3);
        return;
      });

      const ws = new WebSocket(url);
      const frames: Frame[] = [];
      for await (const frame of byFrame(ws)) {
        frames.push(frame);
      }

      await wait(5); // Ensure handler hasn't kept running
      assertEquals(proceededAfterError, false);

      assertEquals(frames, [
        new MessageFrame(1),
        new MessageFrame(2),
        new ErrorFrame({ error: "BadOops" }),
      ]);

      close();
    });

    await Deno.test("kills handler and closes client disconnect", async () => {
      let i = 1;
      const { url, close } = createTestServer(async function* () {
        while (true) {
          await wait(0);
          yield new MessageFrame(i++);
        }
      });

      const ws = new WebSocket(url);
      const frames: Frame[] = [];
      for await (const frame of byFrame(ws)) {
        frames.push(frame);
        if (frame.body === 3) ws.close();
      }

      // Grace period to let close take place on the server
      await wait(5);
      // Ensure handler hasn't kept running
      const currentCount = i;
      await wait(5);
      assertEquals(i, currentCount);

      close();
    });

    await Deno.test("byMessage() tests", async (t) => {
      await t.step(
        "kills handler and closes client disconnect on error frame",
        async () => {
          const { url, close } = createTestServer(async function* () {
            await wait(1);
            yield new MessageFrame(1);
            await wait(1);
            yield new MessageFrame(2);
            await wait(1);
            yield new ErrorFrame({
              error: "BadOops",
              message: "That was a bad one",
            });
            await wait(1);
            yield new MessageFrame(3);
            return;
          });

          const ws = new WebSocket(url);
          const frames: Frame[] = [];

          let error: unknown;
          try {
            for await (const frame of byMessage(ws)) {
              frames.push(frame);
            }
          } catch (err) {
            error = err;
          }

          assertEquals(ws.readyState, WebSocket.CLOSING);
          assertEquals(frames, [new MessageFrame(1), new MessageFrame(2)]);
          assertInstanceOf(error, XRPCError);
          if (error instanceof XRPCError) {
            assertEquals(error.error, "BadOops");
            assertEquals(error.message, "That was a bad one");
          }

          close();
        },
      );
    });
  },
});
