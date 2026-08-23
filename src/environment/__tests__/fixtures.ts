/**
 * A `LiveEnvironment` builder for tests.
 *
 * Not a suite — `jest.config.js` requires a `.test`/`.spec` infix precisely so helpers can
 * live beside the tests that use them.
 *
 * ## Why the derived fields are computed rather than written down
 * The previous `ENVIRONMENT` mock hardcoded `heatIndexC: 56.4` next to `tempC: 38` and
 * `humidity: 62`, and needed a dedicated test in `heat-index.test.ts` to stop those three
 * numbers drifting apart. A fixture that derives the index from its own inputs cannot drift,
 * so overriding `tempC` or `humidity` here produces a *physically coherent* observation
 * instead of a self-contradictory one — which matters, because several suites use this to
 * drive the real risk engine and a fixture that lies would validate the wrong behaviour.
 *
 * The defaults reproduce the old mock's conditions — 38 °C at 62 % RH, AQI 168 — so the
 * expectations built against them (Extreme Danger heat, red heat card) still describe the
 * same weather they always did. What changed is only that this is now test input rather
 * than something the app ships.
 */

import { aqiCategoryFor, type LiveEnvironment } from '@/environment';
import { computeHeatIndexC, heatIndexBandForC } from '@/risk';

/** Fixed instant, so every expectation built on this fixture is exact. */
export const FIXTURE_NOW = 1_766_000_000_000;

/**
 * How old the fixture's observation is. Comfortably inside the engine's `env.maxStaleMs`
 * (60 min), so the heat category reports `dataQuality: 'ok'` and the rules are reachable.
 */
export const FIXTURE_OBSERVATION_AGE_MS = 12 * 60 * 1000;

export function liveEnvironment(overrides: Partial<LiveEnvironment> = {}): LiveEnvironment {
  const tempC = overrides.tempC ?? 38;
  const humidity = overrides.humidity ?? 62;
  const aqi = overrides.aqi === undefined ? 168 : overrides.aqi;
  const heatIndexC = computeHeatIndexC(tempC, humidity);

  return {
    location: 'Chennai',
    coordinates: { latitude: 13.08, longitude: 80.27 },
    locationSource: 'device',
    observedAt: FIXTURE_NOW - FIXTURE_OBSERVATION_AGE_MS,
    fetchedAt: FIXTURE_NOW - FIXTURE_OBSERVATION_AGE_MS,
    tempC,
    humidity,
    heatIndexC,
    heatIndexBand: heatIndexC === null ? null : heatIndexBandForC(heatIndexC),
    aqi,
    aqiCategory: aqi === null ? null : aqiCategoryFor(aqi),
    aqiBasis: aqi === null ? null : 'pm2_5',
    pollutants: { pm2_5: 79.8, pm10: 90 },
    advisories: [],
    ...overrides,
  };
}
