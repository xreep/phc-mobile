/**
 * Sensor ingestion (PRD §7.2.1) — public surface.
 *
 * The provider and hook are imported from their own modules (`@/sensors/provider`,
 * `@/hooks/use-sensors`) so a test can mock the context without pulling native modules in.
 */

export { HEALTH_CONNECT_SOURCE } from './health-connect';
export type { SensorFailure, SensorFailureKind, SensorFeed, SensorFeedStatus } from './types';
