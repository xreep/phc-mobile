# Live Health Connect Sensor Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the Dashboard's Tier-1 risk engine a live `SensorReading[]` ring buffer from Android Health Connect (HR, SpO₂, skin temperature) plus the phone accelerometer folded into `MotionSummary`, gated by the existing Settings "Sensor source" picker so the simulated window stays available as the demo fallback.

**Architecture:** A new `src/sensors/` module mirrors `src/environment/`: pure mappers and I/O in `health-connect.ts`, an accelerometer fold in `motion.ts`, a pure ring-buffer merge in `ring-buffer.ts`, a polling hook `hooks/use-sensors.ts` (same AppState / mounted-ref / never-prompt-from-background discipline as `hooks/use-environment.ts`), and a `SensorProvider` context hoisted into the root layout. `useRiskAssessment` picks live readings when `settings.sensorSource === 'health_connect'` and the mock window otherwise; the dev-only "simulate a fall" control keeps working on both paths.

**Tech Stack:** Expo SDK 57 (React Native 0.86, React 19.2, TypeScript 6), expo-router, `react-native-health-connect@4.1.3`, `expo-sensors@~57.0.3`, `expo-dev-client@~57.0.19`, `expo-build-properties@~57.0.17`, Jest via `jest-expo`, `@testing-library/react-native` v14.

**Spec:** `docs/superpowers/specs/2026-09-15-health-connect-sensor-ingestion-design.md`

## Global Constraints

- Node is at `/opt/homebrew/bin/node` (v22). Every shell step below assumes `export PATH="/opt/homebrew/bin:$PATH"` and cwd `/Users/adityaraj/Desktop/sih/dev/phc-mobile`.
- The working tree's source files are CRLF (copied from Windows). **Write new files with LF.** When editing an existing CRLF file, preserve its line endings (the Edit tool does this; heredocs do not — do not rewrite whole existing files via heredoc).
- Baseline: `npm test` → **40 suites, 985 tests, all passing**. `npx tsc --noEmit` → clean. Both must stay green after every task; the test count only goes up.
- `SensorReading` (`src/risk/types.ts`): `source: 'health_connect' | 'ble_esp32' | 'simulated'`, `timestamp` epoch **ms**, optional `hr` (bpm), `spo2` (%), `skinTempC` (°C, skin not core), `motion?: MotionVector`, `motionSummary?: MotionSummary { peakG, minG, rmsG, sampleCount }` in **g with gravity** (rest ≈ 1.0). **A missing vital is `undefined`, never `0`.**
- Source literal for Health Connect readings: `'health_connect'` (already in `SensorSourceOption`, `src/constants/health-data.ts:188`). Do not add a source.
- Poll cadence: `60_000` ms. Buffer retention comes from the engine's `longestLookbackMs(resolveRiskThresholds())` (Task 2) — never a hardcoded minute count.
- Permission dialogs are raised only from a user-initiated `requestAccess()`. The interval and AppState paths never prompt.
- `SkinTemperature` Health Connect records are deltas from an optional baseline: emit `skinTempC = baseline.inCelsius + delta.inCelsius` only when `baseline` is present; otherwise emit nothing. Never read `BodyTemperature`.
- Do not touch `src/app/trends.tsx`, add TFLite, BLE, or iOS/HealthKit.
- Commits: end messages with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Commit with `git -c core.autocrlf=false commit` and add only the files named in the task, never `git add -A` (the CRLF noise across 69 files must not be committed by accident).
- `react-native-health-connect@4.1.3` API (verified from the package's `.d.ts`): `getSdkStatus(): Promise<number>` compared against `SdkAvailabilityStatus.SDK_AVAILABLE (3)` / `SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED (2)`; `initialize(): Promise<boolean>`; `getGrantedPermissions(): Promise<Permission[]>`; `requestPermission(Permission[]): Promise<Permission[]>` where `Permission = { accessType: 'read' | 'write'; recordType: RecordType }`; `readRecords(recordType, { timeRangeFilter: { operator: 'between', startTime: ISO, endTime: ISO }, ascendingOrder?: boolean }): Promise<{ records: RecordResult<T>[] }>`. Record results: `HeartRate` → `{ startTime, endTime, samples: { time: string; beatsPerMinute: number }[] }`; `OxygenSaturation` → `{ time: string; percentage: number }`; `SkinTemperature` → `{ startTime, endTime, baseline?: { inCelsius: number; inFahrenheit: number }; deltas: { time: string; delta: { inCelsius: number; inFahrenheit: number } }[] }`.
- `expo-sensors` `Accelerometer` (default export of `expo-sensors/build/Accelerometer`, re-exported as `Accelerometer`): `isAvailableAsync(): Promise<boolean>`, `setUpdateInterval(ms)`, `addListener((m: { x, y, z, timestamp }) => void): { remove(): void }`. Values are in g.

---

## File map

| File | Responsibility |
| --- | --- |
| `package.json`, `app.json` | new deps, config plugins, Android health permissions |
| `jest/setup-after-env.js` | inert global mocks for the two native modules |
| `src/risk/assess.ts`, `src/risk/index.ts` | export `longestLookbackMs(thresholds)` |
| `src/sensors/types.ts` | `SensorFeed`, `SensorFeedStatus`, `SensorFailure` |
| `src/sensors/health-connect.ts` | pure record→reading mappers; SDK check, permission, read I/O |
| `src/sensors/motion.ts` | accelerometer accumulator + fold |
| `src/sensors/ring-buffer.ts` | `mergeReadings` (dedupe, sort, trim) |
| `src/hooks/use-sensors.ts` | polling hook |
| `src/sensors/provider.tsx`, `src/sensors/index.ts` | context + public surface |
| `src/app/_layout.tsx` | mount `SensorProvider` |
| `src/constants/mock-sensor-window.ts` | `spliceSimulatedFall` for live mode |
| `src/hooks/use-risk-assessment.ts` | choose live vs mock window |
| `src/components/sensor-feed-notice.tsx`, `src/app/index.tsx` | feed status row on the Dashboard |
| tests under `src/sensors/__tests__/`, `src/hooks/__tests__/`, `src/components/__tests__/`, `src/__tests__/` | per task |

---

### Task 1: Dependencies, native config, and global test mocks

**Files:**
- Modify: `package.json` (via `npx expo install`)
- Modify: `app.json`
- Modify: `jest/setup-after-env.js`

**Interfaces:**
- Produces: installed modules `react-native-health-connect`, `expo-sensors`; Jest mocks for both that every later test can override with `mocked(fn).mockResolvedValue(...)`.

- [ ] **Step 1: Install the packages**

```bash
export PATH="/opt/homebrew/bin:$PATH" && cd /Users/adityaraj/Desktop/sih/dev/phc-mobile && npx expo install react-native-health-connect expo-sensors expo-dev-client && npx expo install expo-build-properties -- --save-dev
```

Expected: `package.json` gains `"react-native-health-connect": "^4.1.3"`, `"expo-sensors": "~57.0.3"`, `"expo-dev-client": "~57.0.19"` under `dependencies` and `"expo-build-properties": "~57.0.17"` under `devDependencies` (patch versions may be newer; majors must match). Verify with `grep -nE 'health-connect|expo-sensors|expo-dev-client|expo-build-properties' package.json`.

- [ ] **Step 2: Configure `app.json`**

Edit `app.json`. In `expo.android`, add a `permissions` array; in `expo.plugins`, append the two plugin entries. The result must be:

```json
"android": {
  "adaptiveIcon": {
    "backgroundColor": "#208AEF",
    "foregroundImage": "./assets/images/android-icon-foreground.png",
    "backgroundImage": "./assets/images/android-icon-background.png",
    "monochromeImage": "./assets/images/android-icon-monochrome.png"
  },
  "predictiveBackGestureEnabled": false,
  "package": "com.anonymous.phcmobile",
  "permissions": [
    "android.permission.health.READ_HEART_RATE",
    "android.permission.health.READ_OXYGEN_SATURATION",
    "android.permission.health.READ_SKIN_TEMPERATURE"
  ]
},
```

and, at the end of the existing `plugins` array (after the `expo-location` entry):

```json
    "react-native-health-connect",
    [
      "expo-build-properties",
      {
        "android": {
          "minSdkVersion": 26
        }
      }
    ]
```

- [ ] **Step 3: Validate the config resolves**

```bash
npx expo config --type prebuild 2>&1 | grep -nE 'health|minSdk|READ_' | head
```

Expected: the three `android.permission.health.READ_*` strings and `"minSdkVersion": 26` appear; no error output.

- [ ] **Step 4: Add global mocks**

Append to `jest/setup-after-env.js` (this file is LF; append with the Edit tool after the AsyncStorage mock):

```js
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
```

- [ ] **Step 5: Confirm the baseline is intact**

```bash
npm test -- --silent 2>&1 | tail -5
```

Expected: `Test Suites: 40 passed, 40 total`, `Tests: 985 passed, 985 total`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json app.json jest/setup-after-env.js && git -c core.autocrlf=false commit -m "build: add Health Connect, expo-sensors, dev client and Android health permissions (PRD §6.4)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Export the engine's longest lookback

**Files:**
- Modify: `src/risk/assess.ts:115-121`
- Modify: `src/risk/index.ts`
- Test: `src/risk/__tests__/assess.test.ts` (append one `describe`)

**Interfaces:**
- Produces: `longestLookbackMs(thresholds: RiskThresholds): number`, exported from `@/risk`.

- [ ] **Step 1: Write the failing test**

Append to the end of `src/risk/__tests__/assess.test.ts` (CRLF file — use the Edit tool, matching the file's final lines):

```ts
describe('longestLookbackMs', () => {
  it('is the largest of every rule lookback, with the stillness gap headroom included', () => {
    const t = DEFAULT_RISK_THRESHOLDS;
    const expected = Math.max(
      t.window.ms,
      t.stillness.heatCriticalMs + t.window.maxGapMs,
      t.fall.stillnessWindowMs,
      t.dehydration.windowMs,
      t.fatigue.windowMs,
    );
    expect(longestLookbackMs(t)).toBe(expected);
    // Every consumer of the buffer relies on this being at least every individual bound.
    expect(longestLookbackMs(t)).toBeGreaterThanOrEqual(t.fatigue.windowMs);
    expect(longestLookbackMs(t)).toBeGreaterThanOrEqual(
      t.stillness.heatCriticalMs + t.window.maxGapMs,
    );
  });
});
```

Add `longestLookbackMs` and `DEFAULT_RISK_THRESHOLDS` to the file's existing `import { … } from '@/risk'` (or `'../index'` — match whichever specifier the file already uses; check with `grep -n "from '" src/risk/__tests__/assess.test.ts | head -5`).

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest src/risk/__tests__/assess.test.ts -t longestLookbackMs 2>&1 | tail -8
```

Expected: FAIL — `longestLookbackMs` is not exported.

- [ ] **Step 3: Extract the helper in `assess.ts`**

In `src/risk/assess.ts`, add `RiskThresholds` to the `import type { … } from './types'` list, then replace the inline `const longestLookbackMs = Math.max(…)` block (lines ~115-121) with a call, and add the exported function above `assessRisk`:

```ts
/**
 * The furthest back any rule reads, for the ingestion layer's ring buffer.
 *
 * Exported because `RiskAssessmentInput.readings` documents that the buffer must span this
 * bound, and a buffer that is trimmed to a hand-typed number will silently fall short the
 * day a rule's window grows. `heatCriticalMs` carries `maxGapMs` of headroom for the
 * half-open-window reason explained at the call site below.
 */
export function longestLookbackMs(thresholds: RiskThresholds): number {
  return Math.max(
    thresholds.window.ms,
    thresholds.stillness.heatCriticalMs + thresholds.window.maxGapMs,
    thresholds.fall.stillnessWindowMs,
    thresholds.dehydration.windowMs,
    thresholds.fatigue.windowMs,
  );
}
```

and inside `assessRisk`:

```ts
  const extendedReadings = withinWindow(sorted, now, longestLookbackMs(thresholds));
```

(keep the explanatory comment block that precedes it).

In `src/risk/index.ts` change `export { assessRisk } from './assess';` to:

```ts
export { assessRisk, longestLookbackMs } from './assess';
```

- [ ] **Step 4: Run tests**

```bash
npx jest src/risk 2>&1 | tail -5 && npx tsc --noEmit
```

Expected: all risk suites pass (test count +1); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/risk/assess.ts src/risk/index.ts src/risk/__tests__/assess.test.ts && git -c core.autocrlf=false commit -m "feat(risk): export longestLookbackMs for the ingestion ring buffer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2b: Still-run primitives skip motion-less readings

**Why this task exists.** Health Connect vitals and the accelerometer fold arrive as *separate* readings (the `SensorReading` contract requires it). `longestStillRunMs` and `trailingStillRunMs` in `src/risk/window.ts` currently treat a reading whose stillness is *unknown* (`isStillInterval` → `null`, i.e. no motion data) exactly like one that is *moving*, and break the run. On a live buffer every HR sample therefore breaks every still run: probed against the real engine, a motion-only buffer with an impact then stillness escalates to `fall.impactThenStillness` / score 100 / SOS candidate, while the same buffer with an HR-only reading interleaved every 30 s stops at `fall.impact.unconfirmed` / 50 / no SOS. `heat.stillness.critical` and the fatigue rule use the same primitive. This is the "threshold rendered unsatisfiable by the shape of its input" failure the engine's comments warn about, and it must be fixed before any live-mode test can be honest.

**The fix.** Unknown ≠ moving. Both primitives skip `null` readings and measure `maxGapMs` between consecutive *motion-bearing* readings. The safety argument in the existing doc comment ("counting unobserved intervals as still would let a sensor dropout confirm a fall") is preserved by the gap check: a dropout longer than `maxGapMs` still breaks the run — it just no longer takes a heart-rate sample to do it. `restFraction` already skips nulls and needs no change; `trailingRun` works on per-field samples and is unaffected.

**Files:**
- Modify: `src/risk/window.ts` (`longestStillRunMs`, `trailingStillRunMs` and their doc comments)
- Test: `src/risk/__tests__/stillness.test.ts` (append)
- Test: `src/risk/__tests__/assess.test.ts` (append)

**Interfaces:**
- Produces: unchanged signatures. `longestStillRunMs(readings, options)` and `trailingStillRunMs(readings, options)` now ignore readings with no usable motion.

- [ ] **Step 1: Write the failing primitive tests**

Append to `src/risk/__tests__/stillness.test.ts` (CRLF — Edit tool). Extend the existing `import { isStillInterval, motionEstimate } from '../window';` to also import `longestStillRunMs` and `trailingStillRunMs`, and extend `import { at, reading } from './fixtures';` to also import `activeMotion`, `MINUTE`, `stillMotion`:

```ts
describe('still runs ignore readings that carry no motion', () => {
  const options = {
    restBandG: fall.restBandG,
    stillnessPeakG: fall.stillnessPeakG,
    motionRange: plausible.motionG,
    maxGapMs: DEFAULT_RISK_THRESHOLDS.window.maxGapMs,
  };

  /** Motion once a minute, a heart-rate sample thirty seconds after each — the live shape. */
  function interleaved(minutes: number, motionAt: (minute: number) => MotionSummary): SensorReading[] {
    const out: SensorReading[] = [];
    for (let m = 0; m <= minutes; m += 1) {
      out.push(reading({ at: at(m * MINUTE), motionSummary: motionAt(m) }));
      if (m < minutes) out.push(reading({ at: at(m * MINUTE + 30_000), hr: 74 }));
    }
    return out;
  }

  it('longestStillRunMs spans interleaved vitals as if they were not there', () => {
    const readings = interleaved(5, () => stillMotion());
    expect(longestStillRunMs(readings, options)).toBe(5 * MINUTE);
  });

  it('trailingStillRunMs spans interleaved vitals as if they were not there', () => {
    const readings = interleaved(5, () => stillMotion());
    expect(trailingStillRunMs(readings, options)).toBe(5 * MINUTE);
  });

  it('a motion-less reading newer than the last motion reading does not zero the trailing run', () => {
    const readings = [...interleaved(3, () => stillMotion()), reading({ at: at(3 * MINUTE + 20_000), hr: 75 })];
    expect(trailingStillRunMs(readings, options)).toBe(3 * MINUTE);
  });

  it('a moving reading still breaks both runs', () => {
    const readings = interleaved(5, (m) => (m === 3 ? activeMotion() : stillMotion()));
    expect(longestStillRunMs(readings, options)).toBe(2 * MINUTE);
    expect(trailingStillRunMs(readings, options)).toBe(2 * MINUTE);
  });

  it('an accelerometer dropout longer than maxGapMs still breaks the run — the safety case', () => {
    // Motion at 0, 1, 2 min; nothing until 5 min (gap 3 min > maxGapMs 2 min); motion at 5, 6.
    // Heart-rate samples continue throughout, and must not bridge the gap.
    const readings: SensorReading[] = [];
    for (const m of [0, 1, 2, 5, 6]) readings.push(reading({ at: at(m * MINUTE), motionSummary: stillMotion() }));
    for (let m = 0; m < 6; m += 1) readings.push(reading({ at: at(m * MINUTE + 30_000), hr: 74 }));
    readings.sort((a, b) => a.timestamp - b.timestamp);

    expect(trailingStillRunMs(readings, options)).toBe(1 * MINUTE);
    expect(longestStillRunMs(readings, options)).toBe(2 * MINUTE);
  });

  it('returns 0 when no reading carries motion', () => {
    const readings = [reading({ at: at(0), hr: 70 }), reading({ at: at(MINUTE), hr: 71 })];
    expect(longestStillRunMs(readings, options)).toBe(0);
    expect(trailingStillRunMs(readings, options)).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing end-to-end test**

Append to `src/risk/__tests__/assess.test.ts` (CRLF — Edit tool). It needs `reading`, `at`, `MINUTE`, `stillMotion`, `impactMotion` from `./fixtures` (check the file's existing fixture import and extend it) and `assessRisk` (already imported):

```ts
describe('live-shaped buffers (vitals and motion as separate readings)', () => {
  /** One motion reading per minute; an HR sample 30 s after each. Impact two minutes ago. */
  function liveShaped(): SensorReading[] {
    const out: SensorReading[] = [];
    for (let m = -20; m <= 0; m += 1) {
      out.push(
        reading({
          at: at(m * MINUTE),
          source: 'health_connect',
          motionSummary: m === -2 ? { peakG: 3.1, minG: 0.32, rmsG: 1.12, sampleCount: 1500 } : stillMotion(1500),
        }),
      );
      if (m < 0) out.push(reading({ at: at(m * MINUTE + 30_000), source: 'health_connect', hr: 74 }));
    }
    return out;
  }

  it('confirms an impact followed by stillness and escalates it, despite interleaved vitals', () => {
    const assessment = assessRisk({ readings: liveShaped(), now: at(0) });
    expect(assessment.byCategory.fall.rule).toBe('fall.impactThenStillness');
    expect(assessment.byCategory.fall.criticalRules).toContain('fall.impactThenStillness');
    expect(assessment.sosCandidate).toBe(true);
  });
});
```

If `assess.test.ts` already declares a `SensorReading` import, reuse it; otherwise add `import type { SensorReading } from '@/risk';`.

- [ ] **Step 3: Run to verify they fail**

```bash
npx jest src/risk/__tests__/stillness.test.ts src/risk/__tests__/assess.test.ts -t "ignore readings|live-shaped" 2>&1 | tail -20
```

Expected: FAIL — the interleaved spans come back `0` and the assess test reports `fall.impact.unconfirmed`.

- [ ] **Step 4: Fix `longestStillRunMs` and `trailingStillRunMs` in `src/risk/window.ts`** (CRLF — Edit tool)

Replace the doc comment and body of `longestStillRunMs` with:

```ts
/**
 * Longest contiguous stillness, in ms, anywhere in `readings`.
 *
 * Readings with no motion data are **skipped**, not counted as still and not counted as
 * moving. The live feed delivers heart-rate and SpO₂ samples as their own readings between
 * the once-a-minute motion summaries, and treating those as "moving" made every still run
 * zero on real hardware — the fall confirmation and PRD §7.2.5's ten-minute stillness were
 * unsatisfiable by the shape of the input.
 *
 * The conservative direction is kept where it matters: `maxGapMs` is measured between
 * consecutive *motion-bearing* readings, so an accelerometer dropout longer than that still
 * breaks the run. Unobserved time is not qualifying time; a heart-rate sample simply is not
 * an observation of motion either way.
 */
export function longestStillRunMs(
  readings: readonly SensorReading[],
  options: StillnessOptions,
): number {
  const { restBandG, stillnessPeakG, motionRange, maxGapMs } = options;
  let best = 0;
  let runStart: number | null = null;
  let previous = 0;

  for (const reading of readings) {
    const still = isStillInterval(reading, restBandG, stillnessPeakG, motionRange);
    if (still === null) continue;
    if (!still) {
      runStart = null;
      continue;
    }
    if (runStart === null || reading.timestamp - previous > maxGapMs) {
      runStart = reading.timestamp;
    }
    previous = reading.timestamp;
    best = Math.max(best, reading.timestamp - runStart);
  }

  return best;
}
```

and `trailingStillRunMs` with:

```ts
/**
 * Stillness run that is still ongoing at the newest *motion-bearing* reading, in ms — for
 * PRD §7.2.5's "no motion for > 10 min".
 *
 * Anchored to the newest motion reading for the same reason as {@link trailingRun}:
 * stillness that ended is not stillness now. Readings without motion are skipped in both
 * directions (see {@link longestStillRunMs}); the span stops at the newest motion reading
 * rather than extending to `now` or to a later vitals sample, since the time after it is
 * unobserved.
 */
export function trailingStillRunMs(
  readings: readonly SensorReading[],
  options: StillnessOptions,
): number {
  const { restBandG, stillnessPeakG, motionRange, maxGapMs } = options;

  let newestIndex = readings.length - 1;
  while (newestIndex >= 0) {
    const still = isStillInterval(readings[newestIndex], restBandG, stillnessPeakG, motionRange);
    if (still === true) break;
    if (still === false) return 0;
    newestIndex -= 1;
  }
  if (newestIndex < 0) return 0;

  const newest = readings[newestIndex];
  let runStartIndex = newestIndex;
  let previousTimestamp = newest.timestamp;
  for (let i = newestIndex - 1; i >= 0; i -= 1) {
    const candidate = readings[i];
    const still = isStillInterval(candidate, restBandG, stillnessPeakG, motionRange);
    if (still === null) continue;
    if (!still) break;
    if (previousTimestamp - candidate.timestamp > maxGapMs) break;
    runStartIndex = i;
    previousTimestamp = candidate.timestamp;
  }

  return newest.timestamp - readings[runStartIndex].timestamp;
}
```

- [ ] **Step 5: Run the whole risk suite, then everything**

```bash
npx jest src/risk 2>&1 | tail -6 && npm test -- --silent 2>&1 | tail -6 && npx tsc --noEmit
```

Expected: every risk suite passes including the new tests; the full suite passes with a count higher than the previous task's. If any *existing* fall/fatigue/heat test fails, read it before changing anything: the expected outcomes of a fixture that interleaves motion-less readings inside a still run have legitimately changed, and the test's expectation is what must move — the mock window (`mock-sensor-window.test.ts`) carries motion on every reading and must be unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/risk/window.ts src/risk/__tests__/stillness.test.ts src/risk/__tests__/assess.test.ts && git -c core.autocrlf=false commit -m "fix(risk): still runs skip motion-less readings so live buffers can confirm a fall

Health Connect vitals and the accelerometer fold arrive as separate readings;
treating a heart-rate sample as 'moving' zeroed every still run on real data.
Gaps are now measured between motion-bearing readings, so a sensor dropout
still breaks the run.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Feed types and Health Connect record mappers

**Files:**
- Create: `src/sensors/types.ts`
- Create: `src/sensors/health-connect.ts` (mappers only in this task)
- Test: `src/sensors/__tests__/health-connect.test.ts`

**Interfaces:**
- Produces:
  - `SensorFeedStatus = 'idle' | 'unavailable' | 'permission-required' | 'loading' | 'live' | 'error'`
  - `SensorFailure = { message: string; kind: 'sdk' | 'permission' | 'read' | 'unknown' }`
  - `SensorFeed = { readings: readonly SensorReading[]; status; failure: SensorFailure | null; lastPolledAt: number | null; requestAccess(): void; refresh(): void }`
  - `HEALTH_CONNECT_SOURCE = 'health_connect'`
  - `mapHeartRate(records: readonly HeartRateInput[]): SensorReading[]`
  - `mapOxygenSaturation(records: readonly OxygenSaturationInput[]): SensorReading[]`
  - `mapSkinTemperature(records: readonly SkinTemperatureInput[]): SensorReading[]`

- [ ] **Step 1: Create `src/sensors/types.ts`**

```ts
/**
 * The live sensor feed's React-facing shape (PRD §7.2.1).
 *
 * Deliberately parallel to `EnvironmentFeed` in `hooks/use-environment.ts`: a value, a status
 * that says how much to trust it, a failure that survives alongside whatever is still on
 * screen, and the user-initiated actions. The Dashboard reads `status` to say *why* there are
 * no readings rather than rendering a silent empty row.
 */

import type { SensorReading } from '@/risk';

export type SensorFeedStatus =
  /** The feed is switched off — Settings has a source other than Health Connect selected. */
  | 'idle'
  /** No Health Connect on this device (or not Android). Nothing will ever arrive. */
  | 'unavailable'
  /** Health Connect is present but none of the vitals permissions are granted. */
  | 'permission-required'
  /** Checking the SDK / permissions, or the first poll is in flight. */
  | 'loading'
  /** Polling. `readings` may still be empty if the band has not written anything recently. */
  | 'live'
  /** The last poll failed. `readings` keeps what was already buffered. */
  | 'error';

export type SensorFailureKind = 'sdk' | 'permission' | 'read' | 'unknown';

export type SensorFailure = {
  readonly message: string;
  readonly kind: SensorFailureKind;
};

export type SensorFeed = {
  /** Oldest → newest. Spans at least the engine's longest lookback once warm. */
  readonly readings: readonly SensorReading[];
  readonly status: SensorFeedStatus;
  /** Set whenever the last step failed, even while buffered readings are still shown. */
  readonly failure: SensorFailure | null;
  /** Epoch ms of the last successful poll; null before the first. */
  readonly lastPolledAt: number | null;
  /** User-initiated: the only path that raises the Health Connect permission dialog. */
  readonly requestAccess: () => void;
  /** User-initiated poll. Never prompts. */
  readonly refresh: () => void;
};
```

- [ ] **Step 2: Write the failing mapper tests**

Create `src/sensors/__tests__/health-connect.test.ts`:

```ts
/**
 * Health Connect → `SensorReading` mapping.
 *
 * The one property that matters most here is negative: a vital the record does not carry must
 * come out `undefined`, never `0`. `risk/types.ts` spells out why — the engine reads `spo2: 0`
 * as catastrophic hypoxia and would fire an emergency on it. Skin temperature is where that
 * bites in practice, because Health Connect stores it as *deltas* from an optional baseline,
 * and a delta on its own is not a temperature.
 */

import {
  mapHeartRate,
  mapOxygenSaturation,
  mapSkinTemperature,
} from '@/sensors/health-connect';

const T = '2026-09-15T10:00:00.000Z';
const T_MS = Date.parse(T);

describe('mapHeartRate', () => {
  it('fans every sample of every record out into its own reading', () => {
    const readings = mapHeartRate([
      {
        samples: [
          { time: T, beatsPerMinute: 72 },
          { time: '2026-09-15T10:00:01.000Z', beatsPerMinute: 74 },
        ],
      },
      { samples: [{ time: '2026-09-15T10:00:02.000Z', beatsPerMinute: 75 }] },
    ]);

    expect(readings).toEqual([
      { source: 'health_connect', timestamp: T_MS, hr: 72 },
      { source: 'health_connect', timestamp: T_MS + 1000, hr: 74 },
      { source: 'health_connect', timestamp: T_MS + 2000, hr: 75 },
    ]);
  });

  it('carries no other vital on the reading', () => {
    const [reading] = mapHeartRate([{ samples: [{ time: T, beatsPerMinute: 72 }] }]);
    expect(reading).not.toHaveProperty('spo2');
    expect(reading).not.toHaveProperty('skinTempC');
  });

  it('drops samples whose instant does not parse', () => {
    expect(mapHeartRate([{ samples: [{ time: 'not a date', beatsPerMinute: 72 }] }])).toEqual([]);
  });

  it('drops non-finite values rather than emitting a number the engine would trust', () => {
    expect(mapHeartRate([{ samples: [{ time: T, beatsPerMinute: Number.NaN }] }])).toEqual([]);
  });
});

describe('mapOxygenSaturation', () => {
  it('maps one instantaneous record to one reading', () => {
    expect(mapOxygenSaturation([{ time: T, percentage: 97 }])).toEqual([
      { source: 'health_connect', timestamp: T_MS, spo2: 97 },
    ]);
  });

  it('never substitutes 0 for a missing percentage', () => {
    expect(mapOxygenSaturation([{ time: T, percentage: Number.NaN }])).toEqual([]);
  });
});

describe('mapSkinTemperature', () => {
  it('adds each delta to the baseline when a baseline is present', () => {
    const readings = mapSkinTemperature([
      {
        baseline: { inCelsius: 33.5, inFahrenheit: 92.3 },
        deltas: [
          { time: T, delta: { inCelsius: 0.4, inFahrenheit: 0.72 } },
          { time: '2026-09-15T10:01:00.000Z', delta: { inCelsius: -0.2, inFahrenheit: -0.36 } },
        ],
      },
    ]);

    expect(readings).toHaveLength(2);
    expect(readings[0]).toEqual({ source: 'health_connect', timestamp: T_MS, skinTempC: 33.9 });
    expect(readings[1].skinTempC).toBeCloseTo(33.3, 6);
  });

  it('emits nothing when there is no baseline — a delta alone is not a temperature', () => {
    expect(
      mapSkinTemperature([
        { deltas: [{ time: T, delta: { inCelsius: 0.4, inFahrenheit: 0.72 } }] },
      ]),
    ).toEqual([]);
  });

  it('emits nothing for a record with a baseline and no deltas', () => {
    expect(
      mapSkinTemperature([{ baseline: { inCelsius: 33.5, inFahrenheit: 92.3 }, deltas: [] }]),
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
npx jest src/sensors 2>&1 | tail -6
```

Expected: FAIL — cannot find module `@/sensors/health-connect`.

- [ ] **Step 4: Create `src/sensors/health-connect.ts` with the mappers**

```ts
/**
 * Android Health Connect adapter (PRD §6.4, §7.2.1) — the `HealthConnectAdapter` the PRD
 * names, producing PRD §7.2.1's unified `SensorReading`.
 *
 * ## Two layers in one file
 * The mappers are pure and take *structural* subsets of the library's record results, so they
 * are unit-tested with plain objects and never see a native call. The I/O functions below
 * them are thin: they call the library and hand the records to the mappers. Mirrors
 * `environment/openweather.ts` (mappers) + `environment/service.ts` (fetch) at smaller scale.
 *
 * ## Why every reading carries one vital
 * Health Connect stores heart rate, SpO₂ and skin temperature as separate record types with
 * independent timestamps. Merging them into one reading would mean inventing an alignment,
 * and `risk/types.ts` already says the engine reads `undefined` as "no signal" — so a reading
 * with just `hr` is the honest shape. The vitals row and the baseline module work per field.
 *
 * ## Skin temperature is a delta series
 * `SkinTemperatureRecord` holds `deltas` against an optional `baseline`. Without the baseline
 * there is no absolute skin temperature to report, and a delta of −0.3 is not one, so such a
 * record produces no readings. `BodyTemperature` is deliberately *not* read as a substitute:
 * it is core temperature, and `SensorReading.skinTempC` is documented as skin.
 *
 * ## No plausibility filtering here
 * The engine owns the physiological gate (`thresholds.plausible`). The adapter only refuses
 * values that are not numbers or instants that do not parse — anything numeric goes through,
 * so a genuinely alarming reading is never silenced at the adapter.
 */

import { Platform } from 'react-native';
import {
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  readRecords,
  requestPermission,
  SdkAvailabilityStatus,
  type Permission,
} from 'react-native-health-connect';

import type { SensorReading } from '@/risk';

export const HEALTH_CONNECT_SOURCE = 'health_connect' as const;

// ---------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------

/** Structural subset of `RecordResult<'HeartRate'>` — what the mapper actually reads. */
export type HeartRateInput = {
  readonly samples: readonly { readonly time: string; readonly beatsPerMinute: number }[];
};

/** Structural subset of `RecordResult<'OxygenSaturation'>`. */
export type OxygenSaturationInput = {
  readonly time: string;
  readonly percentage: number;
};

/** Structural subset of `RecordResult<'SkinTemperature'>`. */
export type SkinTemperatureInput = {
  readonly baseline?: { readonly inCelsius: number };
  readonly deltas: readonly {
    readonly time: string;
    readonly delta: { readonly inCelsius: number };
  }[];
};

function parseInstant(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function mapHeartRate(records: readonly HeartRateInput[]): SensorReading[] {
  const out: SensorReading[] = [];
  for (const record of records) {
    for (const sample of record.samples) {
      const timestamp = parseInstant(sample.time);
      if (timestamp === null || !Number.isFinite(sample.beatsPerMinute)) continue;
      out.push({ source: HEALTH_CONNECT_SOURCE, timestamp, hr: sample.beatsPerMinute });
    }
  }
  return out;
}

export function mapOxygenSaturation(records: readonly OxygenSaturationInput[]): SensorReading[] {
  const out: SensorReading[] = [];
  for (const record of records) {
    const timestamp = parseInstant(record.time);
    if (timestamp === null || !Number.isFinite(record.percentage)) continue;
    out.push({ source: HEALTH_CONNECT_SOURCE, timestamp, spo2: record.percentage });
  }
  return out;
}

export function mapSkinTemperature(records: readonly SkinTemperatureInput[]): SensorReading[] {
  const out: SensorReading[] = [];
  for (const record of records) {
    const baseline = record.baseline?.inCelsius;
    if (baseline === undefined || !Number.isFinite(baseline)) continue;
    for (const sample of record.deltas) {
      const timestamp = parseInstant(sample.time);
      const delta = sample.delta.inCelsius;
      if (timestamp === null || !Number.isFinite(delta)) continue;
      out.push({ source: HEALTH_CONNECT_SOURCE, timestamp, skinTempC: baseline + delta });
    }
  }
  return out;
}
```

(The `Platform` and library imports are unused until Task 4; if ESLint's unused-import rule fails the lint step, leave the imports out until Task 4 adds the I/O functions.)

- [ ] **Step 5: Run tests**

```bash
npx jest src/sensors 2>&1 | tail -6 && npx tsc --noEmit
```

Expected: PASS (9 tests); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/sensors/types.ts src/sensors/health-connect.ts src/sensors/__tests__/health-connect.test.ts && git -c core.autocrlf=false commit -m "feat(sensors): Health Connect record mappers and feed types (PRD §7.2.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Health Connect I/O — availability, permissions, reads

**Files:**
- Modify: `src/sensors/health-connect.ts` (append)
- Test: `src/sensors/__tests__/health-connect.test.ts` (append)

**Interfaces:**
- Produces:
  - `VITALS_RECORD_TYPES = ['HeartRate', 'OxygenSaturation', 'SkinTemperature'] as const`, `VitalsRecordType`
  - `checkHealthConnect(): Promise<'available' | 'unavailable' | 'update-required'>`
  - `grantedVitalsPermissions(): Promise<VitalsRecordType[]>`
  - `requestVitalsAccess(): Promise<VitalsRecordType[]>`
  - `readVitals({ sinceMs, untilMs, granted }): Promise<SensorReading[]>` — sorted ascending

- [ ] **Step 1: Write the failing I/O tests**

Append to `src/sensors/__tests__/health-connect.test.ts`:

```ts
import { Platform } from 'react-native';
import {
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  readRecords,
  requestPermission,
} from 'react-native-health-connect';

import {
  checkHealthConnect,
  grantedVitalsPermissions,
  readVitals,
  requestVitalsAccess,
  VITALS_PERMISSIONS,
} from '@/sensors/health-connect';

const sdkStatus = jest.mocked(getSdkStatus);
const init = jest.mocked(initialize);
const granted = jest.mocked(getGrantedPermissions);
const request = jest.mocked(requestPermission);
const read = jest.mocked(readRecords);

beforeEach(() => {
  sdkStatus.mockReset().mockResolvedValue(3);
  init.mockReset().mockResolvedValue(true);
  granted.mockReset().mockResolvedValue([]);
  request.mockReset().mockResolvedValue([]);
  read.mockReset().mockResolvedValue({ records: [] });
});

describe('checkHealthConnect', () => {
  it('is available only when the SDK reports available and initialises', async () => {
    await expect(checkHealthConnect()).resolves.toBe('available');
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('reports update-required distinctly, so the notice can say what to do', async () => {
    sdkStatus.mockResolvedValue(2);
    await expect(checkHealthConnect()).resolves.toBe('update-required');
    expect(init).not.toHaveBeenCalled();
  });

  it('is unavailable when the SDK is absent', async () => {
    sdkStatus.mockResolvedValue(1);
    await expect(checkHealthConnect()).resolves.toBe('unavailable');
  });

  it('is unavailable when initialise fails even though the SDK is present', async () => {
    init.mockResolvedValue(false);
    await expect(checkHealthConnect()).resolves.toBe('unavailable');
  });

  it('never calls the native module off Android', async () => {
    const os = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    try {
      await expect(checkHealthConnect()).resolves.toBe('unavailable');
      expect(sdkStatus).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    }
  });
});

describe('permissions', () => {
  it('asks for read access to exactly the three vitals record types', async () => {
    await requestVitalsAccess();
    expect(request).toHaveBeenCalledWith([
      { accessType: 'read', recordType: 'HeartRate' },
      { accessType: 'read', recordType: 'OxygenSaturation' },
      { accessType: 'read', recordType: 'SkinTemperature' },
    ]);
    expect(VITALS_PERMISSIONS).toHaveLength(3);
  });

  it('reports only the vitals read permissions that were granted, ignoring unrelated grants', async () => {
    granted.mockResolvedValue([
      { accessType: 'read', recordType: 'HeartRate' },
      { accessType: 'write', recordType: 'OxygenSaturation' },
      { accessType: 'read', recordType: 'Steps' },
    ]);
    await expect(grantedVitalsPermissions()).resolves.toEqual(['HeartRate']);
  });

  it('returns the post-dialog grant set from requestVitalsAccess', async () => {
    request.mockResolvedValue([{ accessType: 'read', recordType: 'OxygenSaturation' }]);
    await expect(requestVitalsAccess()).resolves.toEqual(['OxygenSaturation']);
  });
});

describe('readVitals', () => {
  const SINCE = Date.parse('2026-09-15T09:42:00.000Z');
  const UNTIL = Date.parse('2026-09-15T10:00:00.000Z');

  it('reads only the granted record types, over the requested range, ascending', async () => {
    await readVitals({ sinceMs: SINCE, untilMs: UNTIL, granted: ['HeartRate', 'SkinTemperature'] });

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith('HeartRate', {
      timeRangeFilter: {
        operator: 'between',
        startTime: '2026-09-15T09:42:00.000Z',
        endTime: '2026-09-15T10:00:00.000Z',
      },
      ascendingOrder: true,
    });
    expect(read).toHaveBeenCalledWith('SkinTemperature', expect.anything());
    expect(read).not.toHaveBeenCalledWith('OxygenSaturation', expect.anything());
  });

  it('reads nothing when nothing is granted', async () => {
    await expect(readVitals({ sinceMs: SINCE, untilMs: UNTIL, granted: [] })).resolves.toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('merges every record type into one ascending list', async () => {
    read.mockImplementation((recordType) => {
      if (recordType === 'HeartRate') {
        return Promise.resolve({
          records: [
            {
              samples: [{ time: '2026-09-15T09:59:30.000Z', beatsPerMinute: 80 }],
            },
          ],
        } as never);
      }
      if (recordType === 'OxygenSaturation') {
        return Promise.resolve({
          records: [{ time: '2026-09-15T09:59:00.000Z', percentage: 96 }],
        } as never);
      }
      return Promise.resolve({ records: [] } as never);
    });

    const readings = await readVitals({
      sinceMs: SINCE,
      untilMs: UNTIL,
      granted: ['HeartRate', 'OxygenSaturation', 'SkinTemperature'],
    });

    expect(readings.map((r) => [r.timestamp, r.hr, r.spo2])).toEqual([
      [Date.parse('2026-09-15T09:59:00.000Z'), undefined, 96],
      [Date.parse('2026-09-15T09:59:30.000Z'), 80, undefined],
    ]);
  });

  it('propagates a read failure so the hook can report it', async () => {
    read.mockRejectedValue(new Error('boom'));
    await expect(
      readVitals({ sinceMs: SINCE, untilMs: UNTIL, granted: ['HeartRate'] }),
    ).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest src/sensors 2>&1 | tail -6
```

Expected: FAIL — `checkHealthConnect` etc. are not exported.

- [ ] **Step 3: Append the I/O layer to `src/sensors/health-connect.ts`**

```ts
// ---------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------

export const VITALS_RECORD_TYPES = ['HeartRate', 'OxygenSaturation', 'SkinTemperature'] as const;
export type VitalsRecordType = (typeof VITALS_RECORD_TYPES)[number];

/** Read-only, and only these three — PRD §7.2.6 data minimisation. */
export const VITALS_PERMISSIONS: readonly Permission[] = VITALS_RECORD_TYPES.map(
  (recordType): Permission => ({ accessType: 'read', recordType }),
);

export type HealthConnectAvailability = 'available' | 'unavailable' | 'update-required';

/**
 * Whether Health Connect can be used at all. Guards on the platform *before* touching the
 * module: on iOS the native side is absent and any call throws.
 */
export async function checkHealthConnect(): Promise<HealthConnectAvailability> {
  if (Platform.OS !== 'android') return 'unavailable';
  const status = await getSdkStatus();
  if (status === SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
    return 'update-required';
  }
  if (status !== SdkAvailabilityStatus.SDK_AVAILABLE) return 'unavailable';
  return (await initialize()) ? 'available' : 'unavailable';
}

function grantedVitals(
  permissions: readonly { readonly accessType: string; readonly recordType: string }[],
): VitalsRecordType[] {
  return VITALS_RECORD_TYPES.filter((recordType) =>
    permissions.some((p) => p.accessType === 'read' && p.recordType === recordType),
  );
}

/** Silent — reads the current grant state without a dialog. */
export async function grantedVitalsPermissions(): Promise<VitalsRecordType[]> {
  return grantedVitals(await getGrantedPermissions());
}

/** Raises the Health Connect permission dialog. User-initiated paths only. */
export async function requestVitalsAccess(): Promise<VitalsRecordType[]> {
  return grantedVitals(await requestPermission([...VITALS_PERMISSIONS]));
}

export type ReadVitalsOptions = {
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly granted: readonly VitalsRecordType[];
};

/**
 * Every granted vital in `(sinceMs, untilMs]`, as readings, ascending.
 *
 * Not paginated: `readRecords` pages by *record*, a record holds many samples, and the widest
 * range this is ever asked for is the engine's lookback (~20 min) — far inside a page.
 */
export async function readVitals({ sinceMs, untilMs, granted }: ReadVitalsOptions): Promise<SensorReading[]> {
  if (granted.length === 0) return [];

  const timeRangeFilter = {
    operator: 'between' as const,
    startTime: new Date(sinceMs).toISOString(),
    endTime: new Date(untilMs).toISOString(),
  };
  const options = { timeRangeFilter, ascendingOrder: true };

  const [heartRate, oxygen, skin] = await Promise.all([
    granted.includes('HeartRate') ? readRecords('HeartRate', options) : null,
    granted.includes('OxygenSaturation') ? readRecords('OxygenSaturation', options) : null,
    granted.includes('SkinTemperature') ? readRecords('SkinTemperature', options) : null,
  ]);

  return [
    ...mapHeartRate(heartRate?.records ?? []),
    ...mapOxygenSaturation(oxygen?.records ?? []),
    ...mapSkinTemperature(skin?.records ?? []),
  ].sort((a, b) => a.timestamp - b.timestamp);
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest src/sensors 2>&1 | tail -6 && npx tsc --noEmit
```

Expected: PASS; tsc clean. If tsc complains that the library's `RecordResult<'SkinTemperature'>` is not assignable to `SkinTemperatureInput` because `baseline` is `TemperatureResult | undefined`, the structural type already matches (`{ inCelsius: number }`); if it complains about `readonly`, drop `readonly` from the *Input* array element types.

- [ ] **Step 5: Commit**

```bash
git add src/sensors/health-connect.ts src/sensors/__tests__/health-connect.test.ts && git -c core.autocrlf=false commit -m "feat(sensors): Health Connect availability, permission and read I/O

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Accelerometer fold

**Files:**
- Create: `src/sensors/motion.ts`
- Test: `src/sensors/__tests__/motion.test.ts`

**Interfaces:**
- Produces:
  - `MOTION_SAMPLE_INTERVAL_MS = 40`
  - `createAccumulator(): MotionAccumulator`, `accumulate(acc, { x, y, z })`, `summarize(acc): MotionSummary | null`
  - `isMotionAvailable(): Promise<boolean>`
  - `startMotionFold(): MotionFold` where `MotionFold = { flush(): MotionSummary | null; stop(): void }`

- [ ] **Step 1: Write the failing tests**

Create `src/sensors/__tests__/motion.test.ts`:

```ts
/**
 * Accelerometer → `MotionSummary`.
 *
 * `risk/types.ts` fixes the unit as g with gravity included, so a phone lying on a table must
 * summarise to ≈ 1.0 across peak, min and rms — that is the invariant the stillness rules
 * lean on (`fall.restBandG`), and it is checked first. The second thing worth pinning is the
 * difference between "no samples" and "still": an empty interval must be `null`, because a
 * `{ peakG: 0, … sampleCount: 0 }` would read to the engine as a person in free fall.
 */

import { Accelerometer } from 'expo-sensors';

import {
  accumulate,
  createAccumulator,
  isMotionAvailable,
  MOTION_SAMPLE_INTERVAL_MS,
  startMotionFold,
  summarize,
} from '@/sensors/motion';

const available = jest.mocked(Accelerometer.isAvailableAsync);
const setInterval_ = jest.mocked(Accelerometer.setUpdateInterval);
const addListener = jest.mocked(Accelerometer.addListener);

beforeEach(() => {
  available.mockReset().mockResolvedValue(true);
  setInterval_.mockReset();
  addListener.mockReset();
});

describe('accumulator', () => {
  it('summarises a device at rest as ≈ 1.0 g on every statistic', () => {
    const acc = createAccumulator();
    for (let i = 0; i < 50; i += 1) accumulate(acc, { x: 0.01, y: -0.02, z: 0.9995 });
    const summary = summarize(acc);
    expect(summary).not.toBeNull();
    expect(summary?.peakG).toBeCloseTo(1.0, 2);
    expect(summary?.minG).toBeCloseTo(1.0, 2);
    expect(summary?.rmsG).toBeCloseTo(1.0, 2);
    expect(summary?.sampleCount).toBe(50);
  });

  it('records the impact peak and the free-fall minimum of a fall', () => {
    const acc = createAccumulator();
    accumulate(acc, { x: 0, y: 0, z: 1 });
    accumulate(acc, { x: 0, y: 0, z: 0.3 }); // near-weightless
    accumulate(acc, { x: 3, y: 0, z: 0 }); // impact
    accumulate(acc, { x: 0, y: 0, z: 1 });
    const summary = summarize(acc);
    expect(summary?.peakG).toBeCloseTo(3, 6);
    expect(summary?.minG).toBeCloseTo(0.3, 6);
    expect(summary?.sampleCount).toBe(4);
  });

  it('returns null, not zeros, for an empty interval', () => {
    expect(summarize(createAccumulator())).toBeNull();
  });

  it('ignores non-finite samples', () => {
    const acc = createAccumulator();
    accumulate(acc, { x: Number.NaN, y: 0, z: 1 });
    expect(summarize(acc)).toBeNull();
  });
});

describe('startMotionFold', () => {
  it('subscribes at ~25 Hz and folds delivered samples until flushed', () => {
    let listener: ((m: { x: number; y: number; z: number; timestamp: number }) => void) | null =
      null;
    const remove = jest.fn();
    addListener.mockImplementation((fn) => {
      listener = fn;
      return { remove };
    });

    const fold = startMotionFold();
    expect(setInterval_).toHaveBeenCalledWith(MOTION_SAMPLE_INTERVAL_MS);
    expect(listener).not.toBeNull();

    listener?.({ x: 0, y: 0, z: 1, timestamp: 0 });
    listener?.({ x: 0, y: 0, z: 1.5, timestamp: 0.04 });

    expect(fold.flush()).toEqual({
      peakG: 1.5,
      minG: 1,
      rmsG: Math.sqrt((1 + 2.25) / 2),
      sampleCount: 2,
    });
    // Flushing resets, so the next interval starts empty.
    expect(fold.flush()).toBeNull();

    fold.stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('isMotionAvailable', () => {
  it('reflects the sensor availability check', async () => {
    available.mockResolvedValue(false);
    await expect(isMotionAvailable()).resolves.toBe(false);
  });

  it('treats a throwing availability check as unavailable', async () => {
    available.mockRejectedValue(new Error('no sensor service'));
    await expect(isMotionAvailable()).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest src/sensors/__tests__/motion.test.ts 2>&1 | tail -6
```

Expected: FAIL — cannot find module `@/sensors/motion`.

- [ ] **Step 3: Create `src/sensors/motion.ts`**

```ts
/**
 * Phone accelerometer → `MotionSummary` (PRD §7.2.2 fall detection input).
 *
 * ## Why a fold and not a stream of `MotionVector`s
 * `risk/types.ts` explains the sampling-rate mismatch: the vitals poll is once a minute and
 * a fall impact lasts ~200 ms, so a once-a-minute vector would essentially never land on
 * it. The accelerometer is therefore sampled continuously at ~25 Hz and *folded* — peak,
 * min, rms, count — into one summary per poll interval, which the hook attaches to a reading
 * stamped at the poll instant. The engine stays a pure function of the window.
 *
 * ## Units
 * expo-sensors reports g with gravity included, the unit `MotionSummary` documents, so no
 * conversion happens here. A device at rest folds to ≈ 1.0 on every statistic.
 *
 * ## `null` means "no samples", not "still"
 * `sampleCount: 0` alongside `peakG: 0` would read as free fall. An empty interval returns
 * `null` and the hook then emits no motion for that tick, which the engine reports honestly
 * as "movement is not being monitored".
 */

import { Accelerometer } from 'expo-sensors';

import type { MotionSummary } from '@/risk';

/** 25 Hz. Well above the ~5 Hz needed to catch a 200 ms impact, cheap enough to leave on. */
export const MOTION_SAMPLE_INTERVAL_MS = 40;

export type MotionSample = { readonly x: number; readonly y: number; readonly z: number };

export type MotionAccumulator = {
  peakG: number;
  minG: number;
  sumSquares: number;
  count: number;
};

export function createAccumulator(): MotionAccumulator {
  return { peakG: 0, minG: Number.POSITIVE_INFINITY, sumSquares: 0, count: 0 };
}

export function accumulate(acc: MotionAccumulator, sample: MotionSample): void {
  const magnitude = Math.hypot(sample.x, sample.y, sample.z);
  if (!Number.isFinite(magnitude)) return;
  acc.peakG = Math.max(acc.peakG, magnitude);
  acc.minG = Math.min(acc.minG, magnitude);
  acc.sumSquares += magnitude * magnitude;
  acc.count += 1;
}

export function summarize(acc: MotionAccumulator): MotionSummary | null {
  if (acc.count === 0) return null;
  return {
    peakG: acc.peakG,
    minG: acc.minG,
    rmsG: Math.sqrt(acc.sumSquares / acc.count),
    sampleCount: acc.count,
  };
}

export type MotionFold = {
  /** The summary since the last flush (or start), then reset. `null` if nothing arrived. */
  readonly flush: () => MotionSummary | null;
  readonly stop: () => void;
};

export async function isMotionAvailable(): Promise<boolean> {
  try {
    return await Accelerometer.isAvailableAsync();
  } catch {
    return false;
  }
}

export function startMotionFold(): MotionFold {
  let acc = createAccumulator();
  Accelerometer.setUpdateInterval(MOTION_SAMPLE_INTERVAL_MS);
  const subscription = Accelerometer.addListener((sample) => accumulate(acc, sample));

  return {
    flush() {
      const summary = summarize(acc);
      acc = createAccumulator();
      return summary;
    },
    stop() {
      subscription.remove();
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest src/sensors 2>&1 | tail -6 && npx tsc --noEmit
```

Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/sensors/motion.ts src/sensors/__tests__/motion.test.ts && git -c core.autocrlf=false commit -m "feat(sensors): fold the phone accelerometer into MotionSummary per poll interval

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Ring buffer merge

**Files:**
- Create: `src/sensors/ring-buffer.ts`
- Test: `src/sensors/__tests__/ring-buffer.test.ts`

**Interfaces:**
- Produces: `mergeReadings(buffer: readonly SensorReading[], incoming: readonly SensorReading[], { now, retainMs }): SensorReading[]` — ascending, deduplicated, trimmed to `[now − retainMs, ∞)`.

- [ ] **Step 1: Write the failing tests**

Create `src/sensors/__tests__/ring-buffer.test.ts`:

```ts
/**
 * The live feed's ring buffer.
 *
 * Two boundaries are pinned exactly. The trim cutoff is inclusive at `now − retainMs`,
 * because the hook sizes `retainMs` from the engine's own `longestLookbackMs` plus headroom
 * and an off-by-one here would be an off-by-one in the safety rules' lookback. And re-reading
 * an overlapping Health Connect range must not double-count a sample — the tachycardia rule
 * counts sustained samples, and duplicates would let one reading satisfy it twice.
 */

import { mergeReadings } from '@/sensors/ring-buffer';
import type { SensorReading } from '@/risk';

const NOW = 1_766_000_000_000;
const MIN = 60_000;

function hr(offsetMs: number, bpm: number): SensorReading {
  return { source: 'health_connect', timestamp: NOW + offsetMs, hr: bpm };
}

describe('mergeReadings', () => {
  it('appends, sorts ascending, and keeps the order stable at equal timestamps', () => {
    const motion: SensorReading = {
      source: 'health_connect',
      timestamp: NOW,
      motionSummary: { peakG: 1, minG: 1, rmsG: 1, sampleCount: 10 },
    };
    const out = mergeReadings([hr(-2 * MIN, 70)], [hr(0, 72), hr(-MIN, 71), motion], {
      now: NOW,
      retainMs: 10 * MIN,
    });
    expect(out.map((r) => r.timestamp - NOW)).toEqual([-2 * MIN, -MIN, 0, 0]);
    // The motion reading was appended last at its timestamp and must stay last: the fall rule
    // reads stillness from the newest reading.
    expect(out[3].motionSummary).toBeDefined();
  });

  it('drops a reading exactly older than the retention window and keeps one exactly at it', () => {
    const out = mergeReadings([], [hr(-10 * MIN - 1, 60), hr(-10 * MIN, 61)], {
      now: NOW,
      retainMs: 10 * MIN,
    });
    expect(out.map((r) => r.hr)).toEqual([61]);
  });

  it('trims readings already in the buffer, not only incoming ones', () => {
    const out = mergeReadings([hr(-30 * MIN, 60)], [], { now: NOW, retainMs: 10 * MIN });
    expect(out).toEqual([]);
  });

  it('deduplicates a sample that an overlapping re-read returned again', () => {
    const once = mergeReadings([], [hr(-MIN, 70)], { now: NOW, retainMs: 10 * MIN });
    const twice = mergeReadings(once, [hr(-MIN, 70)], { now: NOW, retainMs: 10 * MIN });
    expect(twice).toHaveLength(1);
  });

  it('keeps distinct vitals at the same instant as distinct readings', () => {
    const spo2: SensorReading = { source: 'health_connect', timestamp: NOW - MIN, spo2: 97 };
    const out = mergeReadings([], [hr(-MIN, 70), spo2], { now: NOW, retainMs: 10 * MIN });
    expect(out).toHaveLength(2);
  });

  it('does not mutate its inputs', () => {
    const buffer = [hr(-MIN, 70)];
    const incoming = [hr(0, 72)];
    mergeReadings(buffer, incoming, { now: NOW, retainMs: 10 * MIN });
    expect(buffer).toHaveLength(1);
    expect(incoming).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest src/sensors/__tests__/ring-buffer.test.ts 2>&1 | tail -6
```

Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/sensors/ring-buffer.ts`**

```ts
/**
 * The live feed's rolling buffer, as a pure merge (PRD §7.2.1).
 *
 * The engine takes "a longer buffer" and slices its own windows, so the buffer's only jobs
 * are: keep readings ascending, never hold the same sample twice, and never drop one the
 * engine could still need. Retention is a parameter rather than a constant here because the
 * hook derives it from `longestLookbackMs` — this module must not know what the engine's
 * lookback is, only respect the number it is given.
 *
 * Deduplication keys on the instant plus *which* vitals the reading carries, not on value.
 * Health Connect re-reads over an overlapping range return the same sample with the same
 * value, so first-wins is correct; and two readings at one instant carrying different vitals
 * (an HR sample and an SpO₂ record) are legitimately distinct.
 */

import type { SensorReading } from '@/risk';

export type MergeOptions = {
  readonly now: number;
  /** Readings older than `now − retainMs` are dropped. Inclusive at the boundary. */
  readonly retainMs: number;
};

function identity(reading: SensorReading): string {
  return [
    reading.timestamp,
    reading.source,
    reading.hr !== undefined ? 'h' : '',
    reading.spo2 !== undefined ? 's' : '',
    reading.skinTempC !== undefined ? 't' : '',
    reading.motionSummary !== undefined || reading.motion !== undefined ? 'm' : '',
  ].join('|');
}

export function mergeReadings(
  buffer: readonly SensorReading[],
  incoming: readonly SensorReading[],
  { now, retainMs }: MergeOptions,
): SensorReading[] {
  const cutoff = now - retainMs;
  const seen = new Set<string>();
  const merged: SensorReading[] = [];

  for (const reading of [...buffer, ...incoming]) {
    if (reading.timestamp < cutoff) continue;
    const key = identity(reading);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(reading);
  }

  // `Array.prototype.sort` is stable, so equal-timestamp readings keep insertion order — the
  // hook relies on that to keep its motion reading newest at the poll instant.
  return merged.sort((a, b) => a.timestamp - b.timestamp);
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest src/sensors 2>&1 | tail -6 && npx tsc --noEmit
```

Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/sensors/ring-buffer.ts src/sensors/__tests__/ring-buffer.test.ts && git -c core.autocrlf=false commit -m "feat(sensors): pure ring-buffer merge with dedupe and lookback trim

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The polling hook

**Files:**
- Create: `src/hooks/use-sensors.ts`
- Test: `src/hooks/__tests__/use-sensors.test.ts`

**Interfaces:**
- Consumes: Task 2 `longestLookbackMs`, `resolveRiskThresholds` from `@/risk`; Task 4 `checkHealthConnect`, `grantedVitalsPermissions`, `requestVitalsAccess`, `readVitals`, `HEALTH_CONNECT_SOURCE`, `VitalsRecordType`; Task 5 `isMotionAvailable`, `startMotionFold`, `MotionFold`; Task 6 `mergeReadings`; Task 3 `SensorFeed`, `SensorFeedStatus`, `SensorFailure`.
- Produces: `POLL_INTERVAL_MS = 60_000`, `BUFFER_RETAIN_MS`, `useSensors({ enabled }: { enabled: boolean }): SensorFeed`.

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/__tests__/use-sensors.test.ts`:

```ts
/**
 * Live sensor feed tests.
 *
 * As with `use-environment.test.ts`, most of what matters is invisible on the happy path:
 *
 * 1. **Disabled means silent.** With the picker on "simulated" the hook must make no native
 *    call at all — a stray `getSdkStatus` on a phone without Health Connect is a crash.
 * 2. **Which paths may prompt.** Only `requestAccess` calls `requestVitalsAccess`. The
 *    interval and the foreground catch-up never do.
 * 3. **The warm-up range.** The first poll reads back the engine's full lookback so the
 *    extended rules see history immediately; later polls read from the last poll.
 * 4. **Foreground catch-up at its boundary.** `>=` pinned on both sides.
 * 5. **Nothing after unmount.** A poll that resolves after the provider is gone must not touch
 *    state.
 */

import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { longestLookbackMs, resolveRiskThresholds, type SensorReading } from '@/risk';
import {
  checkHealthConnect,
  grantedVitalsPermissions,
  readVitals,
  requestVitalsAccess,
} from '@/sensors/health-connect';
import { isMotionAvailable, startMotionFold, type MotionFold } from '@/sensors/motion';
import { BUFFER_RETAIN_MS, POLL_INTERVAL_MS, useSensors } from '@/hooks/use-sensors';

jest.mock('@/sensors/health-connect', () => ({
  ...jest.requireActual('@/sensors/health-connect'),
  checkHealthConnect: jest.fn(),
  grantedVitalsPermissions: jest.fn(),
  requestVitalsAccess: jest.fn(),
  readVitals: jest.fn(),
}));

jest.mock('@/sensors/motion', () => ({
  ...jest.requireActual('@/sensors/motion'),
  isMotionAvailable: jest.fn(),
  startMotionFold: jest.fn(),
}));

const check = jest.mocked(checkHealthConnect);
const granted = jest.mocked(grantedVitalsPermissions);
const request = jest.mocked(requestVitalsAccess);
const read = jest.mocked(readVitals);
const motionAvailable = jest.mocked(isMotionAvailable);
const startFold = jest.mocked(startMotionFold);

const NOW = 1_766_000_000_000;
const STILL = { peakG: 1.02, minG: 0.98, rmsG: 1.0, sampleCount: 1500 };

let appStateHandlers: ((status: AppStateStatus) => void)[] = [];
let fold: { flush: jest.Mock; stop: jest.Mock };

function hrAt(timestamp: number, bpm: number): SensorReading {
  return { source: 'health_connect', timestamp, hr: bpm };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function emitAppState(status: AppStateStatus) {
  await act(async () => {
    for (const handler of appStateHandlers) handler(status);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);

  appStateHandlers = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    appStateHandlers.push(handler as (status: AppStateStatus) => void);
    return { remove: jest.fn() } as never;
  });

  fold = { flush: jest.fn(() => STILL), stop: jest.fn() };
  check.mockReset().mockResolvedValue('available');
  granted.mockReset().mockResolvedValue(['HeartRate', 'OxygenSaturation', 'SkinTemperature']);
  request.mockReset().mockResolvedValue([]);
  read.mockReset().mockResolvedValue([]);
  motionAvailable.mockReset().mockResolvedValue(true);
  startFold.mockReset().mockReturnValue(fold as unknown as MotionFold);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('constants', () => {
  it('retains at least the engine lookback plus two poll intervals of headroom', () => {
    expect(BUFFER_RETAIN_MS).toBe(
      longestLookbackMs(resolveRiskThresholds()) + 2 * POLL_INTERVAL_MS,
    );
  });
});

describe('disabled', () => {
  it('is idle and never touches a native module', async () => {
    const { result } = renderHook(() => useSensors({ enabled: false }));
    await settle();
    expect(result.current.status).toBe('idle');
    expect(result.current.readings).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    expect(startFold).not.toHaveBeenCalled();
  });
});

describe('availability and permissions', () => {
  it('reports unavailable with a reason and does not poll', async () => {
    check.mockResolvedValue('unavailable');
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(result.current.status).toBe('unavailable');
    expect(result.current.failure?.kind).toBe('sdk');
    expect(read).not.toHaveBeenCalled();
  });

  it('names an update requirement distinctly', async () => {
    check.mockResolvedValue('update-required');
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(result.current.status).toBe('unavailable');
    expect(result.current.failure?.message).toMatch(/update/i);
  });

  it('stops at permission-required without prompting when nothing is granted', async () => {
    granted.mockResolvedValue([]);
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(result.current.status).toBe('permission-required');
    expect(request).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('requestAccess prompts, then starts polling on a grant', async () => {
    granted.mockResolvedValue([]);
    request.mockResolvedValue(['HeartRate']);
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();

    act(() => result.current.requestAccess());
    await settle();

    expect(request).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({
      sinceMs: NOW - BUFFER_RETAIN_MS,
      untilMs: NOW,
      granted: ['HeartRate'],
    });
    expect(result.current.status).toBe('live');
  });

  it('stays at permission-required when the dialog grants nothing', async () => {
    granted.mockResolvedValue([]);
    request.mockResolvedValue([]);
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();
    act(() => result.current.requestAccess());
    await settle();
    expect(result.current.status).toBe('permission-required');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('polling', () => {
  it('warms up over the full lookback, then attaches the motion summary at the poll instant', async () => {
    read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();

    expect(read).toHaveBeenCalledWith({
      sinceMs: NOW - BUFFER_RETAIN_MS,
      untilMs: NOW,
      granted: ['HeartRate', 'OxygenSaturation', 'SkinTemperature'],
    });
    expect(startFold).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('live');
    expect(result.current.lastPolledAt).toBe(NOW);
    expect(result.current.readings).toEqual([
      hrAt(NOW - 30_000, 72),
      { source: 'health_connect', timestamp: NOW, motionSummary: STILL },
    ]);
  });

  it('emits a motion-only reading when Health Connect returned nothing', async () => {
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(result.current.readings).toEqual([
      { source: 'health_connect', timestamp: NOW, motionSummary: STILL },
    ]);
  });

  it('omits motion when the accelerometer is unavailable', async () => {
    motionAvailable.mockResolvedValue(false);
    read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(startFold).not.toHaveBeenCalled();
    expect(result.current.readings).toEqual([hrAt(NOW - 30_000, 72)]);
  });

  it('polls every interval from the previous poll instant and never prompts', async () => {
    renderHook(() => useSensors({ enabled: true }));
    await settle();
    read.mockClear();

    await advance(POLL_INTERVAL_MS);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({
      sinceMs: NOW,
      untilMs: NOW + POLL_INTERVAL_MS,
      granted: ['HeartRate', 'OxygenSaturation', 'SkinTemperature'],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the buffer and reports a read failure', async () => {
    read.mockResolvedValueOnce([hrAt(NOW - 30_000, 72)]);
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();

    read.mockRejectedValueOnce(new Error('Health Connect busy'));
    await advance(POLL_INTERVAL_MS);

    expect(result.current.status).toBe('error');
    expect(result.current.failure).toEqual({ kind: 'read', message: 'Health Connect busy' });
    expect(result.current.readings.some((r) => r.hr === 72)).toBe(true);
    // The failed range is not marked as polled, so the next tick re-reads it.
    expect(result.current.lastPolledAt).toBe(NOW);
  });

  it('still emits the motion reading on a failed vitals read, so fall detection survives a flaky band', async () => {
    const { result } = renderHook(() => useSensors({ enabled: true }));
    await settle();
    read.mockRejectedValueOnce(new Error('busy'));
    await advance(POLL_INTERVAL_MS);
    expect(
      result.current.readings.filter((r) => r.motionSummary !== undefined).map((r) => r.timestamp),
    ).toEqual([NOW, NOW + POLL_INTERVAL_MS]);
  });
});

describe('foreground catch-up', () => {
  it('does not poll when the app returns before an interval has elapsed', async () => {
    renderHook(() => useSensors({ enabled: true }));
    await settle();
    read.mockClear();

    jest.setSystemTime(NOW + POLL_INTERVAL_MS - 1);
    await emitAppState('active');

    expect(read).not.toHaveBeenCalled();
  });

  it('polls immediately when the app returns after an interval has elapsed', async () => {
    renderHook(() => useSensors({ enabled: true }));
    await settle();
    read.mockClear();

    jest.setSystemTime(NOW + POLL_INTERVAL_MS);
    await emitAppState('active');
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('ignores non-active transitions', async () => {
    renderHook(() => useSensors({ enabled: true }));
    await settle();
    read.mockClear();
    jest.setSystemTime(NOW + 2 * POLL_INTERVAL_MS);
    await emitAppState('background');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('stops the fold and clears the buffer when disabled', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useSensors({ enabled }), {
      initialProps: { enabled: true },
    });
    await settle();
    expect(result.current.status).toBe('live');

    rerender({ enabled: false });
    await settle();

    expect(fold.stop).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.readings).toEqual([]);
  });

  it('ignores a poll that resolves after unmount', async () => {
    const pending = deferred<SensorReading[]>();
    read.mockReturnValue(pending.promise);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(result.current.status).toBe('loading');

    unmount();
    await act(async () => {
      pending.resolve([hrAt(NOW - 1000, 70)]);
      await Promise.resolve();
    });

    expect(fold.stop).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest src/hooks/__tests__/use-sensors.test.ts 2>&1 | tail -6
```

Expected: FAIL — cannot find module `@/hooks/use-sensors`.

- [ ] **Step 3: Create `src/hooks/use-sensors.ts`**

```ts
/**
 * The live sensor feed as React state: Health Connect vitals plus the folded phone
 * accelerometer, polled every minute into a ring buffer sized from the engine's own lookback
 * (PRD §7.2.1).
 *
 * ## Same discipline as `use-environment.ts`
 * A `mounted` ref guards every `setState` after an `await`; the `AppState` listener closes the
 * gap React Native's suspended timers leave when the app is backgrounded; and the only path
 * allowed to raise a permission dialog is the user-initiated `requestAccess`. The reasons are
 * spelled out there and are not repeated here.
 *
 * ## Why there is no cache-first path
 * The environment feed paints a cached observation before fetching because a two-hour-old
 * temperature is still useful. A two-hour-old heart rate is not: the engine would score it
 * `stale` and decline to judge, so there is nothing true to show before the first poll. The
 * Dashboard says "waiting" instead (`SensorFeedNotice`).
 *
 * ## Generation counter, not AbortController
 * `readRecords` cannot be aborted. Each (re)start bumps `generation`, and any async step
 * whose captured generation no longer matches simply returns — the same "a newer request
 * supersedes an older one" rule the environment hook expresses with `abort()`.
 *
 * ## The motion reading is stamped at the poll instant and appended last
 * `rules/fall.ts` reads the trailing still run from the *newest* reading. Health Connect
 * samples are all `≤ now` (the read range ends at `now`), so a motion reading at exactly
 * `now`, appended after the vitals, is always newest — `mergeReadings` keeps insertion order
 * at equal timestamps for this reason.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { longestLookbackMs, resolveRiskThresholds, type SensorReading } from '@/risk';
import {
  checkHealthConnect,
  grantedVitalsPermissions,
  HEALTH_CONNECT_SOURCE,
  readVitals,
  requestVitalsAccess,
  type VitalsRecordType,
} from '@/sensors/health-connect';
import { isMotionAvailable, startMotionFold, type MotionFold } from '@/sensors/motion';
import { mergeReadings } from '@/sensors/ring-buffer';
import type { SensorFailure, SensorFailureKind, SensorFeed, SensorFeedStatus } from '@/sensors/types';

/**
 * PRD §7.2.1: "polling every 30–60 s for Health Connect". The upper end, because the engine's
 * duration rules were tuned and tested at 60 s (`mock-sensor-window.ts` documents the boundary
 * a faster cadence would move).
 */
export const POLL_INTERVAL_MS = 60 * 1000;

/**
 * `RiskAssessmentInput.readings` requires the buffer to span the engine's longest lookback.
 * Two intervals of headroom cover a poll that lands late plus the half-open window epsilon.
 */
export const BUFFER_RETAIN_MS = longestLookbackMs(resolveRiskThresholds()) + 2 * POLL_INTERVAL_MS;

export type UseSensorsOptions = {
  /** False when Settings has a source other than Health Connect selected. No native calls. */
  readonly enabled: boolean;
};

function describeFailure(error: unknown, kind: SensorFailureKind): SensorFailure {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'Could not read from Health Connect.';
  return { message, kind };
}

export function useSensors({ enabled }: UseSensorsOptions): SensorFeed {
  const [readings, setReadings] = useState<readonly SensorReading[]>([]);
  const [status, setStatus] = useState<SensorFeedStatus>('idle');
  const [failure, setFailure] = useState<SensorFailure | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);

  const mounted = useRef(true);
  const generation = useRef(0);
  /** Set once `checkHealthConnect` said available; `requestAccess` is a no-op before that. */
  const ready = useRef(false);
  /** Set once permissions exist; the interval and AppState paths poll only while true. */
  const active = useRef(false);
  const polling = useRef(false);
  const granted = useRef<readonly VitalsRecordType[]>([]);
  const fold = useRef<MotionFold | null>(null);
  /** Mirrors `lastPolledAt` for the AppState check, which must not re-subscribe on change. */
  const lastPolledRef = useRef<number | null>(null);

  const isCurrent = useCallback((gen: number) => mounted.current && gen === generation.current, []);

  const poll = useCallback(async () => {
    if (!active.current || polling.current) return;
    const gen = generation.current;
    polling.current = true;

    const now = Date.now();
    const since = Math.max(lastPolledRef.current ?? Number.NEGATIVE_INFINITY, now - BUFFER_RETAIN_MS);

    // Flushed before the await so the summary spans exactly this interval, and emitted even if
    // the vitals read fails — a flaky band must not blind fall detection.
    const motion = fold.current?.flush() ?? null;
    const motionReading: SensorReading | null =
      motion === null ? null : { source: HEALTH_CONNECT_SOURCE, timestamp: now, motionSummary: motion };

    try {
      const vitals = await readVitals({ sinceMs: since, untilMs: now, granted: granted.current });
      if (!isCurrent(gen)) return;
      const incoming = motionReading === null ? vitals : [...vitals, motionReading];
      lastPolledRef.current = now;
      setLastPolledAt(now);
      setReadings((prev) => mergeReadings(prev, incoming, { now, retainMs: BUFFER_RETAIN_MS }));
      setStatus('live');
      setFailure(null);
    } catch (error) {
      if (!isCurrent(gen)) return;
      if (motionReading !== null) {
        setReadings((prev) =>
          mergeReadings(prev, [motionReading], { now, retainMs: BUFFER_RETAIN_MS }),
        );
      }
      setStatus('error');
      setFailure(describeFailure(error, 'read'));
    } finally {
      polling.current = false;
    }
  }, [isCurrent]);

  /** Permissions exist: start the accelerometer fold (once) and take the first poll. */
  const beginPolling = useCallback(
    async (gen: number) => {
      if (fold.current === null) {
        const available = await isMotionAvailable();
        if (!isCurrent(gen)) return;
        if (available) fold.current = startMotionFold();
      }
      active.current = true;
      await poll();
    },
    [isCurrent, poll],
  );

  const start = useCallback(
    async (gen: number) => {
      setStatus('loading');
      setFailure(null);
      try {
        const availability = await checkHealthConnect();
        if (!isCurrent(gen)) return;
        if (availability !== 'available') {
          setStatus('unavailable');
          setFailure({
            kind: 'sdk',
            message:
              availability === 'update-required'
                ? 'Health Connect needs an update from the Play Store before it can share data.'
                : 'Health Connect is not available on this device.',
          });
          return;
        }
        ready.current = true;

        granted.current = await grantedVitalsPermissions();
        if (!isCurrent(gen)) return;
        if (granted.current.length === 0) {
          setStatus('permission-required');
          return;
        }
        await beginPolling(gen);
      } catch (error) {
        if (!isCurrent(gen)) return;
        setStatus('error');
        setFailure(describeFailure(error, 'sdk'));
      }
    },
    [beginPolling, isCurrent],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    generation.current += 1;
    const gen = generation.current;

    if (!enabled) {
      ready.current = false;
      active.current = false;
      granted.current = [];
      lastPolledRef.current = null;
      fold.current?.stop();
      fold.current = null;
      setReadings([]);
      setStatus('idle');
      setFailure(null);
      setLastPolledAt(null);
      return;
    }

    void start(gen);

    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);

    const onChange = (next: AppStateStatus) => {
      if (next !== 'active') return;
      const last = lastPolledRef.current;
      // Only when an interval has effectively already elapsed, so app-switching does not turn
      // into a read per switch. Before the first poll there is nothing to catch up on.
      if (last !== null && Date.now() - last >= POLL_INTERVAL_MS) void poll();
    };
    const subscription = AppState.addEventListener('change', onChange);

    return () => {
      generation.current += 1;
      active.current = false;
      clearInterval(timer);
      subscription.remove();
      fold.current?.stop();
      fold.current = null;
    };
  }, [enabled, poll, start]);

  const requestAccess = useCallback(() => {
    if (!enabled || !ready.current) return;
    const gen = generation.current;
    void (async () => {
      try {
        const next = await requestVitalsAccess();
        if (!isCurrent(gen)) return;
        granted.current = next;
        if (next.length === 0) {
          setStatus('permission-required');
          return;
        }
        setStatus('loading');
        await beginPolling(gen);
      } catch (error) {
        if (!isCurrent(gen)) return;
        setStatus('error');
        setFailure(describeFailure(error, 'permission'));
      }
    })();
  }, [beginPolling, enabled, isCurrent]);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  return { readings, status, failure, lastPolledAt, requestAccess, refresh };
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest src/hooks/__tests__/use-sensors.test.ts 2>&1 | tail -30 && npx tsc --noEmit
```

Expected: all 18 tests PASS; tsc clean. If a test hangs on `settle()`, add one more `await Promise.resolve()` to the helper — each awaited step in `start → grantedVitalsPermissions → isMotionAvailable → readVitals` is one microtask hop. If "not wrapped in act" warnings appear in the unmount test, the `isCurrent` guard is missing on one path — find the `setState` that ran after `mounted.current = false`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-sensors.ts src/hooks/__tests__/use-sensors.test.ts && git -c core.autocrlf=false commit -m "feat(sensors): live polling hook with foreground catch-up and user-only prompts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Provider, public surface, root layout, and screen-test wrappers

**Files:**
- Create: `src/sensors/provider.tsx`
- Create: `src/sensors/index.ts`
- Modify: `src/app/_layout.tsx`
- Modify: `src/__tests__/home-screen.test.tsx` (wrapper), `src/__tests__/simulate-fall.test.tsx` (wrapper)
- Test: `src/sensors/__tests__/provider.test.tsx`

**Interfaces:**
- Consumes: Task 7 `useSensors`; `useSettings` from `@/settings/provider` (`settings.sensorSource`).
- Produces: `SensorProvider`, `useSensorFeed(): SensorFeed`, and `@/sensors` re-exporting types + `HEALTH_CONNECT_SOURCE`.

- [ ] **Step 1: Write the failing provider test**

Create `src/sensors/__tests__/provider.test.tsx`:

```tsx
/**
 * The sensor context, and its one hard rule: a screen that reads the feed outside the
 * provider fails at first render, never silently renders an empty vitals row.
 */

import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { SensorProvider, useSensorFeed } from '@/sensors/provider';
import { SettingsProvider } from '@/settings/provider';

describe('useSensorFeed', () => {
  it('throws outside a SensorProvider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useSensorFeed())).toThrow(/inside a <SensorProvider>/);
    spy.mockRestore();
  });

  it('is idle under the default (simulated) sensor source', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SettingsProvider>
        <SensorProvider>{children}</SensorProvider>
      </SettingsProvider>
    );
    const { result } = renderHook(() => useSensorFeed(), { wrapper });
    expect(result.current.status).toBe('idle');
    expect(result.current.readings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest src/sensors/__tests__/provider.test.tsx 2>&1 | tail -6
```

Expected: FAIL — cannot find module `@/sensors/provider`.

- [ ] **Step 3: Create `src/sensors/provider.tsx`**

```tsx
/**
 * One sensor feed for the whole app.
 *
 * Same reasoning as `environment/provider.tsx`: the Dashboard's risk engine and (later) the
 * Trends screen read one buffer, so there is one accelerometer subscription and one poll
 * timer, and two screens can never disagree about what the newest reading is.
 *
 * The feed is gated here, not in the hook's callers: Settings' "Sensor source" picker is the
 * single switch, and reading it in one place is what keeps a demo on the simulated window
 * from quietly also polling Health Connect underneath.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { useSensors } from '@/hooks/use-sensors';
import type { SensorFeed } from '@/sensors/types';
import { useSettings } from '@/settings/provider';

const SensorContext = createContext<SensorFeed | null>(null);

export function SensorProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const feed = useSensors({ enabled: settings.sensorSource === 'health_connect' });
  return <SensorContext.Provider value={feed}>{children}</SensorContext.Provider>;
}

/**
 * Throws when no provider is mounted, deliberately — an inert default would render an empty
 * vitals row and a Dashboard scoring nothing, with no fault reported anywhere.
 */
export function useSensorFeed(): SensorFeed {
  const feed = useContext(SensorContext);
  if (feed === null) {
    throw new Error('useSensorFeed must be used inside a <SensorProvider>.');
  }
  return feed;
}
```

Create `src/sensors/index.ts`:

```ts
/**
 * Sensor ingestion (PRD §7.2.1) — public surface.
 *
 * The provider and hook are imported from their own modules (`@/sensors/provider`,
 * `@/hooks/use-sensors`) so a test can mock the context without pulling native modules in.
 */

export { HEALTH_CONNECT_SOURCE } from './health-connect';
export type { SensorFailure, SensorFailureKind, SensorFeed, SensorFeedStatus } from './types';
```

- [ ] **Step 4: Mount the provider in `src/app/_layout.tsx`**

Add the import and wrap `AppTabs` (the file is CRLF — use the Edit tool):

```tsx
import { SensorProvider } from '@/sensors/provider';
```

and

```tsx
        <SettingsProvider>
          {/* Inside Settings because the picker there is what switches the feed on; the
              Dashboard's risk engine and Settings then agree on which source is live. */}
          <SensorProvider>
            <AnimatedSplashOverlay />
            <AppTabs />
          </SensorProvider>
        </SettingsProvider>
```

- [ ] **Step 5: Add the provider to the two screen tests that render `HomeScreen`**

In `src/__tests__/home-screen.test.tsx` and `src/__tests__/simulate-fall.test.tsx`, add `import { SensorProvider } from '@/sensors/provider';` and change each render wrapper from

```tsx
        <SettingsProvider>
          <HomeScreen />
        </SettingsProvider>
```

to

```tsx
        <SettingsProvider>
          <SensorProvider>
            <HomeScreen />
          </SensorProvider>
        </SettingsProvider>
```

(`simulate-fall.test.tsx` has a second `<SettingsProvider>` around `<Harness …>` at ~line 357 — that one renders `SosAlert` via `useSos`, not `HomeScreen`, and needs no change.)

- [ ] **Step 6: Run the full suite**

```bash
npm test -- --silent 2>&1 | tail -6 && npx tsc --noEmit
```

Expected: all suites pass (985 + new tests from Tasks 2–8); tsc clean. `HomeScreen` tests must be byte-for-byte unaffected — the global mocks report no Health Connect and the default source is `'simulated'`, so the feed is idle.

- [ ] **Step 7: Commit**

```bash
git add src/sensors/provider.tsx src/sensors/index.ts src/sensors/__tests__/provider.test.tsx src/app/_layout.tsx src/__tests__/home-screen.test.tsx src/__tests__/simulate-fall.test.tsx && git -c core.autocrlf=false commit -m "feat(sensors): SensorProvider gated by the Settings sensor source

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Live-mode fall splice

**Files:**
- Modify: `src/constants/mock-sensor-window.ts` (append one export)
- Test: `src/constants/__tests__/mock-sensor-window.test.ts` (append one `describe`)

**Interfaces:**
- Produces: `spliceSimulatedFall(readings: readonly SensorReading[], now: number): SensorReading[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/constants/__tests__/mock-sensor-window.test.ts` (CRLF — use the Edit tool; add `spliceSimulatedFall` to its existing import from `@/constants/mock-sensor-window`, and confirm `assessRisk` is already imported — `grep -n "assessRisk" src/constants/__tests__/mock-sensor-window.test.ts | head -2`; if not, add `import { assessRisk } from '@/risk';`):

```ts
describe('spliceSimulatedFall (live mode)', () => {
  const NOW = 1_766_000_000_000;
  const MINUTE = 60_000;

  /** A quiet live buffer: HR every 30 s and a still motion reading at each past poll. */
  function liveReadings(): SensorReading[] {
    const out: SensorReading[] = [];
    for (let offset = -20 * MINUTE; offset <= 0; offset += 30_000) {
      out.push({ source: 'health_connect', timestamp: NOW + offset, hr: 74 });
      if (offset % MINUTE === 0) {
        out.push({
          source: 'health_connect',
          timestamp: NOW + offset,
          motionSummary: MOCK_WINDOW.still,
        });
      }
    }
    return out;
  }

  it('leaves a quiet live buffer green with no SOS candidate', () => {
    const assessment = assessRisk({ readings: liveReadings(), now: NOW });
    expect(assessment.byCategory.fall.level).toBe('green');
    expect(assessment.sosCandidate).toBe(false);
  });

  it('turns the same live buffer into a confirmed, ongoing fall the engine escalates', () => {
    const readings = spliceSimulatedFall(liveReadings(), NOW);
    const assessment = assessRisk({ readings, now: NOW });

    expect(assessment.byCategory.fall.rule).toBe('fall.impactThenStillness');
    expect(assessment.byCategory.fall.criticalRules).toContain('fall.impactThenStillness');
    expect(assessment.sosCandidate).toBe(true);
  });

  it('keeps every live vital and only replaces motion inside the spliced span', () => {
    const live = liveReadings();
    const spliced = spliceSimulatedFall(live, NOW);
    const hrCount = (rs: readonly SensorReading[]) => rs.filter((r) => r.hr !== undefined).length;
    expect(hrCount(spliced)).toBe(hrCount(live));
    // Newest reading is the spliced still sample, so the trailing-still run is measurable.
    const newest = spliced[spliced.length - 1];
    expect(newest.timestamp).toBe(NOW);
    expect(newest.motionSummary).toEqual(MOCK_WINDOW.still);
  });

  it('is a no-op shape-wise on an empty buffer: three motion readings, nothing else', () => {
    const spliced = spliceSimulatedFall([], NOW);
    expect(spliced.map((r) => r.timestamp - NOW)).toEqual([-2 * MINUTE, -MINUTE, 0]);
    expect(spliced[0].motionSummary).toEqual(MOCK_WINDOW.fallImpact);
  });
});
```

Add `import type { SensorReading } from '@/risk';` if the test file does not already import it.

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest src/constants/__tests__/mock-sensor-window.test.ts -t spliceSimulatedFall 2>&1 | tail -8
```

Expected: FAIL — `spliceSimulatedFall` is not exported.

- [ ] **Step 3: Append to `src/constants/mock-sensor-window.ts`** (CRLF — use the Edit tool, inserting before the `MOCK_WINDOW` export)

```ts
/**
 * Live-mode counterpart of {@link FALL_MOTION}, for the same dev-only Dashboard control when
 * the buffer comes from Health Connect rather than from this file.
 *
 * Splices impact → still → still at `now − 2·INTERVAL`, `now − INTERVAL`, `now`, and strips
 * any live motion inside that span so a real "walking" summary cannot break the still run.
 * Every live *vital* is kept untouched — the point is to prove the detector on real data.
 *
 * The tail lands at exactly `now`, not `now − LATEST_AGE_MS` as the mock does, because
 * `rules/fall.ts` measures the ongoing stillness from the *newest* reading and the live buffer
 * has HR samples right up to the poll instant; a still sample any older would be outranked by
 * a motion-less HR reading and the escalation to SOS would not fire.
 */
export function spliceSimulatedFall(
  readings: readonly SensorReading[],
  now: number,
): SensorReading[] {
  const tail: SensorReading[] = [FALL_IMPACT, STILL, STILL].map((motionSummary, index) => ({
    source: 'simulated' as const,
    timestamp: now - (2 - index) * INTERVAL_MS,
    motionSummary,
  }));
  const spanStart = tail[0].timestamp;

  const kept: SensorReading[] = [];
  for (const reading of readings) {
    if (reading.timestamp < spanStart || reading.motionSummary === undefined) {
      kept.push(reading);
      continue;
    }
    // Inside the span: keep the vitals, drop the motion. A motion-only reading has nothing left.
    const { motionSummary: _dropped, motion: _dropped2, ...vitals } = reading;
    if (vitals.hr !== undefined || vitals.spo2 !== undefined || vitals.skinTempC !== undefined) {
      kept.push(vitals);
    }
  }

  return [...kept, ...tail].sort((a, b) => a.timestamp - b.timestamp);
}
```

If ESLint flags the `_dropped` variables as unused, replace the destructuring with:

```ts
    const vitals: SensorReading = { source: reading.source, timestamp: reading.timestamp };
    const stripped = {
      ...vitals,
      ...(reading.hr !== undefined ? { hr: reading.hr } : {}),
      ...(reading.spo2 !== undefined ? { spo2: reading.spo2 } : {}),
      ...(reading.skinTempC !== undefined ? { skinTempC: reading.skinTempC } : {}),
    };
    if (reading.hr !== undefined || reading.spo2 !== undefined || reading.skinTempC !== undefined) {
      kept.push(stripped);
    }
```

- [ ] **Step 4: Run tests**

```bash
npx jest src/constants 2>&1 | tail -6 && npx tsc --noEmit
```

Expected: PASS; tsc clean. If the "confirmed, ongoing fall" test fails with the fall card `amber`/unconfirmed, print `assessment.byCategory.fall` and check: the impact must sit ≥ `fall.stillnessMs` before `now` and the two still readings must be within `window.maxGapMs` of each other — with `INTERVAL_MS = 60 s` and `maxGapMs = 2 min` they are.

- [ ] **Step 5: Commit**

```bash
git add src/constants/mock-sensor-window.ts src/constants/__tests__/mock-sensor-window.test.ts && git -c core.autocrlf=false commit -m "feat(demo): splice the simulated fall onto a live buffer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `useRiskAssessment` reads the live feed

**Files:**
- Modify: `src/hooks/use-risk-assessment.ts`
- Test: `src/hooks/__tests__/use-risk-assessment.test.ts` (new)

**Interfaces:**
- Consumes: Task 8 `useSensorFeed`, Task 9 `spliceSimulatedFall`, `useSettings`.
- Produces: `DashboardRisk` gains `feedStatus: SensorFeedStatus`, `feedFailure: SensorFailure | null`, `live: boolean`, `requestAccess: () => void`.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/__tests__/use-risk-assessment.test.ts`:

```ts
/**
 * The one line that decides whether the Dashboard scores real or simulated data.
 *
 * Everything else in this hook is a memo over pure functions that have their own tests. What
 * has to be pinned here is the *selection*: with the picker on Health Connect the engine must
 * see the feed's buffer and not the mock, with it on simulated it must see the mock and never
 * the feed, and the dev-only fall splice must work on both. A hook that silently kept reading
 * the mock would pass every other test in the repository.
 */

import { renderHook } from '@testing-library/react-native';

import { buildMockReadings } from '@/constants/mock-sensor-window';
import { useEnvironmentFeed } from '@/environment/provider';
import { useRiskAssessment } from '@/hooks/use-risk-assessment';
import type { SensorReading } from '@/risk';
import { useSensorFeed } from '@/sensors/provider';
import { useSettings } from '@/settings/provider';
import { DEFAULT_SETTINGS } from '@/settings/store';

jest.mock('@/environment/provider', () => ({ useEnvironmentFeed: jest.fn() }));
jest.mock('@/sensors/provider', () => ({ useSensorFeed: jest.fn() }));
jest.mock('@/settings/provider', () => ({ useSettings: jest.fn() }));

const environment = jest.mocked(useEnvironmentFeed);
const feed = jest.mocked(useSensorFeed);
const settings = jest.mocked(useSettings);

const NOW = 1_766_000_000_000;
const requestAccess = jest.fn();

function liveReading(offsetMs: number, bpm: number): SensorReading {
  return { source: 'health_connect', timestamp: NOW + offsetMs, hr: bpm };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  environment.mockReturnValue({
    environment: null,
    status: 'loading',
    failure: null,
    refreshing: false,
    refresh: jest.fn(),
  });
  feed.mockReturnValue({
    readings: [liveReading(-30_000, 131)],
    status: 'live',
    failure: null,
    lastPolledAt: NOW,
    requestAccess,
    refresh: jest.fn(),
  });
  settings.mockReturnValue({
    settings: { ...DEFAULT_SETTINGS, sensorSource: 'health_connect' },
    loaded: true,
    writeFailed: false,
    addContact: jest.fn(),
    removeContact: jest.fn(),
    setUserName: jest.fn(),
    setSharing: jest.fn(),
    setSensorSource: jest.fn(),
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useRiskAssessment source selection', () => {
  it('scores the live buffer when the source is health_connect', () => {
    const { result } = renderHook(() => useRiskAssessment());
    expect(result.current.live).toBe(true);
    expect(result.current.latest?.source).toBe('health_connect');
    expect(result.current.latest?.hr).toBe(131);
    expect(result.current.feedStatus).toBe('live');
    expect(result.current.requestAccess).toBe(requestAccess);
  });

  it('scores the simulated window when the source is simulated, ignoring the feed', () => {
    settings.mockReturnValue({
      ...settings(),
      settings: { ...DEFAULT_SETTINGS, sensorSource: 'simulated' },
    });
    const { result } = renderHook(() => useRiskAssessment());
    expect(result.current.live).toBe(false);
    expect(result.current.latest).toEqual(buildMockReadings(NOW).at(-1));
    expect(result.current.assessment.sampleCount).toBeGreaterThan(1);
  });

  it('reports an empty live buffer as no latest reading rather than falling back to the mock', () => {
    feed.mockReturnValue({ ...feed(), readings: [] });
    const { result } = renderHook(() => useRiskAssessment());
    expect(result.current.latest).toBeNull();
    expect(result.current.assessment.sampleCount).toBe(0);
  });

  it('splices the simulated fall onto the live buffer under simulateFall', () => {
    const { result } = renderHook(() => useRiskAssessment({ simulateFall: true }));
    expect(result.current.live).toBe(true);
    expect(result.current.assessment.byCategory.fall.criticalRules).toContain(
      'fall.impactThenStillness',
    );
    expect(result.current.assessment.sosCandidate).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest src/hooks/__tests__/use-risk-assessment.test.ts 2>&1 | tail -8
```

Expected: FAIL — `live` / `feedStatus` undefined on the result (and `useSensorFeed` never called).

- [ ] **Step 3: Rewrite `src/hooks/use-risk-assessment.ts`** (CRLF file; replace its body with the Edit tool in two edits — imports/types and the hook — or rewrite via the Write tool with LF, which is acceptable for a file that is changing substantially)

Keep the existing header comment's "Why the evaluation instant has to advance" section, and replace the first paragraph and everything from the imports down with:

```ts
import { useMemo } from 'react';

import {
  buildEnvironmentSnapshot,
  buildMockReadings,
  spliceSimulatedFall,
} from '@/constants/mock-sensor-window';
import { useEnvironmentFeed } from '@/environment/provider';
import { useNow } from '@/hooks/use-now';
import {
  assessRisk,
  computeVitalBaselines,
  type RiskAssessment,
  type SensorReading,
  type VitalBaselines,
} from '@/risk';
import { useSensorFeed } from '@/sensors/provider';
import type { SensorFailure, SensorFeedStatus } from '@/sensors/types';
import { useSettings } from '@/settings/provider';

/** Matches the sensor poll cadence, so the window advances a sample per tick. */
export const RE_EVALUATE_INTERVAL_MS = 60 * 1000;

export type DashboardRisk = {
  readonly assessment: RiskAssessment;
  /**
   * Newest reading in the evaluated window, or null when the buffer is empty — which a live
   * buffer is at cold start, so the vitals row has to be able to say so.
   */
  readonly latest: SensorReading | null;
  /** Each vital against its rolling average over the same window (PRD §7.2.1 extension). */
  readonly baselines: VitalBaselines;
  /** True when the readings came from Health Connect rather than the simulated window. */
  readonly live: boolean;
  /** The feed's own state, so the Dashboard can say *why* a live buffer is empty. */
  readonly feedStatus: SensorFeedStatus;
  readonly feedFailure: SensorFailure | null;
  /** Raises the Health Connect permission dialog. User-initiated only. */
  readonly requestAccess: () => void;
};

export type UseRiskAssessmentOptions = {
  /**
   * Dev-only: splice a fall into the tail of whichever window is live (PRD §7.2.2). Shapes the
   * engine's *input* and nothing else — see `MockReadingOptions` for why the demo trigger has
   * to work that way to prove anything.
   */
  readonly simulateFall?: boolean;
};

export function useRiskAssessment(options: UseRiskAssessmentOptions = {}): DashboardRisk {
  const { environment } = useEnvironmentFeed();
  const feed = useSensorFeed();
  const { settings } = useSettings();
  const now = useNow(RE_EVALUATE_INTERVAL_MS);
  const simulateFall = options.simulateFall === true;
  const live = settings.sensorSource === 'health_connect';
  const liveReadings = feed.readings;

  return useMemo(() => {
    // The one place the app decides which buffer is real. `live` is read from Settings, not
    // from the feed's status, so a feed that is switched on but empty scores as "no data"
    // rather than quietly showing the simulated window under a Health Connect label.
    const readings = live
      ? simulateFall
        ? spliceSimulatedFall(liveReadings, now)
        : liveReadings
      : buildMockReadings(now, { simulateFall });

    const assessment = assessRisk({
      readings,
      environment: buildEnvironmentSnapshot(environment),
      now,
    });
    return {
      assessment,
      latest: readings.at(-1) ?? null,
      baselines: computeVitalBaselines({ readings, assessment }),
      live,
      feedStatus: feed.status,
      feedFailure: feed.failure,
      requestAccess: feed.requestAccess,
    };
  }, [environment, feed.failure, feed.requestAccess, feed.status, live, liveReadings, now, simulateFall]);
}
```

- [ ] **Step 4: Run the hook test, then the whole suite**

```bash
npx jest src/hooks/__tests__/use-risk-assessment.test.ts 2>&1 | tail -8 && npm test -- --silent 2>&1 | tail -6 && npx tsc --noEmit
```

Expected: PASS everywhere. `home-screen.test.tsx` and `simulate-fall.test.tsx` mock `buildMockReadings` from `@/constants/mock-sensor-window` with `requireActual` spread, so `spliceSimulatedFall` is still real there and the simulated path is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-risk-assessment.ts src/hooks/__tests__/use-risk-assessment.test.ts && git -c core.autocrlf=false commit -m "feat(dashboard): score the live Health Connect buffer when it is the selected source

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Dashboard feed notice

**Files:**
- Create: `src/components/sensor-feed-notice.tsx`
- Modify: `src/app/index.tsx`
- Test: `src/components/__tests__/sensor-feed-notice.test.tsx`
- Test: `src/__tests__/home-screen.test.tsx` (append one `describe`)

**Interfaces:**
- Consumes: Task 10 `DashboardRisk.live / feedStatus / feedFailure / requestAccess`.
- Produces: `SensorFeedNotice({ live, status, failure, readingCount, onRequestAccess })`, `noticeFor(...)` pure helper.

- [ ] **Step 1: Write the failing component test**

Create `src/components/__tests__/sensor-feed-notice.test.tsx`:

```tsx
/**
 * The Dashboard's answer to "why is the vitals row empty?" when the live feed is selected.
 *
 * The notice must be absent in exactly two states — simulated source, and live with readings —
 * because a permanent status row would train the user to ignore it. And the only tappable
 * state is permission-required, because that is the only one a tap can fix.
 */

import { fireEvent, render } from '@testing-library/react-native';

import { noticeFor, SensorFeedNotice } from '@/components/sensor-feed-notice';

describe('noticeFor', () => {
  it('is silent on the simulated source whatever the feed says', () => {
    expect(noticeFor({ live: false, status: 'error', failure: null, readingCount: 0 })).toBeNull();
  });

  it('is silent once live readings exist', () => {
    expect(noticeFor({ live: true, status: 'live', failure: null, readingCount: 3 })).toBeNull();
  });

  it('says it is waiting when live but empty', () => {
    const notice = noticeFor({ live: true, status: 'live', failure: null, readingCount: 0 });
    expect(notice?.title).toMatch(/waiting/i);
    expect(notice?.actionable).toBe(false);
  });

  it('asks for access, tappably, when permission is required', () => {
    const notice = noticeFor({
      live: true,
      status: 'permission-required',
      failure: null,
      readingCount: 0,
    });
    expect(notice?.actionable).toBe(true);
    expect(notice?.hint).toMatch(/heart rate/i);
  });

  it('surfaces the failure message for unavailable and error', () => {
    const failure = { kind: 'sdk' as const, message: 'Health Connect is not available on this device.' };
    expect(
      noticeFor({ live: true, status: 'unavailable', failure, readingCount: 0 })?.hint,
    ).toBe(failure.message);
    expect(
      noticeFor({ live: true, status: 'error', failure: { kind: 'read', message: 'busy' }, readingCount: 2 })
        ?.hint,
    ).toBe('busy');
  });
});

describe('SensorFeedNotice', () => {
  it('renders nothing when there is no notice', async () => {
    const screen = await render(
      <SensorFeedNotice live={false} status="idle" failure={null} readingCount={0} onRequestAccess={jest.fn()} />,
    );
    expect(screen.toJSON()).toBeNull();
  });

  it('calls onRequestAccess only from the permission-required state', async () => {
    const onRequestAccess = jest.fn();
    const screen = await render(
      <SensorFeedNotice
        live
        status="permission-required"
        failure={null}
        readingCount={0}
        onRequestAccess={onRequestAccess}
      />,
    );
    fireEvent.press(screen.getByRole('button'));
    expect(onRequestAccess).toHaveBeenCalledTimes(1);
  });

  it('is not a button while waiting', async () => {
    const screen = await render(
      <SensorFeedNotice live status="live" failure={null} readingCount={0} onRequestAccess={jest.fn()} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/waiting/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest src/components/__tests__/sensor-feed-notice.test.tsx 2>&1 | tail -6
```

Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/components/sensor-feed-notice.tsx`**

```tsx
/**
 * One row under the vitals card that explains an empty live buffer (PRD §7.2.4 Dashboard).
 *
 * Deliberately silent on the simulated source and once live readings exist — a status line
 * that is always present is one nobody reads. The only tappable state is the one a tap can
 * change: permission-required raises the Health Connect dialog through the feed's
 * user-initiated `requestAccess`.
 */

import { Pressable, StyleSheet } from 'react-native';

import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { SensorFailure, SensorFeedStatus } from '@/sensors/types';

export type FeedNotice = {
  readonly title: string;
  readonly hint: string;
  readonly actionable: boolean;
};

export type NoticeInput = {
  readonly live: boolean;
  readonly status: SensorFeedStatus;
  readonly failure: SensorFailure | null;
  readonly readingCount: number;
};

export function noticeFor({ live, status, failure, readingCount }: NoticeInput): FeedNotice | null {
  if (!live) return null;
  switch (status) {
    case 'idle':
    case 'loading':
      return { title: 'Connecting to Health Connect', hint: 'Checking access to your health data…', actionable: false };
    case 'permission-required':
      return {
        title: 'Health Connect access needed',
        hint: 'Tap to allow reading heart rate, blood oxygen and skin temperature from your paired band or watch.',
        actionable: true,
      };
    case 'unavailable':
      return {
        title: 'Health Connect unavailable',
        hint: failure?.message ?? 'Health Connect is not available on this device.',
        actionable: false,
      };
    case 'error':
      return {
        title: 'Health Connect read failed',
        hint: failure?.message ?? 'Could not read from Health Connect.',
        actionable: false,
      };
    case 'live':
      return readingCount === 0
        ? {
            title: 'Waiting for Health Connect',
            hint: 'No readings in the last few minutes. Make sure your band or watch has synced.',
            actionable: false,
          }
        : null;
  }
}

export type SensorFeedNoticeProps = NoticeInput & {
  readonly onRequestAccess: () => void;
};

export function SensorFeedNotice({ onRequestAccess, ...input }: SensorFeedNoticeProps) {
  const notice = noticeFor(input);
  if (notice === null) return null;

  return (
    <Pressable
      accessibilityRole={notice.actionable ? 'button' : undefined}
      disabled={!notice.actionable}
      onPress={onRequestAccess}
      style={({ pressed }) => [pressed && notice.actionable && styles.pressed]}>
      <Card style={styles.card}>
        <ThemedText type="smallBold">{notice.title}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {notice.hint}
        </ThemedText>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.one,
  },
  pressed: {
    opacity: 0.8,
  },
});
```

If `Spacing.one` does not exist, check `src/constants/theme.ts` for the smallest step (`grep -n "one\|half" src/constants/theme.ts`) and use that.

- [ ] **Step 4: Render it on the Dashboard**

In `src/app/index.tsx` (CRLF — Edit tool): add `import { SensorFeedNotice } from '@/components/sensor-feed-notice';`, destructure the new fields —

```tsx
  const { assessment, latest, baselines, live, feedStatus, feedFailure, requestAccess } =
    useRiskAssessment({ simulateFall });
```

— and insert directly after `<VitalsCard latest={latest} baselines={baselines} />`:

```tsx
      {/* Only ever visible with Health Connect selected and nothing usable on screen — says
          why, and offers the one fix a tap can make (PRD §7.2.4). */}
      <SensorFeedNotice
        live={live}
        status={feedStatus}
        failure={feedFailure}
        readingCount={assessment.sampleCount}
        onRequestAccess={requestAccess}
      />
```

- [ ] **Step 5: Add a Dashboard integration test**

Append to `src/__tests__/home-screen.test.tsx` (CRLF — Edit tool). It needs `AsyncStorage` and `SETTINGS_KEY` to pre-seed the picker; check whether the file already imports them (`grep -n "AsyncStorage\|SETTINGS_KEY" src/__tests__/home-screen.test.tsx`), add if not:

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SETTINGS_KEY } from '@/settings/store';
import { checkHealthConnect, grantedVitalsPermissions } from '@/sensors/health-connect';
```

plus, next to the other `jest.mock` calls at the top of the file:

```tsx
jest.mock('@/sensors/health-connect', () => ({
  ...jest.requireActual('@/sensors/health-connect'),
  checkHealthConnect: jest.fn(() => Promise.resolve('unavailable')),
  grantedVitalsPermissions: jest.fn(() => Promise.resolve([])),
}));
```

and the new suite:

```tsx
describe('Health Connect selected', () => {
  beforeEach(async () => {
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ contacts: [], userName: '', sharing: { sos: true, anon_aggregate: false, cloud_backup: false, family_share: false }, sensorSource: 'health_connect' }),
    );
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('asks for access instead of showing simulated vitals when nothing is granted', async () => {
    jest.mocked(checkHealthConnect).mockResolvedValue('available');
    jest.mocked(grantedVitalsPermissions).mockResolvedValue([]);
    mockedFetch.mockResolvedValue(liveEnvironment({ location: 'Chennai', fetchedAt: NOW, tempC: 28 }));
    mockedRead.mockResolvedValue(null);

    const screen = await renderHome();
    expect(await screen.findByText('Health Connect access needed')).toBeTruthy();
    expect(screen.queryByText(/Simulated data/)).toBeNull();
  });

  it('explains an unavailable Health Connect', async () => {
    jest.mocked(checkHealthConnect).mockResolvedValue('unavailable');
    mockedFetch.mockResolvedValue(liveEnvironment({ location: 'Chennai', fetchedAt: NOW, tempC: 28 }));
    mockedRead.mockResolvedValue(null);

    const screen = await renderHome();
    expect(await screen.findByText('Health Connect unavailable')).toBeTruthy();
  });
});
```

Adjust `renderHome`, `mockedFetch`, `mockedRead`, `liveEnvironment`, `NOW` to the file's actual helper names (they are visible in its first 100 lines: `renderHome` may be named differently — `grep -n "^async function render\|^function render" src/__tests__/home-screen.test.tsx`). If the file's `sharing` keys differ from the four above, copy them from `DATA_SHARING_PREFS` in `src/constants/health-data.ts`.

- [ ] **Step 6: Run everything**

```bash
npm test -- --silent 2>&1 | tail -6 && npx tsc --noEmit && npx expo lint 2>&1 | tail -5
```

Expected: all suites pass; tsc clean; lint clean (or only pre-existing warnings — compare with `git stash; npx expo lint; git stash pop` if unsure).

- [ ] **Step 7: Commit**

```bash
git add src/components/sensor-feed-notice.tsx src/components/__tests__/sensor-feed-notice.test.tsx src/app/index.tsx src/__tests__/home-screen.test.tsx && git -c core.autocrlf=false commit -m "feat(dashboard): explain an empty live feed and offer the Health Connect permission

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Native regeneration and final verification

**Files:**
- Regenerates: `android/` (gitignored)
- Modify: `docs/sos-relay.md` — no; instead create `docs/health-connect.md`

- [ ] **Step 1: Regenerate the native project**

```bash
npx expo prebuild --platform android --clean 2>&1 | tail -15
```

Expected: completes without error. Then confirm the manifest carries what the app needs:

```bash
grep -nE 'health\.READ_|ACTION_SHOW_PERMISSIONS_RATIONALE|VIEW_PERMISSION_USAGE' android/app/src/main/AndroidManifest.xml && grep -n 'minSdkVersion' android/build.gradle
```

Expected: three `android.permission.health.READ_*` `uses-permission` lines, the rationale intent-filter, the `ViewPermissionUsageActivity` alias, and `minSdkVersion = 26`.

- [ ] **Step 2: Write the developer note**

Create `docs/health-connect.md`:

```markdown
# Live vitals from Health Connect (PRD §6.4, §7.2.1)

The Dashboard scores a live `SensorReading` buffer when Settings → Sensor source is
**Android Health Connect**. The default stays **Simulated data**, which is the demo fallback
PRD §12 asks for.

## Running it

Health Connect is a native module, so Expo Go cannot run this app. Build a development client:

```
npx expo prebuild --platform android
npx expo run:android
```

On the phone: install/update **Health Connect** from the Play Store (built into Android 14+),
pair a band or watch whose companion app writes heart rate / SpO₂ / skin temperature to it,
then in this app choose Settings → Sensor source → Android Health Connect and tap the
"Health Connect access needed" row on the Dashboard.

## What is read

Read-only: `HeartRate` (every sample), `OxygenSaturation`, and `SkinTemperature` (only when the
record carries a baseline — Health Connect stores skin temperature as deltas). Nothing is
written and nothing leaves the device (PRD §7.2.6). The phone's own accelerometer is folded
into a per-minute `MotionSummary` for the fall and stillness rules.

## Cadence and buffer

Polled every 60 s (`POLL_INTERVAL_MS`), catching up on foreground if the app was backgrounded
longer than that. The buffer keeps `longestLookbackMs + 2 min`, derived from the engine's
thresholds, so every extended-lookback rule sees a full window.

## Demoing a fall on live data

In a development build the Dashboard's "Dev · Simulate a fall" control works on the live buffer
too: it splices a real impact-then-stillness motion sequence onto the tail and lets
`rules/fall.ts` detect it. Vitals are untouched.
```

- [ ] **Step 3: Full verification**

```bash
npm test -- --silent 2>&1 | tail -6 && npx tsc --noEmit && npx expo lint 2>&1 | tail -3 && git status --short | grep -v '^ M' 
```

Expected: every suite green with a count > 985; tsc and lint clean; `git status` shows no untracked files from this work (the `?? .probe.png`, `?? .ui.xml` and the pre-existing untracked feature files from before this plan are not ours to commit here).

- [ ] **Step 4: Commit**

```bash
git add docs/health-connect.md && git -c core.autocrlf=false commit -m "docs: how to run and demo the live Health Connect feed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Report**

Report the final test count, that tsc/lint are clean, that `android/` was regenerated with the health permissions, and that an on-device check (`npx expo run:android` on a phone with Health Connect + a paired band) is the remaining step no test here can replace.
