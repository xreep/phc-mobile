# Device validation plan

## Status
Planned — Blocked on an EAS/Expo account, a physical Android phone (or emulator with Health Connect
+ the Health Connect Toolbox app), and a deployed Twilio relay (or a second phone for the SMS
composer fallback test). Nothing in this document has been run yet; the results table at the bottom
is intentionally left empty and must not be pre-filled.

This is the step-by-step protocol for reaching Level 4 (Device) on
[`docs/testing/validation-levels.md`](../testing/validation-levels.md) for the sensing and SOS paths —
the biggest gap identified in `docs/prototype-audit-2026-09-19.md` §H/§K.

## Prerequisites

- An Expo/EAS account with access to this project (`eas.json` defines the `development` profile).
- A physical Android phone, Android 14 or 15, with Google Play Services and the Health Connect app
  installed (built into Android 14+; installable from Play Store on 13).
- The **Health Connect Toolbox** app (or a real band/watch whose companion app writes to Health
  Connect), to insert HR/SpO₂/skin-temperature records without needing a physical wearable.
- A second phone, to receive the SOS SMS.
- `.env.local` with `EXPO_PUBLIC_OPENWEATHER_API_KEY` set (and `EXPO_PUBLIC_TWILIO_SOS_URL` if the
  relay step below is included).

## Protocol

### 1. Build and install the EAS development client
```
npx expo prebuild --platform android
eas build --profile development --platform android
```
Install the resulting APK on the test phone. Confirm the app launches and the Dashboard renders with
the default "Simulated data" source before touching Health Connect.

### 2. Health Connect Toolbox insertion
In Settings → Sensor source, switch to "Android Health Connect" and grant the requested permissions
(`READ_HEART_RATE`, `READ_OXYGEN_SATURATION`, `READ_SKIN_TEMPERATURE`) when prompted. Using the
Health Connect Toolbox, insert:
- A `HeartRate` record (e.g. 78 bpm) → confirm it appears on the Dashboard vitals row within one poll
  cycle (60 s), with the "Updated Ns ago · Android Health Connect" subtitle.
- An `OxygenSaturation` record at 84% (below the critical threshold), twice, spaced to satisfy the
  rule's sustained-evidence requirement → confirm the respiratory card goes critical and the SOS
  countdown starts.
- A `SkinTemperature` record with a baseline set → confirm `skinTempC` renders. Repeat without a
  baseline → confirm no reading is emitted (per the design spec's "delta without baseline → no
  reading" rule) rather than a crash.

### 3. Health Connect compatibility matrix
Repeat the permission grant/deny flow on both an Android 14 and an Android 15 device (or emulator
image). For each OS version, record:
- Whether the permission sheet lists all three requested permissions correctly.
- Whether `SkinTemperature` is available at all (Health Connect version dependent) — if
  `readRecords('SkinTemperature')` throws, confirm whether the `Promise.all` failure degrades the
  whole poll to `status: 'error'` (the audit's unverified-since-launch concern) rather than dropping
  only the skin-temperature reading.
- Denying one permission (e.g. SpO₂) and confirming the app still reads the granted ones rather than
  failing entirely.

### 4. SOS second-phone test
With Health Connect delivering a critical vital (or using the dev "Simulate a fall" control), let the
SOS countdown lapse without cancelling. Confirm:
- If `EXPO_PUBLIC_TWILIO_SOS_URL` is set and the relay is deployed: the second phone receives an SMS
  with vitals and a maps link within a reasonable time.
- If not configured, or the relay returns non-2xx: the native SMS composer opens, pre-filled,
  addressed to each contact in turn.

### 5. Airplane-mode test
Enable airplane mode on the test phone, then trigger a critical event. Confirm:
- The rule engine still evaluates correctly (it has no network dependency).
- The SOS flow falls back to the native SMS composer (which can still queue over cellular SMS even
  with data/Wi-Fi disabled, depending on device — record what actually happens).
- The Environment screen shows the cached weather with a "cached" badge rather than an error state,
  as long as the cache has not exceeded its 60-minute staleness bound.

## Results

**Left empty intentionally — fill in only when each step is actually run on a device.**

| Step | Device / OS | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 1. EAS build install | | | | |
| 2. HC Toolbox — HeartRate | | | | |
| 2. HC Toolbox — OxygenSaturation critical | | | | |
| 2. HC Toolbox — SkinTemperature (with baseline) | | | | |
| 2. HC Toolbox — SkinTemperature (no baseline) | | | | |
| 3. Compatibility — Android 14 | | | | |
| 3. Compatibility — Android 15 | | | | |
| 3. Compatibility — permission denied (partial grant) | | | | |
| 4. SOS — relay deployed | | | | |
| 4. SOS — composer fallback | | | | |
| 5. Airplane mode — engine | | | | |
| 5. Airplane mode — SOS fallback | | | | |
| 5. Airplane mode — cached weather | | | | |
