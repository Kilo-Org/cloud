/**
 * Shared constants for the morning briefing interests feature.
 *
 * Lives under `lib/kiloclaw/` (not the components directory) so that
 * server-side tRPC routers can import it without creating an upward
 * dependency from `routers/` into `app/.../components/`.
 *
 * Consumers:
 * - `app/(app)/claw/components/InterestsStep.tsx` (onboarding step)
 * - `app/(app)/claw/components/SettingsTab.tsx` (settings editor)
 * - `app/(app)/claw/components/ClawOnboardingFlow.tsx` (admin/version gate)
 * - `routers/kiloclaw-router.ts` (personal tRPC mutation)
 * - `routers/organizations/organization-kiloclaw-router.ts` (org tRPC mutation)
 *
 * The kiloclaw worker (`services/kiloclaw/src/routes/platform.ts`) and
 * the morning-briefing plugin
 * (`services/kiloclaw/plugins/kiloclaw-morning-briefing/src/index.ts`)
 * are across the service boundary; they keep their own copies of the
 * caps and reference this file by name in their "keep in sync" comments.
 */

/**
 * Preset topic options offered in the Interests step + Settings editor.
 * Users may select any subset and add their own free-text entries; the
 * union is what gets persisted as `interest_topics` on
 * `kiloclaw_morning_briefing_configs`.
 *
 * To extend: append to the list. Order is the display order. The label
 * IS the persisted value — keep stable spellings to avoid duplicate
 * entries (e.g. don't rename "Local News" to "News").
 */
export const INTEREST_TOPIC_PRESETS = [
  'Tech',
  'AI',
  'Finance',
  'Health',
  'Startups',
  'Markets',
  'Science',
  'Design',
  'Local News',
  'Sports',
] as const;

export type InterestTopicPreset = (typeof INTEREST_TOPIC_PRESETS)[number];

/**
 * Caps for the interest_topics list + per-topic length. Mirrored by:
 * - `services/kiloclaw/src/routes/platform.ts` (`MorningBriefingInterestsSchema`)
 * - `services/kiloclaw/plugins/kiloclaw-morning-briefing/src/index.ts`
 *   (`MAX_INTEREST_TOPICS` / `MAX_INTEREST_TOPIC_LENGTH`)
 *
 * If you change either cap here, update both worker copies too.
 */
export const MORNING_BRIEFING_INTERESTS_MAX_TOPICS = 20;
export const MORNING_BRIEFING_INTERESTS_MAX_TOPIC_LENGTH = 64;

/**
 * Minimum kiloclaw controller calver that includes the
 * `/api/plugins/kiloclaw-morning-briefing/interests` plugin route.
 *
 * Compared against `controllerVersion.version` from `/_kilo/version`
 * (the kiloclaw controller binary's own calver — NOT `openclawVersion`,
 * which is the runtime and can drift if the user upgrades OpenClaw
 * inside their container). The morning-briefing plugin is bundled into
 * the kiloclaw container image alongside the controller binary, so the
 * controller version is the reliable proxy for "does this image carry
 * the new plugin route?"
 *
 * Older instances do NOT have this route — the worker's
 * `controller_route_unavailable` 404 is the backstop, but proactive UI
 * gates (Settings editor + onboarding step) should also hide the
 * controls so users on stale images don't try to save and hit a 404.
 *
 * Follows the same controller-version capability-gate pattern as
 * `EXA_SEARCH_UI_MIN_CONTROLLER_VERSION` and
 * `OPENCLAW_IMPORT_UI_MIN_CONTROLLER_VERSION` in `SettingsTab.tsx`.
 * (Distinct from `MEMORY_MIN_OPENCLAW_VERSION`, which gates on the
 * OpenClaw runtime version because that feature lives in OpenClaw, not
 * in a baked-in plugin.)
 *
 * Set to the UTC calendar date the kiloclaw controller image that
 * carries the new `/interests` route is first built. The controller's
 * calver is stamped at Docker build time as `YYYY.M.D.HHMM` (see
 * `services/kiloclaw/controller/src/version.ts`), so any image built
 * on this date or later compares `>=` to this constant under
 * `calverAtLeast` (e.g. `2026.5.12.1430 >= 2026.5.12.0` ✓), and any
 * image built strictly before this date compares `<` and is hidden
 * behind the upgrade prompt.
 *
 * Bump this constant if the rollout date slips past `2026.5.12`; an
 * over-old constant lets admins on a pre-feature image hit
 * `controller_route_unavailable` on save (caught and toasted, but a
 * worse UX than seeing the upgrade prompt).
 */
export const MORNING_BRIEFING_INTERESTS_MIN_CONTROLLER_VERSION = '2026.5.12';
