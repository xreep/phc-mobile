import { describe, expect, it } from 'vitest';

import { clientKey, RateLimiter } from '../src/ratelimit';

function limiter(limit: number, windowMs = 60_000, maxKeys?: number) {
  let now = 0;
  const rl = new RateLimiter({ limit, windowMs, now: () => now, ...(maxKeys === undefined ? {} : { maxKeys }) });
  return { rl, advance: (ms: number) => (now += ms) };
}

describe('RateLimiter', () => {
  it('allows `limit` requests in a window and then refuses', () => {
    const { rl } = limiter(3);
    expect([rl.allow('a'), rl.allow('a'), rl.allow('a'), rl.allow('a')]).toEqual([true, true, true, false]);
  });

  it('keeps keys independent', () => {
    const { rl } = limiter(1);
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
    expect(rl.allow('b')).toBe(true);
  });

  it('refills continuously over the window', () => {
    const { rl, advance } = limiter(6, 60_000);
    for (let i = 0; i < 6; i += 1) rl.allow('a');
    expect(rl.allow('a')).toBe(false);
    advance(10_000); // one token per 10 s
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
    advance(60_000);
    for (let i = 0; i < 6; i += 1) expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
  });

  it('never refills above the limit', () => {
    const { rl, advance } = limiter(2);
    advance(3_600_000);
    expect([rl.allow('a'), rl.allow('a'), rl.allow('a')]).toEqual([true, true, false]);
  });

  it('bounds memory by evicting the oldest keys', () => {
    const { rl } = limiter(1, 60_000, 3);
    for (const key of ['a', 'b', 'c', 'd']) rl.allow(key);
    expect(rl.size).toBe(3);
    // 'a' was evicted, so it gets a fresh bucket.
    expect(rl.allow('a')).toBe(true);
  });

  it('treats a non-positive limit as 1', () => {
    const { rl } = limiter(0);
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
  });
});

describe('clientKey', () => {
  it('uses CF-Connecting-IP and shares a bucket when it is absent', () => {
    expect(clientKey(new Request('https://relay.test/sos', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }))).toBe('203.0.113.7');
    expect(clientKey(new Request('https://relay.test/sos'))).toBe('unknown');
  });
});
