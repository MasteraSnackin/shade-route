export type RequestGateDenialReason = "concurrency" | "rate";

export type RequestGateAdmission =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: RequestGateDenialReason; retryAfterSeconds: number };

export interface AggregateRequestGateOptions {
  maximumRequests: number;
  windowMs: number;
  maximumConcurrent: number;
  now?: () => number;
}

/**
 * A privacy-preserving, per-runtime guard. It deliberately does not inspect an
 * IP address, user agent, coordinate or request body. Platform-level limits are
 * still required for a public deployment because edge isolates do not share
 * this in-memory state.
 */
export class AggregateRequestGate {
  private readonly maximumRequests: number;
  private readonly windowMs: number;
  private readonly maximumConcurrent: number;
  private readonly now: () => number;
  private requestTimes: number[] = [];
  private active = 0;

  constructor(options: AggregateRequestGateOptions) {
    if (
      !Number.isSafeInteger(options.maximumRequests) || options.maximumRequests < 1 ||
      !Number.isSafeInteger(options.windowMs) || options.windowMs < 1 ||
      !Number.isSafeInteger(options.maximumConcurrent) || options.maximumConcurrent < 1
    ) {
      throw new RangeError("Request gate limits must be positive integers.");
    }
    this.maximumRequests = options.maximumRequests;
    this.windowMs = options.windowMs;
    this.maximumConcurrent = options.maximumConcurrent;
    this.now = options.now ?? Date.now;
  }

  tryEnter(): RequestGateAdmission {
    const now = this.now();
    const cutoff = now - this.windowMs;
    this.requestTimes = this.requestTimes.filter((timestamp) => timestamp > cutoff);

    if (this.active >= this.maximumConcurrent) {
      return { allowed: false, reason: "concurrency", retryAfterSeconds: 1 };
    }
    if (this.requestTimes.length >= this.maximumRequests) {
      const oldest = this.requestTimes[0] ?? now;
      return {
        allowed: false,
        reason: "rate",
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1_000)),
      };
    }

    this.requestTimes.push(now);
    this.active += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function createRouteRequestGate(environment: Readonly<Record<string, string | undefined>> = process.env) {
  return new AggregateRequestGate({
    maximumRequests: boundedInteger(environment.ROUTE_REQUESTS_PER_MINUTE, 120, 10, 10_000),
    windowMs: 60_000,
    maximumConcurrent: boundedInteger(environment.ROUTE_MAX_CONCURRENT, 8, 1, 100),
  });
}
