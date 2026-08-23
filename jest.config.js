// https://docs.expo.dev/develop/unit-testing/
/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',

  // Jest applies `moduleNameMapper` entries in insertion order, uses the first
  // match, and does not re-map the result. Keys declared here are merged ahead of
  // the preset's. jest-expo derives the aliases from tsconfig `paths` too, but
  // emits the broad "@/*" rule first, where it swallows both "@/assets/*" and
  // "@/global.css". So: most specific first, broad alias last.
  moduleNameMapper: {
    // Metro handles CSS; Jest has no CSS transform, so stub it for tests.
    // Must precede the "@/*" alias, which would otherwise claim @/global.css.
    '\\.css$': '<rootDir>/jest/style-mock.js',
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // `setupFilesAfterEnv`, not `setupFiles`: the preset owns `setupFiles` (React Native's
  // setup plus Expo's) and a key declared here would replace that array rather than extend
  // it. `setupFilesAfterEnv` is unset by the preset, so this is purely additive.
  setupFilesAfterEnv: ['<rootDir>/jest/setup-after-env.js'],

  // jest-expo's default testMatch treats EVERY file under a __tests__ directory as a
  // suite, so a shared fixtures/helpers module placed there fails with "must contain
  // at least one test". Requiring an explicit .test/.spec infix lets helpers live
  // beside the tests that use them.
  testMatch: ['**/*.@(test|spec).@(ts|tsx|js|jsx)'],

  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/', '/dist/', '/.expo/'],
  // Generated native build output duplicates package.json files, which confuses
  // the module map.
  modulePathIgnorePatterns: ['<rootDir>/android/', '<rootDir>/ios/'],

  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts'],
};
