<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Add Select all / Deselect all model controls to ProviderDetailsDialog via a bulk draft action

## Problem

In the organization Providers & Models page, the provider details modal (ProviderDetailsDialog) only offers a per-model "Model allowed" checkbox. Admins who want to allow or deny every model offered by a provider must click each row individually. Issue #9085 asks for Select all and Deselect all controls that act only on the models listed in the open provider modal, write the same unsaved draft the checkboxes already write, still require the page's existing save action, and are unavailable when canEdit is false.

## Evidence

- ProviderDetailsDialog.tsx renders one Checkbox per row of infoProviderModels, bound to allowedModelIds.has(model.modelId), calling onToggleModelAllowed(modelId, bool), disabled when !canEdit. It has no bulk control.
- useProvidersAndModelsAllowListsState.ts reducer has TOGGLE_MODEL (single id) but no bulk model action. Draft state is draftModelDenyList, and hasUnsavedChanges compares it to initialModelDenyList.
- allowLists.domain.ts toggleModelAllowed normalizes the model id and adds it to or removes it from the org-wide deny list. Allow/deny is keyed only by model id, not by provider.
- OrganizationProvidersAndModelsPage.tsx passes infoProviderModels, allowedModelIds, canEdit and handleToggleModelAllowed (which no-ops when !canEdit) into the dialog. Persistence happens only in handleSaveChanges, which ModelSelectionStatusBar triggers when hasUnsavedChanges is true.
- Unit tests already exist in allowLists.domain.test.ts and useProvidersAndModelsAllowListsState.test.ts (Jest, apps/web `test` script).
- A search found no existing 'Select all' in the providers-and-models directory, and no PR history matched.

## Desired outcome

Editors see Select all and Deselect all controls in the provider modal. One click allows or denies every model listed for that provider in the shared draft, in a single update. The status bar then shows unsaved changes, and nothing persists until the existing Save action runs. Cancel reverts the change as before. Viewers without edit rights cannot use the controls.

## Scope

- Add a pure domain helper (for example setModelsAllowed({ modelIds, nextAllowed, draftModelDenyList })) in allowLists.domain.ts. It applies the same normalization as toggleModelAllowed to a list of ids and returns a canonical sorted deny list.
- Add a bulk reducer action (for example SET_MODELS_ALLOWED with modelIds and nextAllowed) and a matching `setModelsAllowed` hook action in useProvidersAndModelsAllowListsState.ts.
- Add a canEdit-guarded handleSetModelsAllowed callback in OrganizationProvidersAndModelsPage.tsx and pass it to ProviderDetailsDialog as a new onSetModelsAllowed prop.
- Render Select all and Deselect all buttons above the model table in ProviderDetailsDialog, scoped to infoProviderModels, using the existing apps/web/src/components/ui Button and the kilo-design-cloud guidance.
- Add unit tests for the domain helper and the reducer action.

## Exclusions

- No change to persistence, the tRPC router, the database schema, or the save/cancel flow.
- No provider-scoped allow/deny semantics. Allow/deny stays org-wide by model id.
- No bulk controls in ModelDetailsDialog, the models tab, or the providers table.
- The provider 'Enabled' checkbox is not toggled automatically by the bulk actions.

## Approach

- Domain: implement setModelsAllowed by building a Set from the normalized draftModelDenyList, then deleting each normalized id (allow) or adding it (deny), and returning sortUniqueStrings. Reuse normalizeModelId so results match repeated toggleModelAllowed calls.
- Reducer: SET_MODELS_ALLOWED returns state unchanged when status !== 'ready'. Otherwise it replaces draftModelDenyList with the helper's output. Expose it through a useCallback `setModelsAllowed` and add it to the actions memo and its return type.
- Page: handleSetModelsAllowed(modelIds, nextAllowed) returns early when !canEdit, otherwise calls actions.setModelsAllowed. Pass it as onSetModelsAllowed to ProviderDetailsDialog.
- Dialog: compute modelIds = infoProviderModels.map(m => m.modelId), allAllowed = every id in allowedModelIds, and noneAllowed = no id in allowedModelIds. Render a small row above the table with two Buttons (size sm, secondary/ghost variant per the design skill) labelled 'Select all' and 'Deselect all'. Disable Select all when !canEdit, when the list is empty, or when allAllowed; disable Deselect all when !canEdit, when the list is empty, or when noneAllowed. A mixed selection enables both. Each click calls onSetModelsAllowed(modelIds, true or false) once.
- Add short helper text near the buttons noting that changes apply org-wide to these model ids and must be saved. Keep it in Cloud semantic tokens (for example text-muted-foreground text-xs).
- Tests: extend allowLists.domain.test.ts (allow removes all listed ids, deny adds all, unrelated deny entries preserved, normalization or duplicates handled) and useProvidersAndModelsAllowListsState.test.ts (bulk action changes the draft, RESET_TO_INITIAL restores it, no-op while loading).

## Affected areas

- apps/web/src/components/organizations/providers-and-models/ProviderDetailsDialog.tsx
- apps/web/src/components/organizations/providers-and-models/OrganizationProvidersAndModelsPage.tsx
- apps/web/src/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState.ts
- apps/web/src/components/organizations/providers-and-models/allowLists.domain.ts
- apps/web/src/components/organizations/providers-and-models/allowLists.domain.test.ts
- apps/web/src/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState.test.ts

## Acceptance criteria

### ac-1: setModelsAllowed with nextAllowed=true removes every listed (normalized) model id from the deny list. With nextAllowed=false it adds every listed id. Deny entries for unlisted model ids are preserved, and the output is canonical (sorted, unique), matching the result of applying toggleModelAllowed to each id in turn. Unit tests in allowLists.domain.test.ts cover these cases.

**Verification:** Code review

### ac-2: The reducer's bulk model action updates draftModelDenyList in a single dispatch while ready, is a no-op while loading, and is reverted by RESET_TO_INITIAL. Unit tests in useProvidersAndModelsAllowListsState.test.ts cover this.

**Verification:** Code review

### ac-3: ProviderDetailsDialog shows 'Select all' and 'Deselect all' controls for the model list. They act only on the model ids in infoProviderModels for the open provider, through the new onSetModelsAllowed prop, so after one click every row checkbox in the modal reflects the new state.

**Verification:** Source review

### ac-4: Both controls are disabled when canEdit is false, and the page-level handler also ignores calls when canEdit is false. Select all is disabled when every listed model is already allowed or the list is empty. Deselect all is disabled when no listed model is allowed or the list is empty. With a mixed selection both are enabled.

**Verification:** Source review

### ac-5: Bulk actions only change the unsaved draft. They make hasUnsavedChanges true so the existing ModelSelectionStatusBar appears, and nothing persists until handleSaveChanges runs. No new mutation or save path is added.

**Verification:** Source review

### ac-6: In a running app, as an org owner/admin: open a provider modal, click Deselect all, and confirm every row unchecks and the status bar appears. Click Cancel and confirm the state reverts. Repeat with Select all followed by Save, and confirm the result persists after a reload. As a member without manage rights, confirm both controls are disabled.

**Verification:** Manual: verify bulk select/deselect, cancel, save, and read-only behavior in the Providers & Models page

## Risks

- Org-wide semantics: Deselect all in one provider's modal denies those model ids everywhere, including for other providers that offer them. This is mitigated by helper copy in the modal and by keeping the draft-plus-explicit-save flow.
- Dispatching many TOGGLE_MODEL calls in a loop would work, but it would cause redundant reducer passes. The single bulk action avoids that and keeps results deterministic.
- Large providers may list many models. The action is O(n) on Set operations, so this is fine.

## Assumptions

- The controls are rendered but disabled (not hidden) when canEdit is false, matching how the existing per-model checkboxes behave. The issue allows either.
- infoProviderModels, which already excludes models without an endpoint, is the right definition of 'models in the open provider modal'.
- Model ids in infoProviderModels are compatible with normalizeModelId, as they already are for the per-row toggle.

## Decisions

### d-1: Implement bulk selection with a new reducer action and domain helper instead of looping per-model toggles in the component.

**Answer:** Use a bulk SET_MODELS_ALLOWED action backed by a pure setModelsAllowed helper. This gives one atomic draft update and makes the behavior easy to unit test.

**Blocking:** no

### d-2: Whether to hide or disable the controls when canEdit is false.

**Answer:** Disable them, consistent with the existing disabled checkboxes in the same modal.

**Blocking:** no
