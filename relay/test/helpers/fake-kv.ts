/**
 * In-memory stand-in for the `LINKS` KV namespace, with TTL driven by an injectable clock so
 * expiry is tested without waiting. Implements the `LinkStore` subset and is cast to `KVNamespace`
 * only where an `Env` is needed.
 */

import type { LinkStore } from '../../src/link';

export class FakeKV implements LinkStore {
  readonly #entries = new Map<string, { value: string; expiresAt: number | null }>();
  readonly puts: Array<{ key: string; value: string; expirationTtl: number | undefined }> = [];
  now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && this.now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    // Mirror the real constraint so a test would catch a TTL below Cloudflare's minimum.
    if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
      throw new Error('KV expirationTtl must be at least 60 seconds');
    }
    this.puts.push({ key, value, expirationTtl: options?.expirationTtl });
    const expiresAt = options?.expirationTtl === undefined ? null : this.now() + options.expirationTtl * 1000;
    this.#entries.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  asNamespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
