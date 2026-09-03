import { setPendingDeepLink } from '@/lib/deep-link-launch';

/**
 * The one safe Open agents action: stash the Agents tab destination through
 * the existing pending-deep-link gate, which runs after auth and startup
 * gates clear. `universal-link` always wins over a stale notification
 * response, so a user tap takes precedence. Do not call `router.navigate`
 * here — navigation must flow through the gate, not bypass it.
 */
export function openGlanceableAgents(): void {
  setPendingDeepLink('/(app)/(tabs)/(2_agents)', 'universal-link');
}
