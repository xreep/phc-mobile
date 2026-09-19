# ADR-004: Android Health Connect as the sensing layer

## Status
Accepted — reflected in `src/sensors/`, `hooks/use-sensors.ts`. Based on the approved design spec
[`docs/superpowers/specs/2026-09-15-health-connect-sensor-ingestion-design.md`](../superpowers/specs/2026-09-15-health-connect-sensor-ingestion-design.md).
**Implementation status:** unit-tested against mocked native modules; never run against a real
Health Connect instance (see `docs/PROJECT_STATUS.md`).

## Context
PRD Goal G1 and PS area 8 require ingesting vitals (HR, SpO₂, body temperature, motion) from
"existing wearable/phone sensors ... no custom medical hardware required for MVP." The team has no
guarantee of what band a judge or a demo device will have paired.

## Problem
How does the app get vitals off whatever wearable a user already owns, without writing a
band-specific integration for every possible device, and without requiring hardware the team may not
have at demo time?

## Options
1. **Android Health Connect** — a single OS-level data store that most fitness/health apps and bands
   already write to; read from it once, support any compatible band transparently.
2. **Direct BLE integration per band** (e.g. GATT profiles for specific watches).
3. **Custom hardware (ESP32) as the primary sensing path.**
4. **Simulated data only** — no real sensing for the MVP.

## Decision
Option 1, with Option 4 kept as a permanent, explicitly labelled fallback (not a stepping stone to be
removed) and Option 3 deferred to "only if a teammate already has the hardware" (PRD, audit §F).
`src/sensors/health-connect.ts` reads `HeartRate`, `OxygenSaturation`, and `SkinTemperature` (only
when a baseline is present, since Health Connect stores it as deltas) every 60 seconds over the
buffer's retention window; `src/sensors/motion.ts` folds the phone's own accelerometer into a
per-minute `MotionSummary` for the fall/stillness rules. Both map into the single `SensorReading`
schema before the rule engine ever sees them. Settings → Sensor source gates which feed is active,
defaulting to `simulated`.

## Reason
- **One integration, many bands.** Health Connect is the adapter; any companion app that already
  writes to it (most commercial bands and watches) works without band-specific code. Adding BLE later
  is "write one more adapter into `SensorReading`," not a rewrite (audit §C, "What is good").
- **Demo-day risk management.** A judge's phone or the demo device may have no paired band and no
  Health Connect data at all — this is exactly why the picker keeps `simulated` as the default and
  why Health Connect is opt-in per PRD §12.
- **No custom hardware dependency for the core promise.** ESP32/BLE stays a stretch demonstration of
  hardware credibility (PRD §6.2), not something the sensing layer depends on.
- **Full-window polling, not delta polling.** Companion apps sync in batches minutes after
  measurement, keeping original timestamps; the design amends an earlier "read since last poll"
  approach to "always read the full retention window," because a delta read would silently miss
  late-arriving, correctly-timestamped samples. The ring buffer deduplicates the resulting overlap.

## Consequences
- The sensing layer's correctness has been proven only against mocked native modules
  (`jest/setup-after-env.js` inert mocks with per-test overrides) — it has never touched a real
  Health Connect instance, so device-specific quirks (permission sheet behaviour, `SkinTemperature`
  availability below Health Connect 1.1, batch-sync latency) are unverified. This is the single
  largest gap between "well-tested" and "known to work," and is M1/M2 in `docs/ROADMAP.md`.
- Sensing is foreground-only: the polling hook and accelerometer fold run in React effects, and
  Android suspends JS timers when the app is backgrounded. A fall with the phone in a pocket, screen
  off, is not detected today (M8 in `docs/ROADMAP.md` — a foreground service is required to change
  this, and is explicitly a native-work item with the highest engineering risk in Phase 2).
- `minSdkVersion` is raised to 26 (Android 8.0) by `react-native-health-connect`, so Android 7.x
  devices cannot run this app at all.
- An engine fix was required to make this design viable: `longestStillRunMs` / `trailingStillRunMs`
  previously broke a still-run on any reading without motion data, which made the fall and
  heat-stillness rules unsatisfiable once HR samples were interleaved between per-minute motion
  readings — the real shape Health Connect ingestion produces. The rules now skip motion-less
  readings instead of breaking on them (still bounded by the existing gap check).

## Alternatives rejected
- **Direct per-band BLE integration** — rejected as the primary path: it would require a separate,
  ongoing integration per device model, which does not scale to "whatever a judge happens to be
  wearing," and Health Connect already solves this for any band whose companion app participates.
- **Custom hardware (ESP32) as primary** — rejected as primary: dependent on a specific teammate
  having built and brought the board; kept only as an optional, clearly-labelled hardware
  demonstration, never load-bearing for the core sensing story.
- **Simulated-only, no real sensing** — rejected as the *only* path (it remains the default demo
  fallback): it cannot demonstrate the PS's "continuous monitoring" claim at all, which is why Health
  Connect ingestion was built despite being unvalidated on a device as of this writing.
