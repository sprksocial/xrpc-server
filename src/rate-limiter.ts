import {
  type RateLimiterAbstract,
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from "rate-limiter-flexible";
import { logger } from "./logger.ts";
import type {
  CalcKeyFn,
  CalcPointsFn,
  RateLimiterConsume,
  RateLimiterI,
  RateLimiterReset,
  RateLimiterStatus,
  XRPCReqContext,
} from "./types.ts";
import { RateLimitExceededError } from "./types.ts";

/**
 * Options for the rate limiter to customize its behavior.
 * 
 * @prop keyPrefix - The prefix for the rate limiter key.
 * @prop durationMs - The duration of the rate limiter in milliseconds.
 * @prop points - The number of points to consume.
 * @prop bypassSecret - A secret to bypass the rate limiter.
 * @prop bypassIps - IPs that should bypass the rate limiter.
 * @prop calcKey - The function to calculate the key.
 * @prop calcPoints - The function to calculate the points.
 * @prop failClosed - Whether to fail closed.
 */
export type RateLimiterOpts = {
  keyPrefix: string;
  durationMs: number;
  points: number;
  bypassSecret?: string;
  bypassIps?: string[];
  calcKey?: CalcKeyFn;
  calcPoints?: CalcPointsFn;
  failClosed?: boolean;
};

/**
 * The rate limiter uses the rate-limiter-flexible library
 * to limit the number of requests to the server based on the
 * options provided.
 * 
 * Uses a redis store by default.
 * 
 * Used in the server class.
 * 
 * @param limiter - The rate limiter instance.
 * @param opts - The options for the rate limiter.
 * @class
 */
export class RateLimiter implements RateLimiterI {
  public limiter: RateLimiterAbstract;
  private bypassSecret?: string;
  private bypassIps?: string[];
  private failClosed?: boolean;
  public calcKey: CalcKeyFn;
  public calcPoints: CalcPointsFn;

  constructor(limiter: RateLimiterAbstract, opts: RateLimiterOpts) {
    this.limiter = limiter;
    this.bypassSecret = opts.bypassSecret;
    this.bypassIps = opts.bypassIps;
    this.calcKey = opts.calcKey ?? defaultKey;
    this.calcPoints = opts.calcPoints ?? defaultPoints;
  }

  static memory(opts: RateLimiterOpts): RateLimiter {
    const limiter = new RateLimiterMemory({
      keyPrefix: opts.keyPrefix,
      duration: Math.floor(opts.durationMs / 1000),
      points: opts.points,
    });
    return new RateLimiter(limiter, opts);
  }

  static redis(storeClient: unknown, opts: RateLimiterOpts): RateLimiter {
    const limiter = new RateLimiterRedis({
      storeClient,
      keyPrefix: opts.keyPrefix,
      duration: Math.floor(opts.durationMs / 1000),
      points: opts.points,
    });
    return new RateLimiter(limiter, opts);
  }

  async consume(
    ctx: XRPCReqContext,
    opts?: { calcKey?: CalcKeyFn; calcPoints?: CalcPointsFn },
  ): Promise<RateLimiterStatus | RateLimitExceededError | null> {
    if (
      this.bypassSecret &&
      ctx.c.req.header("x-ratelimit-bypass") === this.bypassSecret
    ) {
      return null;
    }
    const ip = ctx.c.req.header("x-forwarded-for")?.split(",")[0] ||
      ctx.c.req.header("x-real-ip");
    if (this.bypassIps && ip && this.bypassIps.includes(ip)) {
      return null;
    }
    const key = opts?.calcKey ? opts.calcKey(ctx) : this.calcKey(ctx);
    if (key === null) {
      return null;
    }
    const points = opts?.calcPoints
      ? opts.calcPoints(ctx)
      : this.calcPoints(ctx);
    if (points < 1) {
      return null;
    }
    try {
      const res = await this.limiter.consume(key, points);
      return formatLimiterStatus(this.limiter, res);
    } catch (err) {
      // yes this library rejects with a res not an error
      if (err instanceof RateLimiterRes) {
        const status = formatLimiterStatus(this.limiter, err);
        return new RateLimitExceededError(status);
      } else {
        if (this.failClosed) {
          throw err;
        }
        logger.error(
          {
            err,
            keyPrefix: this.limiter.keyPrefix,
            points: this.limiter.points,
            duration: this.limiter.duration,
          },
          "rate limiter failed to consume points",
        );
        return null;
      }
    }
  }

  async reset(
    ctx: XRPCReqContext,
    opts?: { calcKey?: CalcKeyFn },
  ): Promise<void> {
    const key = opts?.calcKey ? opts.calcKey(ctx) : this.calcKey(ctx);
    if (key === null) {
      return;
    }

    try {
      await this.limiter.delete(key);
    } catch (cause) {
      const error = new Error(`rate limiter failed to reset key: ${key}`) as
        & Error
        & { cause: unknown };
      error.cause = cause;
      throw error;
    }
  }
}

/**
 * Formats the rate limiter status into a simplified object.
 * 
 * @param limiter - The rate limiter instance.
 * @param res - The rate limiter response.
 * @returns The rate limiter status.
 */
export const formatLimiterStatus = (
  limiter: RateLimiterAbstract,
  res: RateLimiterRes,
): RateLimiterStatus => {
  return {
    limit: limiter.points,
    duration: limiter.duration,
    remainingPoints: res.remainingPoints,
    msBeforeNext: res.msBeforeNext,
    consumedPoints: res.consumedPoints,
    isFirstInDuration: res.isFirstInDuration,
  };
};

/**
 * Consumes the rate limiter for many functions.
 * @param ctx - The context.
 * @param fns - The functions to consume.
 * @returns The rate limiter status.
 */
export const consumeMany = async (
  ctx: XRPCReqContext,
  fns: RateLimiterConsume[],
): Promise<RateLimiterStatus | RateLimitExceededError | null> => {
  if (fns.length === 0) return null;
  const results = await Promise.all(fns.map((fn) => fn(ctx)));
  const tightestLimit = getTightestLimit(results);
  if (tightestLimit === null) {
    return null;
  } else if (tightestLimit instanceof RateLimitExceededError) {
    setResHeaders(ctx, tightestLimit.status);
    return tightestLimit;
  } else {
    setResHeaders(ctx, tightestLimit);
    return tightestLimit;
  }
};

export const resetMany = async (
  ctx: XRPCReqContext,
  fns: RateLimiterReset[],
): Promise<void> => {
  if (fns.length === 0) return;
  await Promise.all(fns.map((fn) => fn(ctx)));
};

export const setResHeaders = (
  ctx: XRPCReqContext,
  status: RateLimiterStatus,
): void => {
  ctx.c.header("RateLimit-Limit", status.limit.toString());
  ctx.c.header("RateLimit-Remaining", status.remainingPoints.toString());
  ctx.c.header(
    "RateLimit-Reset",
    Math.floor((Date.now() + status.msBeforeNext) / 1000).toString(),
  );
  ctx.c.header("RateLimit-Policy", `${status.limit};w=${status.duration}`);
};

export const getTightestLimit = (
  resps: (RateLimiterStatus | RateLimitExceededError | null)[],
): RateLimiterStatus | RateLimitExceededError | null => {
  let lowest: RateLimiterStatus | null = null;
  for (const resp of resps) {
    if (resp === null) continue;
    if (resp instanceof RateLimitExceededError) return resp;
    if (lowest === null || resp.remainingPoints < lowest.remainingPoints) {
      lowest = resp;
    }
  }
  return lowest;
};

// when using a proxy, ensure x-forwarded-for or x-real-ip headers are set correctly
const defaultKey: CalcKeyFn = (ctx: XRPCReqContext) => {
  const forwarded = ctx.c.req.header("x-forwarded-for")?.split(",")[0];
  if (forwarded) return forwarded;
  const realIp = ctx.c.req.header("x-real-ip");
  if (realIp) return realIp;
  return ctx.c.req.header("x-forwarded-for")?.split(",")[0] ||
    ctx.c.req.header("x-real-ip") || null;
};
const defaultPoints: CalcPointsFn = () => 1;
