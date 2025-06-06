import * as uint8arrays from "uint8arrays";
import { cborDecodeMulti, cborEncode } from "@atproto/common";
import type {
  ErrorFrameBody,
  ErrorFrameHeader,
  FrameHeader,
  MessageFrameHeader,
} from "./types.ts";
import { frameHeader, errorFrameBody, FrameType } from "./types.ts";

export abstract class Frame {
  abstract header: FrameHeader;
  body: unknown;
  get op(): FrameType {
    return this.header.op;
  }
  toBytes(): Uint8Array {
    return uint8arrays.concat([cborEncode(this.header), cborEncode(this.body)]);
  }
  isMessage(): this is MessageFrame<unknown> {
    return this.op === FrameType.Message;
  }
  isError(): this is ErrorFrame {
    return this.op === FrameType.Error;
  }
  static fromBytes(bytes: Uint8Array): Frame {
    const decoded = cborDecodeMulti(bytes);
    if (decoded.length > 2) {
      throw new Error("Too many CBOR data items in frame");
    }
    const header = decoded[0];
    let body: unknown = kUnset;
    if (decoded.length > 1) {
      body = decoded[1];
    }
    const parsedHeader = frameHeader.safeParse(header);
    if (!parsedHeader.success) {
      throw new Error(`Invalid frame header: ${parsedHeader.error.message}`);
    }
    if (body === kUnset) {
      throw new Error("Missing frame body");
    }
    const frameOp = parsedHeader.data.op;
    if (frameOp === FrameType.Message) {
      return new MessageFrame(body, {
        type: parsedHeader.data.t,
      });
    } else if (frameOp === FrameType.Error) {
      const parsedBody = errorFrameBody.safeParse(body);
      if (!parsedBody.success) {
        throw new Error(
          `Invalid error frame body: ${parsedBody.error.message}`,
        );
      }
      return new ErrorFrame(parsedBody.data);
    } else {
      const exhaustiveCheck: never = frameOp;
      throw new Error(`Unknown frame op: ${exhaustiveCheck}`);
    }
  }
}

export class MessageFrame<T = Record<string, unknown>> extends Frame {
  header: MessageFrameHeader;
  override body: T;
  constructor(body: T, opts?: { type?: string }) {
    super();
    this.header = opts?.type !== undefined
      ? { op: FrameType.Message, t: opts?.type }
      : { op: FrameType.Message };
    this.body = body;
  }
  get type(): string | undefined {
    return this.header.t;
  }
}

export class ErrorFrame<T extends string = string> extends Frame {
  header: ErrorFrameHeader;
  override body: ErrorFrameBody<T>;
  constructor(body: ErrorFrameBody<T>) {
    super();
    this.header = { op: FrameType.Error };
    this.body = body;
  }
  get code(): string {
    return this.body.error;
  }
  get message(): string | undefined {
    return this.body.message;
  }
}

const kUnset = Symbol("unset");
