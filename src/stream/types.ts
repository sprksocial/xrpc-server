import { z } from "zod";

export enum FrameType {
  Message = 1,
  Error = -1,
}

export interface WebSocketOptions {
  headers?: Record<string, string>;
  protocols?: string[];
}

export type MessageFrameHeader = {
  op: FrameType.Message;
  t?: string;
};

export const messageFrameHeader = z.object({
  op: z.literal(FrameType.Message), // Frame op
  t: z.string().optional(), // Message body type discriminator
}).strict() as z.ZodType<MessageFrameHeader>;

export type ErrorFrameHeader = {
  op: FrameType.Error;
};

export const errorFrameHeader = z.object({
  op: z.literal(FrameType.Error),
}).strict() as z.ZodType<ErrorFrameHeader>;

export type ErrorFrameBodyBase = {
  error: string;
  message?: string;
};

export type ErrorFrameBody<T extends string = string> = {
  error: T;
  message?: string;
};

export const errorFrameBody = z.object({
  error: z.string(), // Error code
  message: z.string().optional(), // Error message
}).strict() as z.ZodType<ErrorFrameBodyBase>;

export type FrameHeader = MessageFrameHeader | ErrorFrameHeader;

export const frameHeader = z.union([
  messageFrameHeader,
  errorFrameHeader,
]) as z.ZodType<FrameHeader>;

export class DisconnectError extends Error {
  constructor(
    public wsCode: CloseCode = CloseCode.Policy,
    public xrpcCode?: string,
  ) {
    super();
  }
}

// https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1
export enum CloseCode {
  Normal = 1000,
  Abnormal = 1006,
  Policy = 1008,
}
