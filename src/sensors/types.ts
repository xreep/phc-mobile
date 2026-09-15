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
