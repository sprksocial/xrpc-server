import { ResponseType, XRPCError } from "@atproto/xrpc";
import { Frame } from "./frames.ts";
import type { MessageFrame } from "./frames.ts";

export async function* byFrame(
  ws: WebSocket,
): AsyncGenerator<Frame> {
  const messageQueue: Frame[] = [];
  let error: Error | null = null;
  let done = false;

  ws.onmessage = (ev) => {
    if (ev.data instanceof Uint8Array) {
      messageQueue.push(Frame.fromBytes(ev.data));
    }
  };
  ws.onerror = (ev) => {
    if (ev instanceof ErrorEvent) {
      error = ev.error;
    }
  };
  ws.onclose = () => {
    done = true;
  };

  while (!done && !error) {
    if (messageQueue.length > 0) {
      yield messageQueue.shift()!;
    } else {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (error) throw error;
}

export async function* byMessage(
  ws: WebSocket,
): AsyncGenerator<MessageFrame<unknown>> {
  for await (const frame of byFrame(ws)) {
    yield ensureChunkIsMessage(frame);
  }
}

export function ensureChunkIsMessage(frame: Frame): MessageFrame<unknown> {
  if (frame.isMessage()) {
    return frame;
  } else if (frame.isError()) {
    // @TODO work -1 error code into XRPCError
    throw new XRPCError(-1, frame.code, frame.message);
  } else {
    throw new XRPCError(ResponseType.Unknown, undefined, "Unknown frame type");
  }
}
