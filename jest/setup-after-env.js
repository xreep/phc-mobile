/**
 * Test environment shims for native modules that have no JS implementation under Jest.
 *
 * Runs via `setupFilesAfterEnv` rather than `setupFiles`, because jest-expo's preset owns
 * `setupFiles` (React Native's own setup plus Expo's) and replacing that array would break
 * every test in the suite. The preset leaves `setupFilesAfterEnv` unset, so appending here
 * is additive.
 */

/* globals jest -- a setup file runs inside the Jest environment, which the lint config
   (scoped to app source) does not declare globals for. */

// AsyncStorage is a thin bridge to a native module that does not exist in the Jest
// environment; without this every call rejects. The package ships an in-memory
// implementation for exactly this purpose, so the cache module under test runs its real
// code path against real storage semantics rather than against a hand-rolled stub.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Neither native module exists under Jest. The defaults below describe a device with no
// Health Connect and no accelerometer, so a screen test that never touches sensors renders
// exactly as it did before the feed existed. Suites that exercise the feed override these
// per test with `jest.mocked(fn).mockResolvedValue(...)`.
jest.mock('react-native-health-connect', () => ({
  SdkAvailabilityStatus: {
    SDK_UNAVAILABLE: 1,
    SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED: 2,
    SDK_AVAILABLE: 3,
  },
  getSdkStatus: jest.fn(() => Promise.resolve(1)),
  initialize: jest.fn(() => Promise.resolve(false)),
  getGrantedPermissions: jest.fn(() => Promise.resolve([])),
  requestPermission: jest.fn(() => Promise.resolve([])),
  readRecords: jest.fn(() => Promise.resolve({ records: [] })),
}));

jest.mock('expo-sensors', () => ({
  Accelerometer: {
    isAvailableAsync: jest.fn(() => Promise.resolve(false)),
    setUpdateInterval: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
