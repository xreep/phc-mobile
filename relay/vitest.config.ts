import { defineConfig } from 'vitest/config';

// Plain Node environment: every upstream call goes through `fetch`, which each test stubs with
// `vi.stubGlobal`, and KV is faked in memory (test/helpers/fake-kv.ts). Nothing here needs the
// workerd runtime, so `@cloudflare/vitest-pool-workers` is deliberately not used — it would add a
// second toolchain for no additional coverage.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
