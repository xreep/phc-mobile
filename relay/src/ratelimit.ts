/**
 * Best-effort per-IP token bucket, held in isolate memory.
 *
 * ## What "best-effort" means here
 * A Worker runs in many isolates across many Cloudflare locations, each with its own copy of this
 * map, and an isolate can be evicted at any time. So this limiter bounds what one isolate will do
 * for one IP — it stops a naive loop, not a distributed attacker. Real enforcement is a
 * **dashboard rate-limiting rule** on the Worker's route (free tier includes it), documented in
 * README.md. A KV- or Durable-Object-backed limiter would be accurate but adds a paid-tier
 * dependency or a write per request for something the edge already does better.
 *
 * ## Sizing
 * An emergency is a handful of requests: one per contact, once. The default of 10 per minute per
 * IP costs a real user nothing and turns a leaked URL into a slow drip rather than a firehose.
 */

export interface RateLimiterOptions {
  /** Requests allowed per window from one key. */
  readonly limit: number;
  /** Window length. */
  readonly windowMs: number;
  /** Injected clock for tests. */
  readonly now?: () => number;
  /** Cap on tracked keys; the oldest are dropped past it so memory stays bounded. */
  readonly maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    this.#limit = Math.max(1, options.limit);
    this.#windowMs = Math.max(1, options.windowMs);
    this.#now = options.now ?? Date.now;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  /** Spend one token for `key`. False when the bucket is empty. */
  allow(key: string): boolean {
    const now = this.#now();
    const refillPerMs = this.#limit / this.#windowMs;
    let bucket = this.#buckets.get(key);

    if (bucket === undefined) {
      bucket = { tokens: this.#limit, updatedAt: now };
      this.#buckets.set(key, bucket);
      this.#evict();
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(this.#limit, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = now;
    }

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Tracked keys — for tests and the eviction guard. */
  get size(): number {
    return this.#buckets.size;
  }

  #evict(): void {
    // Map iterates in insertion order, so the first entries are the oldest first-seen keys.
    while (this.#buckets.size > this.#maxKeys) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest === undefined) break;
      this.#buckets.delete(oldest);
    }
  }
}

/** The client IP as Cloudflare reports it; falls back to a shared bucket rather than no limit. */
export function clientKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
