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
- `.env.local` with `EXPO_PUBLIC_OPENWEATHER_API_KEY` set (and `EXPO_PUBLIC_SOS_RELAY_URL` if the
  relay step below is included; the legacy `EXPO_PUBLIC_TWILIO_SOS_URL` is still read).

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
- If `EXPO_PUBLIC_SOS_RELAY_URL` is set and the relay is deployed: a contact linked from Settings
  (Edit contact → Link Telegram → the second phone taps the link and presses Start → "Linked ✓" →
  Save) receives the alert on Telegram, and the overlay reads "Sent to <name> via Telegram"; with a
  working SMS gateway the second phone also receives an SMS with vitals and a maps link.
- If not configured, or the relay returns non-2xx: the native SMS composer opens, pre-filled,
  addressed to each contact in turn.

### 5. Airplane-mode test
Enable airplane mode on the test phone, then trigger a critical event. Confirm:
- The rule engine still evaluates correctly (it has no network dependency).
- The SOS flow falls back to the native SMS composer (which can still queue over cellular SMS even
  with data/Wi-Fi disabled, depending on device — record what actually happens).
- The Environment screen shows the cached weather with a "cached" badge rather than an error state,
  as long as the cache has not exceeded its 60-minute staleness bound.


### Findings from the 2026-09-20 run

- **Live AQI advisory validated incidentally:** local AQI 177 (EPA Unhealthy) turned the Respiratory card *Caution* before any SpO₂ record existed — the advisory precursor merged in PR #6, on real air-quality data.
- **Notifications bug found and fixed (PR pending):** `expo-notifications` suppresses notifications that arrive while the app is in the foreground unless a handler is registered; with foreground-only sensing every alert fires in the foreground, so none was ever shown. `ensureAlertChannels` now registers a banner+list handler; after the fix the red-respiratory notification appeared on the device.
- **Notification permission was `denied` on first run** (Android 13+ runtime permission); enabling it from App info → Notifications was picked up on the next foreground without a restart (the provider's AppState re-read).
- **Toolbox timestamp pitfall:** Toolbox pre-fills the start time when its form is opened; two records were written with 37–41-minute-old timestamps and were (correctly) outside the retention window. Set the time *last*, to the phone's current clock.

## Results

**Left empty intentionally — fill in only when each step is actually run on a device.**

| Step | Device / OS | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 1. EAS build install | Android 15 phone (user's) | 2026-09-20 | ✅ PASS | EAS build `5b4de821` (dev client, cloud keystore). Installed from the artifact link; connected to Metro over tunnel; Dashboard rendered on simulated source. |
| 2. HC Toolbox — HeartRate | Android 15 | 2026-09-20 | ✅ PASS | `HeartRateSeries` 72 bpm written by Toolbox appeared in the vitals row within one poll; subtitle `Updated 0s ago · Android Health Connect`. A record stamped 41 min earlier was correctly ignored (outside the 20-min retention window). |
| 2. HC Toolbox — OxygenSaturation critical | Android 15 | 2026-09-20 | 🟡 PARTIAL | SpO₂ 91 % read → Respiratory **Alert** (flag `respiratory.spo2.low`) with metric `SpO₂ 91% · AQI 177 (Unhealthy)`. The *critical* path (< 85 % ×2 → SOS countdown) not yet exercised. |
| 2. HC Toolbox — SkinTemperature (with baseline) | Android 15 | 2026-09-20 | ⬜ NOT RUN | Permission listed and granted; no record written yet. |
| 2. HC Toolbox — SkinTemperature (no baseline) | | | | |
| 3. Compatibility — Android 14 | | | | |
| 3. Compatibility — Android 15 | Android 15 | 2026-09-20 | ✅ PASS | Permission sheet listed **Heart rate, Blood oxygen, Skin temperature**; all granted; `getSdkStatus`/`initialize`/`getGrantedPermissions`/`readVitals` ran without error. Sideloaded dev client visible to Health Connect. |
| 3. Compatibility — permission denied (partial grant) | | | | |
| 4. SOS — relay deployed | Cloudflare Worker + Android 15 phone (Telegram) | 2026-09-21 | 🟡 PARTIAL | Relay live; Telegram link + delivery validated end to end by hand (`curl`). **App-side dispatch + Telegram linking (M5 part 1b, PR #22) merged** but not yet exercised on a phone — the on-phone test (dev build with `EXPO_PUBLIC_SOS_RELAY_URL` set, one contact linked from Settings, one SOS reaching a second phone on Telegram) is next, pending the new EAS build. Textbelt: free SMS blocked for India (502 → composer fallback behaves correctly). |
| 4. SOS — composer fallback | | | | |
| 5. Airplane mode — engine | | | | |
| 5. Airplane mode — SOS fallback | | | | |
| 5. Airplane mode — cached weather | | | | |
