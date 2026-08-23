/**
 * Shared display formatting.
 *
 * `formatAge` lives here rather than in a screen because two screens show an age — the
 * Dashboard for the newest sensor reading, the Environment screen for the weather
 * observation — and two copies would inevitably word the same interval differently.
 */

/**
 * Coarse relative age.
 *
 * Rounded to the unit being shown rather than to the nearest minute throughout, so a
 * 30-second-old reading reads "30s ago" instead of collapsing to "0 min ago". Hours are
 * spelled out because a cached observation can legitimately be that old offline, and
 * "97 min ago" is harder to judge at a glance than "2 hr ago".
 *
 * A negative age means the timestamp is ahead of the clock — a provider's observation time
 * skewed against the device clock, most often. Reported as "just now" rather than as a
 * negative interval, since the honest reading of "3 seconds in the future" is "current".
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 min ago' : `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hr ago' : `${hours} hr ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
