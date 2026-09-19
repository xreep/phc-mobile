# ADR-001: Local-first health data

## Status
Accepted — reflected in the shipped architecture (`src/risk/`, `src/sensors/`, `src/environment/`,
`src/sos/`). See [`docs/architecture/overview.md`](../architecture/overview.md).

## Context
PS 26181 asks for a "secure, AI-powered Personal Health Companion" that delivers "real-time,
privacy-preserving health monitoring." The PRD's Goal G2 states "no raw health data leaving the phone
by default." Vitals (HR, SpO₂, skin temperature) and motion are the most sensitive data this app
handles.

## Problem
Where should the risk assessment run, and where should vitals be stored or transmitted, given the
privacy requirement and the disaster-resilience use case (which implies the app must keep working
when connectivity is poor or absent)?

## Options
1. **Cloud-first** — stream vitals to a backend, run inference server-side, push results back.
2. **Local-first** — all vitals stay on the device; only coarse-location weather requests and the
   SOS message leave it.
3. **Hybrid** — local inference, with an opt-in cloud sync for backup/history.

## Decision
Local-first (Option 2). `src/risk/` is a pure, clock-free module with no network or storage
dependency; it takes readings and an environment snapshot and returns a score. The only network
calls anywhere in the app are OpenWeatherMap requests (coarse location) and the SOS SMS path (one
POST per contact to a relay, or the native SMS composer). No vital reading, in any code path, is ever
transmitted or written to a server.

## Reason
- Disaster scenarios (the PS's stated focus — heat waves, floods, cyclones) are exactly when
  connectivity is least reliable; a cloud dependency for the core risk logic would make the app
  least available when it matters most.
- A backend that receives vitals is an attack surface and a liability the team does not need to carry
  for an MVP; "no server holds vitals" is a stronger privacy story than "a server holds vitals
  encrypted and access-controlled."
- It is directly testable: the engine has ~600 tests and runs identically in Jest and on a phone,
  because it never depends on a network or a clock.

## Consequences
- No cross-device history or backup exists — if the phone is lost, all history (once persistence
  ships) is lost with it.
- No aggregate/population view is possible without a deliberate, separate, privacy-preserving
  channel — this is why the Community module's future real data path (Phase 4, see
  `docs/ROADMAP.md`) is designed as an opt-in, k-anonymity-floored aggregate, not a raw-data upload.
- Every new "smart" feature (Tier-2 anomaly detection, baselines) must be buildable on-device;
  ADR-002 extends this same principle to how AI is chosen.

## Alternatives rejected
- **Cloud-first** — rejected outright: it inverts the PS's privacy requirement and introduces a
  single point of failure during the exact outages the app targets.
- **Hybrid with opt-in cloud sync** — not rejected in principle, but explicitly out of scope for this
  build (see `PRD.md` NG4, "not a fully HIPAA/DPDP-certified data pipeline"); any future sync would
  need its own privacy review, not a default-on assumption.
