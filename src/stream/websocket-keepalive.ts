import { SECOND, wait } from "@atproto/common";
import { CloseCode, DisconnectError, type WebSocketOptions } from "./types.ts";

export class WebSocketKeepAlive {
  public ws: WebSocket | null = null;
  public initialSetup = true;
  public reconnects: number | null = null;

  constructor(
    public opts: WebSocketOptions & {
      getUrl: () => Promise<string>;
      maxReconnectSeconds?: number;
      signal?: AbortSignal;
      heartbeatIntervalMs?: number;
      onReconnectError?: (
        error: unknown,
        n: number,
        initialSetup: boolean,
      ) => void;
    },
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    const maxReconnectMs = 1000 * (this.opts.maxReconnectSeconds ?? 64);
    while (true) {
      if (this.reconnects !== null) {
        const duration = this.initialSetup
          ? Math.min(1000, maxReconnectMs)
          : backoffMs(this.reconnects++, maxReconnectMs);
        await wait(duration);
      }
      const url = await this.opts.getUrl();
      this.ws = new WebSocket(url, this.opts.protocols);
      const ac = new AbortController();
      if (this.opts.signal) {
        forwardSignal(this.opts.signal, ac);
      }
      this.ws.onopen = () => {
        this.initialSetup = false;
        this.reconnects = 0;
        if (this.ws) {
          this.startHeartbeat(this.ws);
        }
      };
      this.ws.onclose = (ev: CloseEvent) => {
        if (ev.code === CloseCode.Abnormal) {
          // Forward into an error to distinguish from a clean close
          ac.abort(
            new AbnormalCloseError(`Abnormal ws close: ${ev.reason}`),
          );
        }
      };

      try {
        const messageQueue: Uint8Array[] = [];
        let error: Error | null = null;
        let done = false;

        this.ws.onmessage = (ev: MessageEvent) => {
          if (ev.data instanceof Uint8Array) {
            messageQueue.push(ev.data);
          }
        };
        this.ws.onerror = (ev: Event | ErrorEvent) => {
          if (ev instanceof ErrorEvent) {
            error = ev.error;
          }
        };
        this.ws.onclose = () => {
          done = true;
        };

        while (!done && !error && !ac.signal.aborted) {
          if (messageQueue.length > 0) {
            yield messageQueue.shift()!;
          } else {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }

        if (error) throw error;
        if (ac.signal.aborted) throw ac.signal.reason;
      } catch (_err) {
        const err = isErrorWithCode(_err) && _err.code === "ABORT_ERR"
          ? _err.cause
          : _err;
        if (err instanceof DisconnectError) {
          // We cleanly end the connection
          this.ws?.close(err.wsCode);
          break;
        }
        this.ws?.close(); // No-ops if already closed or closing
        if (isReconnectable(err)) {
          this.reconnects ??= 0; // Never reconnect with a null
          this.opts.onReconnectError?.(err, this.reconnects, this.initialSetup);
          continue;
        } else {
          throw err;
        }
      }
      break; // Other side cleanly ended stream and disconnected
    }
  }

  startHeartbeat(ws: WebSocket) {
    let isAlive = true;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    const checkAlive = () => {
      if (!isAlive) {
        return ws.close();
      }
      isAlive = false; // expect websocket to no longer be alive unless we receive a "pong" within the interval
      ws.send("ping");
    };

    checkAlive();
    heartbeatInterval = setInterval(
      checkAlive,
      this.opts.heartbeatIntervalMs ?? 10 * SECOND,
    );

    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data === "pong") {
        isAlive = true;
      }
    };
    ws.onclose = () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    };
  }
}

export default WebSocketKeepAlive;

class AbnormalCloseError extends Error {
  code = "EWSABNORMALCLOSE";
}

interface ErrorWithCode {
  code?: string;
  cause?: unknown;
}

function isErrorWithCode(err: unknown): err is ErrorWithCode {
  return err !== null && typeof err === "object" && "code" in err;
}

function isReconnectable(err: unknown): boolean {
  // Network errors are reconnectable.
  // AuthenticationRequired and InvalidRequest XRPCErrors are not reconnectable.
  // @TODO method-specific XRPCErrors may be reconnectable, need to consider. Receiving
  // an invalid message is not current reconnectable, but the user can decide to skip them.
  if (!isErrorWithCode(err)) return false;
  return typeof err.code === "string" && networkErrorCodes.includes(err.code);
}

const networkErrorCodes = [
  "EWSABNORMALCLOSE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ECANCELED",
];

function backoffMs(n: number, maxMs: number) {
  const baseSec = Math.pow(2, n); // 1, 2, 4, ...
  const randSec = Math.random() - 0.5; // Random jitter between -.5 and .5 seconds
  const ms = 1000 * (baseSec + randSec);
  return Math.min(ms, maxMs);
}

function forwardSignal(signal: AbortSignal, ac: AbortController) {
  if (signal.aborted) {
    return ac.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => ac.abort(signal.reason), {
      // @ts-ignore https://github.com/DefinitelyTyped/DefinitelyTyped/pull/68625
      signal: ac.signal,
    });
  }
}
