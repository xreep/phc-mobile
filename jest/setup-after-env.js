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

// No native module under Jest either. Inert by default — permission undetermined/not granted,
// so a suite that never touches alerts (every existing Dashboard test) renders exactly as it did
// before this feature existed: no permission, no delivery. Suites that exercise alerts override
// these per test with `jest.mocked(fn).mockResolvedValue(...)`.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'undetermined', granted: false })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'undetermined', granted: false })),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('id')),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve({})),
  setNotificationHandler: jest.fn(),
  // Mirrors the real enum's values (`expo-notifications`' `NotificationChannelManager.types`),
  // not just its key names — a test asserting `importance: AndroidImportance.MAX` would pass
  // against any made-up numbering, so the numbers themselves have to be real for a channel
  // config mistake (e.g. HIGH where MAX belongs) to be visible to `toEqual`.
  AndroidImportance: {
    UNKNOWN: 0,
    UNSPECIFIED: 1,
    NONE: 2,
    MIN: 3,
    LOW: 4,
    DEFAULT: 5,
    HIGH: 6,
    MAX: 7,
  },
  // Re-exported by `expo-notifications` from `expo` (`PermissionsInterface.ts`). Tests build
  // permission responses against these rather than raw string literals, so a typo here would
  // fail the same tests it is meant to support.
  PermissionStatus: {
    GRANTED: 'granted',
    UNDETERMINED: 'undetermined',
    DENIED: 'denied',
  },
}));

// `expo-crypto` backs the Telegram link token (`src/sos/telegram-link.ts`). Under Jest the
// native CSPRNG is absent, so `getRandomValues` fills the array with a fixed, obviously
// non-random ramp — deterministic on purpose, so a test can pin the exact token a given byte
// sequence encodes to. Nothing under test depends on these bytes being unpredictable; the
// property the real module provides (128 bits from the OS CSPRNG) is documented, not tested.
jest.mock('expo-crypto', () => ({
  getRandomValues: jest.fn((array) => {
    for (let i = 0; i < array.length; i += 1) array[i] = (i * 37 + 11) & 0xff;
    return array;
  }),
  getRandomBytes: jest.fn((count) => {
    const array = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) array[i] = (i * 37 + 11) & 0xff;
    return array;
  }),
  getRandomBytesAsync: jest.fn((count) => {
    const array = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) array[i] = (i * 37 + 11) & 0xff;
    return Promise.resolve(array);
  }),
  randomUUID: jest.fn(() => '00000000-0000-4000-8000-000000000000'),
}));

// `expo-sqlite` is a native module too. Inert by default — `openDatabaseAsync` rejects — so
// `ReadingStoreProvider` takes its documented fallback (`MemoryReadingStore`) in every suite and
// no test ever touches a database file. `src/store/__tests__/sqlite.test.ts` exercises the SQL
// layer against a fake `SQLiteDatabase` instead; the real driver is device-validated only.
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(() =>
    Promise.reject(new Error('expo-sqlite is not available under Jest')),
  ),
}));
