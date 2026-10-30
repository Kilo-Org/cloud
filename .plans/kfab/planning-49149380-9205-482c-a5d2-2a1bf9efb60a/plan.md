<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Regroup web app sidebars into Overview, Cloud, Settings, Admin, and Billing sections

## Problem

The personal and organization sidebars in apps/web both render three groups: Dashboard, Cloud, and Account. In the organization sidebar, Account mixes three kinds of page: billing pages (Subscriptions, Invoices), member configuration pages (Integrations, Custom Modes, BYOK), and owner controls (Groups, Model Access, Audit Logs). Sub-organizations, which is also an owner control, sits under Dashboard. The two sidebars also list Cloud items in different orders: Gas Town is fourth in the organization sidebar and last in the personal sidebar. Issue #9095 asks for both sidebars to use the groups Overview, Cloud, Settings, Admin, and Billing, with empty groups hidden and no changes to URLs or permissions.

## Evidence

- OrganizationAppSidebar.tsx (pinned checkout) renders the groups Dashboard, Cloud (conditional), and Account (conditional) from the arrays dashboardItems, cloudItems, and accountItems. accountItems contains Groups (plan === 'enterprise'), Subscriptions and Invoices (hasOwnerLevelAccess), Integrations and Custom Modes (always), Model Access and Audit Logs (hasOwnerLevelAccess && enterprise), and BYOK (hasOwnerLevelAccess || ChatGPT sign-in flag).
- In OrganizationAppSidebar.tsx, Sub-organizations is in dashboardItems, gated on hasOwnerLevelAccess && parent_organization_id === null.
- Organization Cloud order: Cloud Agent, Sessions, Webhooks / Triggers, Gas Town (flag or development, and role is not billing_manager), Code Reviewer, Security Agent. Personal Cloud order in PersonalAppSidebar.tsx: Cloud Agent, Sessions, Webhooks / Triggers, Code Reviewer, Security Agent, Gas Town.
- PersonalAppSidebar.tsx: Dashboard has Your Profile, Organizations, and Usage. Account has Subscriptions, Integrations, Invoices, Credits, and BYOK, and is always rendered.
- SidebarMenuList.tsx renders a group label plus items, and works out which item is active from allUrls. Both sidebars build allUrls from every item array, so a new array has to be added there.
- OrganizationAppSidebar.test.ts covers only the Gas Town visibility matrix. Nothing tests group labels or order, and there is no PersonalAppSidebar test.
- apps/storybook/stories/Sidebar.stories.tsx copies the personal grouping with the labels Dashboard, Cloud, Account, and Start.
- Triage found no duplicate issue and no PR that already does this. The issue body and comments were withheld from screening, so the group contents below follow the triage summary of the proposal.

## Desired outcome

Both sidebars show the groups in this order: Overview, Cloud, Settings, Admin (organization only), Billing. Each page sits in the group that matches its purpose. The Cloud order is the same in both sidebars. Groups with no visible items are not rendered. Every item keeps its current URL and its current visibility condition.

## Scope

- OrganizationAppSidebar.tsx: replace dashboardItems and accountItems with overviewItems (Welcome, Organization, Usage), settingsItems (Integrations, Custom Modes, BYOK), adminItems (Groups, Model Access, Audit Logs, Sub-organizations), and billingItems (Subscriptions, Invoices). Keep every existing condition exactly as it is.
- PersonalAppSidebar.tsx: rename Dashboard to Overview (Your Profile, Organizations, Usage). Split Account into Settings (Integrations, BYOK) and Billing (Subscriptions, Invoices, Credits). The personal sidebar has no Admin group.
- Both sidebars use the Cloud order Cloud Agent, Sessions, Webhooks / Triggers, Code Reviewer, Security Agent, Gas Town. Gas Town keeps its existing conditions in each sidebar.
- Render each group only when it has at least one item, and include every new array in allUrls.
- Update the Storybook Sidebar story to the new labels and grouping.
- Add tests for group labels, order, and empty-group hiding in the organization sidebar, and a basic grouping test for the personal sidebar.

## Exclusions

- No changes to URLs, routes, server-side or tRPC authorization, or billing logic.
- No change to who can see any item. Groups stays visible to every member of an enterprise organization.
- The KiloClaw drill-in menu, the Gastown town and Wasteland sidebars, and the Kilo staff admin app (apps/web/src/app/admin) are unchanged.
- No icon redesign. Existing icons stay as they are.

## Approach

- In OrganizationAppSidebar.tsx, move items into the new typed arrays by copying their existing conditional spreads unchanged, so each item's visibility logic is the same as before. In the JSX, render Overview, the KiloClaw entry, Cloud, Settings, Admin, and Billing in that order, each wrapped in an `items.length > 0` check. Add all arrays to allUrls so active-item matching still works.
- In PersonalAppSidebar.tsx, move Gas Town to the end of cloudItems (it is already last there) and reorder the organization cloudItems so Gas Town also comes after Security Agent. Rename the Dashboard label to Overview and split accountItems into settingsItems and billingItems.
- Keep the label 'Admin', as the issue proposes. It only appears inside an organization's sidebar, which keeps it separate from the staff admin app, and the label can be changed later.
- Update the Storybook story labels and arrays to match the personal sidebar.
- Extend OrganizationAppSidebar.test.ts, reusing its mocks, with a SidebarMenuList mock that also outputs the label. Cover these cases: (a) an enterprise owner of a root org sees the labels in order Overview, Cloud, Settings, Admin, Billing, with Sub-organizations under Admin; (b) a non-enterprise member sees no Admin and no Billing labels; (c) an enterprise member still sees Groups under Admin, and Model Access and Audit Logs stay hidden. Add a similar PersonalAppSidebar test for Overview, Cloud, Settings, and Billing, with no Admin.

## Affected areas

- apps/web/src/app/(app)/components/OrganizationAppSidebar.tsx
- apps/web/src/app/(app)/components/PersonalAppSidebar.tsx
- apps/web/src/app/(app)/components/OrganizationAppSidebar.test.ts
- apps/web/src/app/(app)/components/PersonalAppSidebar.test.ts (new)
- apps/storybook/stories/Sidebar.stories.tsx

## Acceptance criteria

### ac-1: The organization sidebar shows the groups in the order Overview (Welcome, Organization, Usage), Cloud, Settings (Integrations, Custom Modes, BYOK), Admin (Groups, Model Access, Audit Logs, Sub-organizations), Billing (Subscriptions, Invoices). There is no Dashboard or Account label. A new rendering test asserts this order for an enterprise owner of a root organization.

**Verification:** Code review

### ac-2: The personal sidebar shows Overview (Your Profile, Organizations, Usage), Cloud, Settings (Integrations, BYOK), and Billing (Subscriptions, Invoices, Credits), with no Admin group and no Dashboard or Account label. A new PersonalAppSidebar test checks this.

**Verification:** Code review

### ac-3: Both sidebars list Cloud items as Cloud Agent, Sessions, Webhooks / Triggers, Code Reviewer, Security Agent, Gas Town. The existing Gas Town visibility test still passes without changes to its expectations.

**Verification:** Code review

### ac-4: Every item keeps its existing URL and visibility condition. For example, Groups is still shown to all enterprise members, Model Access and Audit Logs still need owner-level access on an enterprise plan, and BYOK still shows for owner-level access or when the ChatGPT flag is on. A group with no visible items has no label. For example, a non-enterprise member sees no Admin or Billing label. Tests cover the member and non-enterprise cases.

**Verification:** Code review

### ac-5: Active-item highlighting still works for items in the new groups, because every new array is included in allUrls. For example, /organizations/{id}/audit-logs highlights Audit Logs and not Organization.

**Verification:** Source review

### ac-6: The Storybook Sidebar story shows the new labels and grouping, matching the personal sidebar.

**Verification:** Source review

## Risks

- Users who know the current layout need to find pages again. URLs do not change, so bookmarks still work.
- The issue body was not visible during screening. If the issue's tables put a page in a different group from the one planned here (for example Sub-organizations or BYOK), the arrays need to be adjusted before or during review.
- Enterprise members who are not owners will see an Admin group containing only Groups. This follows from keeping current visibility, but it may look odd. A follow-up could restrict Groups to owners.

## Assumptions

- The issue's recommended names (Overview, Settings, Billing, Admin) are accepted instead of the fallback of keeping Account and only adding Admin.
- The issue says permissions do not change, so Groups keeps its current plan-only visibility.
- Billing managers keep seeing Gas Town hidden and keep their current owner-level access to billing items through canManageOrganizationBilling.

## Decisions

### d-1: Should Groups become owner/admin-only when it moves under Admin?

**Answer:** No. Keep current visibility (all enterprise members) because the issue rules out permission changes. A role restriction would need its own follow-up.

**Blocking:** no

### d-2: Which group names should be used?

**Answer:** Use the issue's recommended Overview, Cloud, Settings, Admin, Billing.

**Blocking:** no

### d-3: Is 'Admin' acceptable as the organization administration group name, given the separate staff admin app?

**Answer:** Yes. It only appears inside the organization sidebar. It is a one-string change if product prefers another name.

**Blocking:** no
