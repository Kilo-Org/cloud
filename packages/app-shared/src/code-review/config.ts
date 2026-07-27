import type { GateThreshold, ReviewStyle } from './enums';

// Wire shape of a per-repository model override. Mirrors the tRPC input/output
// contract (camelCase); the persisted snake_case shape lives in
// RepositoryModelOverrideSchema in @kilocode/db/schema-types.
export type RepositoryModelOverrideInput = {
  repositoryId: number | string;
  repoFullName: string;
  modelSlug: string;
  // Optional to mirror the tRPC input contract (RepositoryModelOverrideInputSchema
  // marks thinkingEffort `.nullable().optional()`); an omitted value means "no
  // override effort". Read sites already coalesce with `?? null` when persisting.
  thinkingEffort?: string | null;
};

// Wire shape of a manually-added repository (GitLab pagination workaround).
// Mirrors the tRPC input contract; the persisted snake_case shape lives in
// ManuallyAddedRepositorySchema in @kilocode/db/schema-types.
export type ManuallyAddedRepositoryInput = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
};

// Wire shape of the Code Reviewer council config (camelCase keys mirror the
// tRPC patch input; the persisted snake_case shape is
// CodeReviewCouncilConfigSchema in @kilocode/db/schema-types). Kept loose on
// purpose — callers zod-validate against the canonical schema at the route
// boundary, and this helper only needs to know it's an opaque object that
// should be preserved verbatim when the patch doesn't carry it.
export type CodeReviewCouncilConfigInput = {
  enabled?: boolean;
  aggregation_strategy?: 'majority' | 'unanimous' | 'advisory';
  specialists: Array<{
    id: string;
    role: string;
    name: string;
    enabled: boolean;
    required: boolean;
    lens: string;
    model_slug?: string;
    thinking_effort?: string | null;
  }>;
};

// Mobile/personal-org save patch. All keys are optional; omission preserves the
// stored value. The PATCH route handlers spread this into the saved payload, so
// it MUST NOT carry org-only field-merge fields (manuallyAddedRepositories,
// council, councilEnabledRepositoryIds) that the strict saveReviewConfig schemas
// do not accept.
export type CodeReviewConfigPatch = Partial<{
  reviewStyle: ReviewStyle;
  focusAreas: string[];
  customInstructions: string;
  modelSlug: string;
  thinkingEffort: string | null;
  gateThreshold: GateThreshold;
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: (number | string)[];
  repositoryModelOverrides: RepositoryModelOverrideInput[];
  disableReviewMd: boolean;
}>;

// Field-merge PATCH surface. Extends the save patch with the org-only fields
// that the PATCH procedures preserve but the strict saveReviewConfig schemas do
// not accept. Used by applyCodeReviewConfigPatch and the two PATCH route handlers.
export type CodeReviewFieldMergePatch = CodeReviewConfigPatch &
  Partial<{
    manuallyAddedRepositories: ManuallyAddedRepositoryInput[];
    council: CodeReviewCouncilConfigInput | null;
    councilEnabledRepositoryIds: (number | string)[];
  }>;

// Snapshot of a stored Code Reviewer config in camelCase, suitable as the
// `stored` argument to `applyCodeReviewConfigPatch`. Every field is optional
// because callers may have a subset (e.g. personal configs never carry
// `council`); the helper preserves whatever is supplied.
export type CodeReviewStoredConfig = {
  reviewStyle?: ReviewStyle;
  focusAreas?: string[];
  customInstructions?: string | null;
  modelSlug?: string;
  thinkingEffort?: string | null;
  gateThreshold?: GateThreshold;
  repositorySelectionMode?: 'all' | 'selected';
  selectedRepositoryIds?: (number | string)[];
  repositoryModelOverrides?: RepositoryModelOverrideInput[];
  disableReviewMd?: boolean;
  // Org-only fields. Personal configs never have these in storage, so the
  // stored snapshot can omit them and the helper still works.
  manuallyAddedRepositories?: ManuallyAddedRepositoryInput[];
  council?: CodeReviewCouncilConfigInput | null;
  councilEnabledRepositoryIds?: (number | string)[];
};

// Field-merge helper for the PATCH endpoints (`personalReviewAgent.patchReviewConfig`
// and `organizations.reviewAgent.patchReviewConfig`). Returns a new object
// containing every field of `stored` plus any field explicitly set in `patch`
// (where "set" means `hasOwnProperty` AND value is not `undefined` — `null` is
// a real "clear" value, e.g. `council: null` disables council).
//
// Does not mutate either argument. Keys present on `patch` are copied via a
// shallow assignment, so complex values (arrays, council objects) are
// referenced, not cloned — callers that mutate the returned override arrays
// in place would observe the change on `patch.repositoryModelOverrides` too.
// In practice the route handler passes the result straight to upsert without
// further mutation, so this is fine and matches the spec's "smallest boring
// implementation" rule.
export function applyCodeReviewConfigPatch(
  stored: CodeReviewStoredConfig,
  patch: CodeReviewFieldMergePatch
): CodeReviewStoredConfig {
  const merged: CodeReviewStoredConfig = { ...stored };
  for (const key of Object.keys(patch) as Array<keyof CodeReviewFieldMergePatch>) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      const value = patch[key];
      if (value !== undefined) {
        // Safe: every key in the patch is also a key on CodeReviewStoredConfig.
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}
