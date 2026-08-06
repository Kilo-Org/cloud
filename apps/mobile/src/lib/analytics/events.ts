/**
 * Mobile-side bindings for the shared analytics event contract
 * (`@kilocode/app-shared/analytics`, P1-A-07a / DEC-05).
 *
 * Event names, payload schemas, and the phase classification come from the
 * shared map; this file is the stable mobile import surface and adds the
 * mobile type alias `AnalyticsSurface` that legacy call sites use.
 * `posthog.ts` re-exports these names so existing `@/lib/analytics/posthog`
 * imports keep working unchanged.
 */
import { type ANALYTICS_SURFACES } from '@kilocode/app-shared/analytics';

export * from '@kilocode/app-shared/analytics';

/** Legacy mobile surface values (existing payloads, unchanged). */
export type AnalyticsSurface = (typeof ANALYTICS_SURFACES)[number];
