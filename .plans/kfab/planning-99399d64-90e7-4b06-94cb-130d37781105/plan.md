<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Replace provider/model filter chips on org Providers & Models with labeled named-choice pickers

## Problem

The operator moved issue #9097 to the in-app organization Providers & Models page (/organizations/[id]/providers-and-models). On that page the Providers tab uses separate filters: two All/Yes/No chip groups labeled only "Trains" and "Retains prompts", plus a collapsible "Provider location" country checkbox list. The Models tab has a bare "Selected" checkbox. None of these controls says what is currently chosen or what each option means. That makes it easy for an owner to misread which providers are shown, for example ones that train on or retain prompts. The same ProvidersTab and ModelsTab components are reused, with scope='group', by the group model-access policy editor.

## Evidence

- apps/web/src/components/organizations/providers-and-models/ProvidersTab.tsx: the Filters panel has RadioButtonGroup 'Trains' and 'Retains prompts' with options All/Yes/No, and CollapsibleFilterSection 'Provider location' with CollapsibleCheckboxFilter. Rows show ProviderPolicyTag badges.
- apps/web/src/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState.ts: ProviderPolicyFilter = 'all'|'yes'|'no'. providerTrainsFilter, providerRetainsPromptsFilter and providerLocationsFilter are independent. These are display filters only, separate from the draft allow/deny lists with save/reset.
- OrganizationProvidersAndModelsPage.tsx (lines ~362-417): filteredProviderRows applies the trains, retains and location filters inline. Locations match against getCountryDisplayName of headquarters or datacenters.
- groups/policies/model-access/ModelAccessPolicyEditor.tsx keeps its own useState for trainsFilter, retainsFilter and locations, repeats the same filter logic inline, and renders ProvidersTab/ModelsTab with scope='group'. Its location options are raw codes, not display names.
- ModelsTab.tsx: search Input plus a 'Selected' checkbox. There is no sort control, so the issue's sort-menu criterion has no direct counterpart here.
- OrganizationDataCollectionCard.tsx: 'Current Policy' Select (from @/components/ui/select). The trigger always names the current value, and each item pairs a title with a muted one-line consequence. This is the pattern to copy.
- Command/Popover combobox primitives (CommandInput) are already used, e.g. cloud-agent-next/settings/RepositoryPicker.tsx, for searchable single-choice pickers.
- useProvidersAndModelsAllowListsState.test.ts has Jest reducer tests. No @testing-library/react dependency was found in apps/web/package.json, so behavior proofs should target pure functions and the reducer.
- Root package.json: "test": "pnpm --filter web test && pnpm run test:scripts".

## Desired outcome

On the Providers tab, owners make two named decisions instead of using a pile of filters: (1) "Data policy", a labeled picker whose closed state names the current choice and whose options each have a title and a one-line consequence; (2) "Location", a labeled searchable picker that names the chosen location ("Any location" by default), marks the selection with a check, and keeps the choice when the search text changes. On the Models tab, a labeled "Show" picker replaces the bare "Selected" checkbox. No All/Yes/No chip group and no metric-name-only option remains. The provider/model draft, save/reset, permission gating and policy badges behave exactly as today. The group model-access editor gets the same pickers through the shared tabs.

## Scope

- New pure module (e.g. providers-and-models/providerSelectionChoices.ts) that defines the named data-policy choices (value, title, consequence), a location choice type ('any' or a country display name), and the matching functions matchesProviderDataPolicy(row, choice) and matchesProviderLocation(row, choice, toDisplayName).
- Reusable labeled picker components in providers-and-models/ (e.g. NamedChoiceSelect, built on @/components/ui/select like OrganizationDataCollectionCard, and a searchable LocationChoicePicker built on Popover + Command).
- ProvidersTab: replace the two RadioButtonGroups and the location checkbox list with the two pickers. Props change from trains/retains/locations filters to providerDataPolicyChoice/providerLocationChoice and their handlers.
- ModelsTab: replace the 'Selected' checkbox with a labeled 'Show' picker (All models / Selected only), each option with a consequence line, still driving the existing selectedOnly boolean.
- useProvidersAndModelsAllowListsState: replace the three provider filter fields and actions with providerDataPolicyChoice and providerLocationChoice. Update the reducer tests.
- OrganizationProvidersAndModelsPage and ModelAccessPolicyEditor: use the shared matching functions and the new props. The group editor's location options switch to country display names so they match the org page.

## Exclusions

- The kilocode-landing /models and /providers pages (ModelsGridServer, ProvidersExplorer, sort menu); per the operator redirect, they are not in this repository.
- Adding a model sort or ranking control (Code Agent Rank, Coding Index, Speed, Price, Name). This page has no such data or control.
- Any change to how allow/deny lists are computed, saved or reset, to enterprise gating, to role checks, or to the Auto routing tab.
- Server, tRPC or database changes. Filter choices stay client-only and are not persisted.

## Approach

- Add providerSelectionChoices.ts with PROVIDER_DATA_POLICY_CHOICES (ordered): 'any' → title 'All providers', consequence 'Show every provider, whatever its training or prompt-retention policy'; 'private' → 'No training, no prompt retention', 'Only providers that neither train on nor retain prompts'; 'no-training' → 'No training', 'Providers that do not train on prompts (they may retain them)'; 'trains-or-retains' → 'Trains on or retains prompts', 'Review providers whose defaults use or keep prompt data'. Export matchesProviderDataPolicy based on row.trains/row.retainsPrompts, and matchesProviderLocation(row, choice, toDisplayName), which is true for 'any' or when headquarters or a datacenter maps to the chosen display name.
- Build NamedChoiceSelect({id, label, value, options, onChange}): a visible <Label htmlFor>, a SelectTrigger whose SelectValue renders the chosen option's title, and SelectItems showing title + muted consequence. Radix Select provides keyboard navigation and the check indicator.
- Build LocationChoicePicker: a labeled Popover trigger button (role combobox, aria-expanded) that shows the current location title. Inside, a Command with CommandInput keeps the search query in local state separate from the chosen value. It lists 'Any location' (consequence 'Providers headquartered or hosting anywhere') and one item per country (consequence 'Headquartered or hosting in <country>'). The selected item shows a Check icon. Selecting closes the popover and calls onChange. Typing only narrows the list.
- In ProvidersTab, render both pickers in the Filters panel in place of the RadioButtonGroups/CollapsibleFilterSection, and remove RadioButtonGroup/parseProviderPolicyFilter usage. Keep the search box, the Enabled/Selected checkbox, the row list, ProviderPolicyTag and the explanatory copy. Update the copy so it refers to the 'Data policy' choice.
- In useProvidersAndModelsAllowListsState, replace ProviderPolicyFilter and the three filter fields/actions with providerDataPolicyChoice: ProviderDataPolicyChoice (default 'any') and providerLocationChoice: ProviderLocationChoice (default 'any'), plus actions SET_PROVIDER_DATA_POLICY_CHOICE and SET_PROVIDER_LOCATION_CHOICE. INIT_FROM_SERVER keeps the choices as today's filters are kept. Remove the ProviderPolicyFilter export once nothing uses it.
- In OrganizationProvidersAndModelsPage.filteredProviderRows and ModelAccessPolicyEditor.filteredProviders, call the shared matchers instead of the inline trains/retains/location logic. In the group editor, replace the three useStates with two choices and build locationOptions with getCountryDisplayName.
- In ModelsTab, replace the Selected checkbox with NamedChoiceSelect label 'Show': 'all' → 'All models' / 'Every model offered by enabled providers'; 'selected' → 'Selected only' (organization) or 'Granted only' (group) / 'Only models members can currently use' (or 'granted by this policy'). Map it to the existing selectedOnly boolean so callers keep their prop shape.
- Add Jest tests: providerSelectionChoices.test.ts (each data-policy choice against the four trains/retains combinations; location matching for HQ, datacenter, 'any' and non-match) and reducer tests (default choices, choice set actions, choices kept across INIT_FROM_SERVER/TOGGLE/RESET, draft unaffected by choice changes).

## Affected areas

- apps/web/src/components/organizations/providers-and-models/ProvidersTab.tsx
- apps/web/src/components/organizations/providers-and-models/ModelsTab.tsx
- apps/web/src/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState.ts (+ .test.ts)
- apps/web/src/components/organizations/providers-and-models/OrganizationProvidersAndModelsPage.tsx
- apps/web/src/components/organizations/providers-and-models/providerSelectionChoices.ts (new, + test)
- apps/web/src/components/organizations/providers-and-models/NamedChoiceSelect.tsx and LocationChoicePicker.tsx (new)
- apps/web/src/components/organizations/groups/policies/model-access/ModelAccessPolicyEditor.tsx

## Acceptance criteria

### ac-1: Data-policy matching is correct: 'any' matches all rows; 'private' matches only trains=false and retainsPrompts=false; 'no-training' matches trains=false whatever retainsPrompts is; 'trains-or-retains' matches rows where trains or retainsPrompts is true. Location matching returns true for 'any', true when headquarters or any datacenter maps to the chosen country display name, and false otherwise. Jest tests in providerSelectionChoices.test.ts cover each case.

**Verification:** pnpm test

### ac-2: The reducer defaults providerDataPolicyChoice and providerLocationChoice to 'any'. The new set actions update them. Both choices survive INIT_FROM_SERVER, TOGGLE_PROVIDER, TOGGLE_MODEL and RESET_TO_INITIAL. Changing a choice never changes draftProviderAllowList or draftModelDenyList. Reducer tests cover this.

**Verification:** pnpm test

### ac-3: The Providers tab no longer renders any All/Yes/No RadioButtonGroup or the Provider location checkbox list. Instead it renders a labeled 'Data policy' picker and a labeled 'Location' picker. Each closed trigger shows the current choice's title, never an empty placeholder or a bare metric name. Every option shows a title plus a one-line consequence. The selected option shows a check indicator. Both pickers can be opened and changed by keyboard (Radix Select, and a Popover/Command combobox with labeled trigger and aria-expanded).

**Verification:** Source review

### ac-4: In the Location picker, the search query is local state separate from the chosen value. Typing narrows the visible options but does not change or clear the current location, and the trigger keeps naming it. Only selecting an item calls onChange.

**Verification:** Source review

### ac-5: The Models tab replaces the bare 'Selected' checkbox with a labeled 'Show' picker whose options ('All models', 'Selected only'/'Granted only' for group scope) each carry a consequence line. The picker maps to the existing selectedOnly behavior, and model search still narrows the list without resetting the Show choice.

**Verification:** Source review

### ac-6: OrganizationProvidersAndModelsPage and ModelAccessPolicyEditor both filter providers through the shared matchers. Neither keeps inline trains/retains/location filter logic or a ProviderPolicyFilter reference. The group editor's location options use country display names, the same as the org page. Provider toggles, model toggles, save/reset, canEdit/unavailable gating, ProviderPolicyTag badges and the enterprise gate are unchanged.

**Verification:** Code review

## Risks

- Location changes from multi-select (several countries) to a single named choice. Owners who combined several countries lose that filter. This is accepted to meet the issue's named-decision goal (see decisions).
- The four data-policy presets drop the old 'trains=yes AND retains=no' style combinations. 'Trains on or retains prompts' covers the review use case, but some exact combinations can no longer be filtered.
- The Radix Select/Popover inside the group editor's sheet needs a high enough z-index (the editor already uses z-[70] on SelectContent). The new pickers must accept a content className so they don't render under the sheet.
- No React component test harness exists, so rendering behavior (AC3-AC5) is checked by source review, not automated tests.

## Assumptions

- The operator redirect makes the in-app organization Providers & Models page the only target. Kilocode-landing work is tracked elsewhere.
- Filters stay display-only and session-local. They do not drive the allow-list draft or get saved.
- Provider policy values (trains, retainsPrompts) are booleans on ProviderRow, as the current filter comparisons imply.

## Decisions

### d-1: Does the group model-access policy editor get the new pickers?

**Answer:** Yes. ProvidersTab/ModelsTab are shared, so the group editor adopts the same pickers and shared matchers rather than keeping a scoped variant of the old chips.

**Blocking:** no

### d-2: How does Provider location map onto the guided choice?

**Answer:** It becomes a separate labeled, searchable single-choice 'Location' picker (default 'Any location') matching headquarters or datacenter country, replacing the multi-select checkbox list.

**Blocking:** no

### d-3: Do the named choices drive the provider/model draft or only the visible list?

**Answer:** Only the visible list. Draft membership, save and reset stay driven by the row checkboxes, as today.

**Blocking:** no

### d-4: What does the guided choice control on the Models tab, given there is no sort?

**Answer:** A labeled 'Show' picker (All models / Selected only) replaces the bare 'Selected' checkbox. No sort control is added.

**Blocking:** no
