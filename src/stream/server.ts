import { type ServerOptions, WebSocketServer } from "ws";
import { ErrorFrame, type Frame } from "./frames.ts";
import { logger } from "../logger.ts";
import { CloseCode, DisconnectError } from "./types.ts";

export class XrpcStreamServer {
  wss: WebSocketServer;
  constructor(opts: ServerOptions & { handler: Handler }) {
    const { handler, ...serverOpts } = opts;
    this.wss = new WebSocketServer(serverOpts);
    this.wss.on(
      "connection",
      async (socket: WebSocket, req: Request) => {
        socket.onerror = (ev: Event | ErrorEvent) => {
          if (ev instanceof ErrorEvent) {
            logger.error(ev.error, "websocket error");
          } else {
            logger.error(ev, "websocket error");
          }
        };
        try {
          const ac = new AbortController();
          const iterator = unwrapIterator(
            handler(req, ac.signal, socket, this),
          );
          socket.onclose = () => {
            iterator.return?.();
            ac.abort();
          };
          const safeFrames = wrapIterator(iterator);
          for await (const frame of safeFrames) {
            await new Promise<void>((res, rej) => {
              try {
                socket.send((frame as Frame).toBytes());
                res();
              } catch (err) {
                rej(err);
              }
            });
            if (frame instanceof ErrorFrame) {
              throw new DisconnectError(CloseCode.Policy, frame.body.error);
            }
          }
        } catch (err) {
          if (err instanceof DisconnectError) {
            return socket.close(err.wsCode, err.xrpcCode);
          } else {
            logger.error({ err }, "websocket server error");
            return socket.close(CloseCode.Abnormal);
          }
        }
        socket.close(CloseCode.Normal);
      },
    );
  }
}

export type Handler = (
  req: Request,
  signal: AbortSignal,
  socket: WebSocket,
  server: XrpcStreamServer,
) => AsyncIterable<Frame>;

function unwrapIterator<T>(iterable: AsyncIterable<T>): AsyncIterator<T> {
  return iterable[Symbol.asyncIterator]();
}

function wrapIterator<T>(iterator: AsyncIterator<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}
