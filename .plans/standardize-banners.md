# Standardize Banners Migration Plan

## Goal

Migrate all banner-like UI patterns across the frontend to use the shared `Banner` component (`src/components/shared/Banner.tsx`), establishing a single source of truth for colored informational/warning/error/success boxes.

## Current State

- **Shared Banner** already exists with 4 colors (emerald, amber, blue, red) and subcomponents: `Banner.Icon`, `Banner.Content`, `Banner.Title`, `Banner.Description`, `Banner.Action`, `Banner.Button`
- **3 files** already use the shared Banner (ProfileKiloClawBanner, DrainStatusBanner, InstanceControls)
- **6 named `*Banner.tsx` files** use hand-rolled divs or shadcn `<Alert>` instead
- **4 Card-based welcome/success headers** share an identical pattern with dismiss buttons
- **~40+ inline colored div boxes** scattered across ~25 files

## Exclusions (not migrating)

These patterns are structurally different from banners (status cards, interactive panels, or minimal error text):

| File                             | Reason                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| `SubscriptionCard.tsx`           | Status card with structured key-value layout                    |
| `EarlybirdCard.tsx`              | Status card with structured key-value layout                    |
| `PlanSelectionDialog.tsx`        | Interactive payment panel with form controls                    |
| `CreditsNudge.tsx`               | Interactive panel with amount selector grid                     |
| `SidebarRoleTestingDropdown.tsx` | Interactive panel with dropdown controls                        |
| `verify-magic-link/page.tsx`     | Minimal error text, no border/icon structure                    |
| `CreditPurchaseOptions.tsx`      | Neutral/gray scheme with `bg-background` — not a colored banner |

---

## Phase 0: Enhance the shared Banner component

Add capabilities needed by migration targets.

### 0a. Add `green` color variant

```ts
green: {
  border: 'border-green-500/30',
  bg: 'bg-green-500/10',
  text: 'text-green-400',
  button: 'bg-green-500 text-primary-foreground hover:bg-green-500/90',
},
```

Update `BannerColor` type to include `'green'`.

### 0b. Add `Banner.Dismiss` subcomponent

A close/X button that sits at the trailing edge of the banner:

```tsx
function BannerDismiss({ onDismiss, className }: { onDismiss: () => void; className?: string }) {
  return (
    <button
      onClick={onDismiss}
      className={cn(
        'shrink-0 rounded-full p-1 opacity-70 transition-opacity hover:opacity-100',
        className
      )}
      aria-label="Dismiss"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
```

Export as `Banner.Dismiss`.

---

## Phase 1: Named `*Banner.tsx` files (6 files)

These are the highest priority — they're explicitly "banner" components but don't use the shared Banner.

### 1a. `src/app/(app)/claw/components/billing/BillingBanner.tsx`

**Current:** Hand-rolled `<div>` with color scheme mapping (blue/amber/red), icon, title, description, optional CTA button.

**Migration:** Replace div structure with Banner subcomponents. The `getBannerStyles` function maps directly to Banner colors:

- `trial_active` / `subscription_converting` → `color="blue"`
- `trial_ending_soon` / `earlybird_ending_soon` / `subscription_canceling` → `color="amber"`
- `trial_ending_very_soon` / `trial_expires_today` / `subscription_past_due` → `color="red"`

Keep `getBannerContent`, `getBannerIcon`, and `handleCta` logic as-is; only replace the JSX.

### 1b. `src/components/cloud-agent-next/OldSessionBanner.tsx`

**Current:** `<Alert variant="warning">` with Info icon, title "Legacy Session", description, and "Start New Session" button.

**Migration:**

```tsx
<Banner color="amber">
  <Banner.Icon>
    <Info />
  </Banner.Icon>
  <Banner.Content>
    <Banner.Title>Legacy Session</Banner.Title>
    <Banner.Description>This is a legacy session...</Banner.Description>
  </Banner.Content>
  <Banner.Action>
    <Banner.Button onClick={onStartNewSession}>Start New Session</Banner.Button>
  </Banner.Action>
</Banner>
```

### 1c. `src/components/gastown/AdminViewingBanner.tsx`

**Current:** `<Alert variant="warning">` with amber light/dark overrides, ShieldAlert icon, title, description with inline `<code>` blocks.

**Migration:** `<Banner color="amber">` with Banner.Icon, Banner.Title, Banner.Description. The `<code>` blocks in the description content pass through as children — no structural issue.

### 1d. `src/components/cloud-agent-next/ErrorBanner.tsx`

**Current:** `<Alert variant="destructive">` with AlertCircle icon, title, description, Retry/Dismiss buttons, and absolute-positioned X close button.

**Migration:** `<Banner color="red">` with Banner.Icon, Banner.Title, Banner.Description. Retry/Dismiss buttons inside Banner.Action. Use `Banner.Dismiss` for the X button. Remove the absolute-positioned dismiss button in favor of the Banner.Dismiss subcomponent.

### 1e. `src/components/organizations/FreeTrialWarningBanner.tsx`

**Current:** Hand-rolled `<div>` with 6 state variants (blue, orange, red, gray). Uses `border-b` (bottom border only, not rounded). Has icon, title with days-left badge, description, and conditional "Upgrade Now" button.

**Migration:**

- `trial_active` → `color="blue"`
- `trial_ending_soon` → `color="amber"` (orange → amber is acceptable standardization)
- `trial_ending_very_soon` / `trial_expires_today` / `trial_expired_*` → `color="red"`
- `subscribed` → hide banner (this state effectively shouldn't show)

**Formatting change:** The current `border-b p-4` (bottom border, no rounding) becomes `rounded-xl border p-4` (standard Banner). This is an acceptable standardization trade-off.

### 1f. `src/components/shared/InsufficientBalanceBanner.tsx`

**Current:** Two variants (default and compact) with yellow/blue color schemes, icon, title with balance display, description, and "Add Credits" button.

**Migration (default variant):** `<Banner color="amber">` (yellow → amber) or `<Banner color="blue">` for the info scheme, with Banner.Icon, Banner.Content, Banner.Title (including the balance badge as children), Banner.Description, Banner.Button.

**Migration (compact variant):** Use Banner subcomponents with `className` overrides on `BannerRoot` to change the layout. Override BannerRoot with `flex-col` for vertical stacking. This is the most complex migration in Phase 1 — acceptable to keep a slightly custom inner layout while still using Banner for the container, colors, and subcomponents.

---

## Phase 2: Card-based welcome/success headers (4 files)

These all share an identical pattern: `<Card>` with colored border/bg, circular icon container, title, description, action buttons, and dismiss X. They can be migrated to Banner + Banner.Dismiss.

**Formatting change:** These currently use `<Card className="p-6">` with larger icons (h-10 w-10 in rounded-full circles) and `text-xl` titles. Migrating to Banner standardizes them to the smaller `p-4` / `text-sm` style. This is an acceptable trade-off for consistency.

### 2a. `src/components/organizations/OrganizationWelcomeHeader.tsx`

**Current:** Blue Card with inline SVG info icon, `text-xl` title, description, two action buttons (Open in vscode, Read documentation), dismiss X.

**Migration:** `<Banner color="blue">` + Banner.Icon + Banner.Content (Title, Description) + Banner.Action (buttons) + Banner.Dismiss.

### 2b. `src/components/organizations/NewOrganizationWelcomeHeader.tsx`

**Current:** Green Card with PartyPopper icon, `text-xl` title, description, two action buttons (Invite members, Contact), dismiss X. Also renders InviteMemberDialog.

**Migration:** `<Banner color="green">` + subcomponents + Banner.Dismiss. The InviteMemberDialog stays alongside the Banner.

### 2c. `src/components/organizations/OrganizationTopupSuccessHeader.tsx`

**Current:** Green Card with inline SVG checkmark icon, `text-xl` title only (no description), dismiss X.

**Migration:** `<Banner color="green">` + Banner.Icon (CheckCircle) + Banner.Content (Title only) + Banner.Dismiss.

### 2d. `src/components/profile/AccountLinkedSuccessHeader.tsx`

**Current:** Green Card with CheckCircle icon, title, description, dismiss X.

**Migration:** `<Banner color="green">` + subcomponents + Banner.Dismiss.

---

## Phase 3: Inline banner-like divs (~40 instances across ~25 files)

These are ad-hoc colored `<div>` elements with border/background/padding that convey status messages. Most are simple (description only or icon + description). Listed by area.

### Group A: Deployment settings (2 files, 4 instances)

**`src/components/deployments/PasswordSettings.tsx`**

- Line ~136: Red error → `<Banner color="red"><Banner.Content><Banner.Description>...</Banner.Description></Banner.Content></Banner>`
- Line ~146: Amber warning with title + description → `<Banner color="amber">` + Title + Description

**`src/components/deployments/EnvironmentSettings.tsx`**

- Line ~201: Red error → `<Banner color="red">` + Description
- Line ~212: Yellow warning with icon → `<Banner color="amber">` + Icon + Description

### Group B: Config forms (4 files, ~14 instances)

These share identical patterns for repo-loading states.

**`src/components/code-reviews/ReviewConfigForm.tsx`** (5 instances)

- Line ~663: Red error (failed to load repos) → `<Banner color="red">` + Description
- Line ~669: Yellow warning (GitHub not connected) → `<Banner color="amber">` + Description
- Line ~676: Yellow warning (no repos found) → `<Banner color="amber">` + Description
- Line ~914: Yellow important notice (copy secret) → `<Banner color="amber">` + Description
- Line ~971: Blue setup instructions with `<ol>` → `<Banner color="blue">` + Description (ol within children)

**`src/components/auto-triage/AutoTriageConfigForm.tsx`** (3 instances)

- Same red/yellow pattern as ReviewConfigForm

**`src/components/auto-fix/AutoFixConfigForm.tsx`** (3 instances)

- Same red/yellow pattern as ReviewConfigForm

**`src/components/security-agent/SecurityConfigForm.tsx`** (1 instance)

- Line ~490: Yellow warning → `<Banner color="amber">` + Description

### Group C: Security findings (2 files, 5 instances)

**`src/components/security-agent/ClearFindingsCard.tsx`** (1 instance)

- Line ~80: Yellow warning → `<Banner color="amber">` + Description

**`src/components/security-agent/FindingDetailDialog.tsx`** (4 instances)

- Lines ~335, ~463: Yellow "in progress" with Loader2 spinner → `<Banner color="amber">` + Icon(Loader2) + Description
- Lines ~344, ~492: Red "failed" with retry button → `<Banner color="red">` + Description + Button(Retry)

### Group D: Organization dialogs & subscription (4 files, ~6 instances)

**`src/components/organizations/subscription/BillingCycleChangeDialog.tsx`** (2 instances)

- Line ~116: Blue info with Calendar icon → `<Banner color="blue">` + Icon + Description
- Line ~134: Amber cost warning → `<Banner color="amber">` + Description

**`src/components/organizations/members/InviteMemberDialog.tsx`** (2 instances)

- Line ~259: Red error with inline SVG icon → `<Banner color="red">` + Icon(AlertCircle) + Description
- Line ~281: Amber seat warning → `<Banner color="amber">` + Description

**`src/components/organizations/subscription/SubscriptionOverviewCard.tsx`** (1 instance)

- Line ~308: Amber pending change with Clock icon and Cancel button → `<Banner color="amber">` + Icon + Description + Button

**`src/components/organizations/FreeTrialWarningDialog.tsx`** (1 instance)

- Line ~64: Red notice → `<Banner color="red">` + Description

### Group E: KiloClaw dialogs (2 files, 3 instances)

**`src/app/(app)/claw/components/StartKiloCliRunDialog.tsx`** (2 instances)

- Line ~114: Amber warning with AlertTriangle icon → `<Banner color="amber">` + Icon + Description
- Line ~151: Blue loading with Loader2 spinner → `<Banner color="blue">` + Icon + Description

**`src/app/(app)/claw/components/billing/AccessLockedDialog.tsx`** (1 instance)

- Line ~198: Red notice → `<Banner color="red">` + Description

### Group F: Cloud Agent & App Builder (5 files, ~8 instances)

**`src/components/cloud-agent-next/NewSessionPanel.tsx`** (1 instance)

- Line ~645: Yellow integration warning with icon, title, description, 2 action buttons → `<Banner color="amber">` + Icon + Title + Description + Action (two buttons)

**`src/components/cloud-agent-next/FeedbackDialog.tsx`** (1 instance)

- Line ~125: Red error → `<Banner color="red">` + Description

**`src/components/app-builder/MigrateToGitHubDialog.tsx`** (5 instances)

- Line ~262: Red error with AlertCircle → `<Banner color="red">` + Icon + Description
- Line ~271: Yellow warning with AlertCircle + title → `<Banner color="amber">` + Icon + Title + Description
- Line ~297: Blue info with Check icon → `<Banner color="blue">` + Icon + Title + Description
- Line ~381: Red error → `<Banner color="red">` + Icon + Description
- Line ~423: Green success with Check icon → `<Banner color="green">` + Icon + Title + Description

**`src/components/app-builder/FeedbackDialog.tsx`** (1 instance)

- Line ~154: Red error → `<Banner color="red">` + Description

**`src/components/app-builder/CloneDialog.tsx`** (1 instance)

- Line ~136: Red error → `<Banner color="red">` + Description

### Group G: Payment & Profile (2 files, 2 instances)

**`src/components/payment/FirstTopupBonusPromo.tsx`** (1 instance)

- Lines ~8-27: Blue with gradient background, title, multi-line description. **Formatting change:** gradient (`bg-linear-to-r from-blue-950 to-indigo-950`) → flat `bg-blue-500/10`. Acceptable standardization trade-off.

**`src/components/profile/kilo-pass/KiloPassBonusRampDialog.tsx`** (1 instance)

- Line ~173: Emerald notice → `<Banner color="emerald">` + Description

### Group H: Auth (2 files, 2 instances)

**`src/components/auth/AuthErrorNotification.tsx`** (1 instance)

- Lines ~71-89: Red error with inline SVG icon, title, description, dismiss X → `<Banner color="red">` + Icon(AlertCircle) + Title + Description + Banner.Dismiss

**`src/components/auth/sign-in/TurnstileView.tsx`** (1 instance)

- Line ~51: Red error → `<Banner color="red">` + Description

### Group I: App pages (3 files, 3 instances)

**`src/app/(app)/code-reviews/[reviewId]/CodeReviewDetailClient.tsx`** (1 instance)

- Line ~271: Red error → `<Banner color="red">` + Description

**`src/app/(app)/cloud/webhooks/[triggerId]/requests/WebhookRequestsContent.tsx`** (1 instance)

- Line ~592: Red error with title → `<Banner color="red">` + Title + Description

**`src/app/get-started/slack/_components/WorkspaceSelector.tsx`** (1 instance)

- Line ~208: Red error with AlertCircle in `<motion.div>` → Wrap `<Banner>` in `<motion.div>`: `<motion.div ...><Banner color="red">` + Icon + Description + `</Banner></motion.div>`

### Group J: Admin pages (8 files, ~10 instances)

**`src/app/admin/debug/ai-attribution/AIAttributionDebug.tsx`** (1 instance)

- Line ~166: Red error → `<Banner color="red">` + Title + Description

**`src/app/admin/oss/page.tsx`** (1 instance)

- Line ~678: Blue info with list → `<Banner color="blue">` + Description (list as children)

**`src/app/admin/components/OrganizationAdmin/OssSponsorshipDialog.tsx`** (1 instance)

- Line ~178: Blue info → `<Banner color="blue">` + Description

**`src/app/admin/components/UserAdmin/UserAdminGdprRemoval.tsx`** (1 instance)

- Line ~75: Blue info → `<Banner color="blue">` + Description

**`src/app/admin/components/UserAdmin/UserAdminCreditGrant.tsx`** (1 instance)

- Line ~285: Yellow warning (light-mode colors `bg-yellow-50 text-yellow-800`) → `<Banner color="amber">` + Description

**`src/app/admin/components/OrganizationAdmin/OrganizationAdminCreditGrant.tsx`** (1 instance)

- Line ~153: Yellow warning (light-mode) → `<Banner color="amber">` + Description

**`src/app/admin/revenue/page.tsx`** (1 instance)

- Line ~64: Blue info (light-mode colors `bg-blue-50 text-blue-800`) → `<Banner color="blue">` + Title + Description

**`src/app/admin/community-prs/page.tsx`** (1 instance)

- Line ~224: Red error (light-mode) → `<Banner color="red">` + Description

**`src/app/admin/code-reviews/page.tsx`** (1 instance)

- Line ~482: Red error (light-mode) → `<Banner color="red">` + Description

### Group K: Shared combobox components (3 files, 3 instances)

**`src/components/shared/ModelCombobox.tsx`** (1 instance)

- Line ~145: Red error → `<Banner color="red">` + Description

**`src/components/shared/RepositoryCombobox.tsx`** (1 instance)

- Line ~153: Red error → `<Banner color="red">` + Description

**`src/components/shared/BranchCombobox.tsx`** (1 instance)

- Line ~83: Red error → `<Banner color="red">` + Description

### Group L: Integrations (2 files, 3 instances)

**`src/components/integrations/GitLabIntegrationDetails.tsx`** (2 instances)

- Line ~750: Green success with CheckCircle2 icon → `<Banner color="green">` + Icon + Description
- Line ~772: Red error with AlertCircle icon → `<Banner color="red">` + Icon + Description

**`src/components/integrations/DevAddGitHubInstallationCard.tsx`** (1 instance)

- Line ~88: Yellow alert with instructions → `<Banner color="amber">` + Description

### Group M: Other organization/auth files (3 files, ~4 instances)

**`src/components/organizations/new/CreateOrganizationPage.tsx`** (1 instance)

- Line ~186: Red error in `<motion.div>` with AlertCircle → Wrap in motion.div, `<Banner color="red">` + Icon + Description

**`src/components/organizations/subscription/SeatChangeModal.tsx`** (3 instances)

- Line ~332: Blue info (light-mode `bg-blue-50`) → `<Banner color="blue">` + Description
- Line ~349: Alert warning → `<Banner color="amber">` + Description
- Line ~362: Alert destructive with AlertCircle → `<Banner color="red">` + Icon + Description

**`src/components/profile/RedeemPromoCode.tsx`** (2 instances)

- Line ~147: Green success Card → `<Banner color="green">` + Icon + Title + Description
- Line ~273: Alert destructive → `<Banner color="red">` + Icon + Title + Description

---

## Implementation Order

1. **Phase 0** — Enhance Banner.tsx (add green color + BannerDismiss). ~15 min.
2. **Phase 1** — Named \*Banner files (6 files). ~1-2 hours. Highest visual/architectural impact.
3. **Phase 2** — Card-based headers (4 files). ~45 min.
4. **Phase 3** — Inline banners by group. ~2-3 hours. Work through groups A-M in order.

After each phase, run `pnpm typecheck` to catch any issues.

## Total scope

- **1 file enhanced** (Banner.tsx)
- **~35 files modified** across phases 1-3
- **~55 banner instances** migrated
- **~7 patterns excluded** (status cards, interactive panels)
