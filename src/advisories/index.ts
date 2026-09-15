/**
 * Static preparedness advisories — public surface.
 *
 * Framework-agnostic and side-effect free, on the same terms as `@/risk` and `@/community`: no
 * React, no clock, no I/O, no module state. Unlike those two it does not compute anything at all —
 * it is fixed reference text, and `./preparedness.ts` explains why that is the design rather than
 * a placeholder for a live hazard feed.
 */

export {
  PREPAREDNESS_ADVISORIES,
  PREPAREDNESS_BADGE,
  PREPAREDNESS_DISCLAIMER,
  PREPAREDNESS_HEADING,
  PREPAREDNESS_INTRO,
  stepCount,
  type AdvisorySection,
  type PreparednessAdvisory,
  type PreparednessHazard,
} from './preparedness';
