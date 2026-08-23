/**
 * Community View (PRD §4, ASHA persona) — public surface.
 *
 * A **concept demonstration**: opt-in, anonymized area counts computed from a fixed local
 * cohort. There is no backend and no upload path — see `./demo-cohort.ts`.
 *
 * Like `@/risk`, this module is framework-agnostic and side-effect free: no React, no clock, no
 * I/O, no module state. `now` is an argument, which is what lets the screen and its tests agree
 * on a window.
 */

export {
  COMMUNITY_CATEGORY_ORDER,
  DEFAULT_COMMUNITY_WINDOW_MS,
  MIN_REPORTABLE_COUNT,
  publishedTallies,
  summarizeCommunity,
  withheldTallies,
  type SummarizeOptions,
} from './aggregate';

export {
  DEMO_AREA,
  DEMO_NEIGHBOURING_AREA,
  DEMO_PARTICIPANT_COUNT,
  demoReports,
} from './demo-cohort';

export type { AnonymizedReport, CategoryTally, CommunitySummary } from './types';
