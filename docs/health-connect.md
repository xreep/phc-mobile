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

`react-native-health-connect` raises `minSdkVersion` to 26 (Android 8.0), so Android 7.x devices
are no longer supported. Prebuild writes that value into `android/gradle.properties`.

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
longer than that. Every poll re-reads the whole retention window (`now − BUFFER_RETAIN_MS → now`)
rather than only what is new since the last poll: companion apps sync in batches minutes after
measurement, keeping the original sample timestamps, and a delta read would never see those
late-written samples. The ring buffer deduplicates the overlap. The buffer keeps
`longestLookbackMs + 2 min`, derived from the engine's thresholds, so every extended-lookback
rule sees a full window.

## Demoing a fall on live data

In a development build the Dashboard's "Dev · Simulate a fall" control works on the live buffer
too: it splices a real impact-then-stillness motion sequence onto the tail and lets
`rules/fall.ts` detect it. Vitals are untouched. While the control is on, the Dashboard subtitle
reads "Simulated data" rather than "Android Health Connect": the spliced tail is the newest
reading, and the subtitle names the source of whatever is newest.
