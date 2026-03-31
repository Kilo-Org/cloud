# Product Analytics Improvements

## Goal

Close the largest gaps in product analytics instrumentation so the growth and product teams can measure activation funnels and feature adoption without relying on backend-only data or ad-hoc Snowflake queries.

## Recommendation

Execute the three phases below in order. Phase 1 (event infrastructure) is a one-time setup that unblocks everything else. Phase 2 (activation funnel) directly enables conversion optimization, the highest-leverage PLG investment. Phase 3 (product surface events) fills the remaining blind spots.

Do **not** try to instrument every possible interaction. Instrument the decision points: the moments where a user commits to a next step or abandons. Clicks on static UI elements are already covered by PostHog autocapture.

## Current State

### What exists

- **PostHog client-side**: Provider in `src/components/PostHogProvider.tsx` with manual `$pageview` capture, user identification by email, alias linking, feature flags, session recording, and autocapture.
- **PostHog server-side**: Singleton in `src/lib/posthog.ts` with immediate flush. Used for ~30 server events (auth, billing, security agent, code indexing).
- **KiloClaw**: 16+ client-side events covering the full instance lifecycle (`claw_create_instance_clicked`, `claw_save_config_clicked`, etc.), the most thoroughly instrumented product surface.
- **Cloudflare Analytics Engine**: 5 datasets across KiloClaw, Gastown, and O11y workers for infrastructure telemetry.
- **DataLayer**: `src/components/DataLayerProvider.tsx` pushes email/name/is_new_user for GTM.

### What is missing

| Gap                                                                                             | Impact                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **No activation funnel events**: welcome pages, repo connection, first session have no tracking | Cannot measure or optimize signup-to-value path               |
| **Cloud Agent, Code Review, App Builder have zero client events**                               | Three priority products are invisible in product analytics    |
| **Inconsistent `organizationId`** on client events                                              | Cannot segment product usage by org without server-side joins |
| **Inconsistent `distinctId`**: email in some server events, `kilo_user_id` in others            | Identity fragmentation in PostHog                             |

---

## Phase 1: Event Infrastructure

No product behavior changes. Low risk. Provides the foundation for Phases 2 and 3.

### 1a. Standardize `distinctId` on server-side events

Several server-side events use `kilo_user_id` as `distinctId` while most use email. This causes identity fragmentation in PostHog.

**Rule:** Always use `user.google_user_email` as `distinctId` for server-side captures. The alias call in `src/lib/user.ts:363` already links email to user ID, so PostHog can resolve either, but mixing them as primary identifiers creates unnecessary merge complexity.

Audit and fix:

- `src/lib/stytch.ts:150` — uses `kilo_user_id` for the `stytch_created_db` event. Change to email (available as `google_user_email` on the user object passed to this function).

### 1b. Create a shared capture helper

To prevent Phase 2 and 3 events from being inconsistently instrumented, add a thin wrapper:

**File:** `src/lib/analytics.ts` (new)

```typescript
import posthog from 'posthog-js';

type EventProperties = Record<string, unknown>;

/**
 * Capture a client-side event.
 * Exists to establish a convention and a single place to add
 * enrichment later (e.g., current product surface, session type).
 */
export function captureEvent(eventName: string, properties?: EventProperties) {
  posthog.capture(eventName, properties);
}
```

This is deliberately thin: it exists to establish a convention, not to abstract PostHog away. If additional enrichment is needed later, it can be added here once.

**Risk:** None.

---

## Phase 2: Activation Funnel Instrumentation

Instrument the signup-to-value path. These events define the funnel that the growth team optimizes.

### Activation model

The PLG activation path for Kilo Code has two tracks:

**Personal track:**

1. `user_created` (exists — `src/lib/user.ts:340`)
2. `welcome_page_viewed` (new — `src/app/welcome/page.tsx`)
3. `install_method_selected` (new — `src/components/WelcomeContent.tsx`, user clicks CLI or VS Code/JetBrains tab)
4. `first_usage` (exists — `src/lib/processUsage.ts:240`)
5. `first_microdollar_usage` (exists — `src/lib/processUsage.ts:273`)

**Organization track:**

1. `start_free_trial` (exists — `src/routers/organizations/organization-router.ts:153`)
2. `organization_created` (exists — `src/lib/organizations/organization-seats.ts:375`)
3. `org_welcome_page_viewed` (new)
4. `org_welcome_action_clicked` (new — which card: install / invite / buy credits)
5. `organization_member_invited` (exists — client-side in `InviteMemberDialog.tsx:146`)
6. `first_usage` with org context (exists, but not all org usage flows include `organizationId`)

### 2a. Personal welcome page — `src/app/welcome/page.tsx` + `src/components/WelcomeContent.tsx`

These files currently have zero PostHog captures.

Add to `WelcomeContent.tsx`:

- `welcome_page_viewed` — on mount. Properties: `{ is_new_user: boolean }`.
- `install_method_selected` — when user clicks a tab (CLI / VS Code / JetBrains). Properties: `{ method: 'cli' | 'vscode' | 'jetbrains' }`.
- `welcome_link_clicked` — when user clicks an install/marketplace link. Properties: `{ target: 'cli_install' | 'vscode_marketplace' | 'jetbrains_marketplace' }`.

**Risk:** None. Read-only UI instrumentation.

### 2b. Organization welcome page — `src/app/(app)/organizations/[id]/welcome/page.tsx`

Currently zero PostHog captures. The page shows three cards: Install, Invite, Buy Credits.

Add:

- `org_welcome_page_viewed` — on mount. Properties: `{ organizationId }`.
- `org_welcome_action_clicked` — when user clicks a card CTA. Properties: `{ organizationId, action: 'install' | 'invite_member' | 'buy_credits' }`.

### 2c. First product interaction events

The gap between "user signed up" and "first_usage" is currently invisible. The user must install an extension/CLI, configure it, and start a session before `first_usage` fires. We cannot instrument the extension/CLI from this repo, but we can instrument the web touchpoints that lead there:

- **API key creation** — when a user creates an API key for CLI/extension use. Find the API key creation endpoint and add a server-side `api_key_created` event. Properties: `{ key_type, organizationId }`.
- **Repository connected** — when a user connects a GitHub/GitLab repo for code reviews or cloud agent. Add `repository_connected` at the point where the integration is saved. Properties: `{ platform: 'github' | 'gitlab', organizationId }`.

These fill the "configured but not yet active" segment of the funnel.

**Risk:** Low. Server-side events on write paths.

---

## Phase 3: Core Product Surface Events

Instrument the three product surfaces that currently have zero client-side analytics: Cloud Agent, Code Review, and App Builder. Follow the KiloClaw pattern: track decision points, not every click.

### 3a. Cloud Agent — `src/components/cloud-agent-next/NewSessionPanel.tsx`

This 900-line component is the primary Cloud Agent interaction surface. Zero PostHog captures.

Add:
| Event | Trigger | Properties |
|-------|---------|------------|
| `cloud_agent_session_started` | User submits a new session (form submit) | `model`, `mode`, `has_repo`, `organizationId` |
| `cloud_agent_repo_selected` | User selects a repository in the session form | `repo_source` (github/gitlab), `organizationId` |
| `cloud_agent_model_changed` | User changes model selection | `model`, `previous_model` |

On the sessions list page (`src/app/(app)/cloud/sessions/`):
| Event | Trigger | Properties |
|-------|---------|------------|
| `cloud_agent_session_opened` | User clicks into an existing session | `session_id`, `organizationId` |

### 3b. Code Review — `src/app/(app)/code-reviews/ReviewAgentPageClient.tsx`

269-line component, zero PostHog captures.

Add:
| Event | Trigger | Properties |
|-------|---------|------------|
| `code_review_configured` | User saves review configuration | `platform` (github/gitlab), `organizationId` |
| `code_review_integration_connected` | User completes GitHub/GitLab integration setup | `platform`, `organizationId` |
| `code_review_job_viewed` | User opens a specific review result | `review_id`, `organizationId` |

### 3c. App Builder — `src/components/app-builder/AppBuilderPage.tsx`

81-line component routing to landing or project view, zero PostHog captures.

Add:
| Event | Trigger | Properties |
|-------|---------|------------|
| `app_builder_project_created` | User starts a new project | `organizationId` |
| `app_builder_message_sent` | User sends a prompt in the chat pane | `organizationId`, `has_existing_project: boolean` |
| `app_builder_deployed` | User deploys the app | `organizationId` |

### 3d. Sidebar navigation clicks

The sidebar (`PersonalAppSidebar.tsx`, `OrganizationAppSidebar.tsx`) has zero click tracking beyond autocapture. PostHog autocapture will pick up clicks on sidebar items, but the element text may not be stable enough for reliable analysis.

**Recommendation:** Do not add manual events here. PostHog autocapture + the manual `$pageview` already covers navigation. If sidebar click analysis is needed, use PostHog's toolbar to create actions from autocaptured elements rather than adding code.

---

## Phase 4: Future Improvements (Out of Scope)

These are valuable but lower priority. Defer until Phases 1–3 are validated.

| Improvement                                                                             | Rationale                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker-level lifecycle events** (cloud-agent, app-builder, code-review-infra workers) | 15+ workers have zero analytics. Even `task_started` / `task_completed` / `task_failed` with duration would close major server-side visibility gaps. Requires adding PostHog HTTP calls to Cloudflare Workers (same pattern as KiloClaw controller in `kiloclaw/src/routes/controller.ts:149`).                                                                                                         |
| **Event naming taxonomy**                                                               | Current names mix conventions (`start_free_trial` vs `claw_trial_started`). Adopt `product_action` format consistently (e.g., `cloud_agent_session_started`, `code_review_configured`). Phase 2 and 3 events above already follow this convention.                                                                                                                                                      |
| **Cross-domain identity resolution**                                                    | Marketing landing pages (kilo.ai) and app (app.kilo.ai) use separate PostHog anonymous IDs. PostHog supports cross-subdomain tracking via `cross_subdomain_cookie: true`, but this only works for subdomains of the same root domain. If marketing pages are on a different domain entirely, server-side identity linking via the backend (e.g., passing a token through the redirect URL) is required. |
| **Expansion tracking**                                                                  | Events for invite accepted, seat count changed, plan upgrade completed (not just clicked), BYOK key added. These answer "how do orgs grow?"                                                                                                                                                                                                                                                             |
| **DataLayer enrichment**                                                                | `src/components/DataLayerProvider.tsx` pushes email/name/is_new_user only. Add `organizationId`, `plan`, `created_at` for richer GTM attribution.                                                                                                                                                                                                                                                       |

## Success Criteria

### Phase 1

- No server-side event uses `kilo_user_id` as `distinctId`.
- `src/lib/analytics.ts` exists and is used by all new Phase 2/3 events.

### Phase 2

- A PostHog funnel from `user_created` → `welcome_page_viewed` → `install_method_selected` → `first_usage` can be built and shows non-zero conversion at each step.
- Org activation funnel from `start_free_trial` → `org_welcome_page_viewed` → `org_welcome_action_clicked` → `first_usage` is buildable.
- Dropoff between steps is visible and actionable.

### Phase 3

- Cloud Agent, Code Review, and App Builder each have at least 2 client-side events visible in PostHog Live Events within 24 hours of deploy.
- Feature adoption can be measured per-product without relying on `microdollar_usage` as the only signal.
- Product funnels (e.g., Code Review: `code_review_integration_connected` → `code_review_configured` → `code_review_job_viewed`) can be built in PostHog.
