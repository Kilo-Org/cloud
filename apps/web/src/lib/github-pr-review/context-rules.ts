import 'server-only';

import { z } from 'zod';
import {
  GitHubPrReviewPolicySchema,
  type GitHubPrReviewContext,
  type GitHubPrReviewRevision,
} from './context-dtos';

type Requirements = GitHubPrReviewContext['requirements'];
type PolicyCollection = Omit<Requirements, 'items'> & { items: unknown[] };
const parametersSchema = z.record(z.string(), z.json());
const branchRuleSchema = z.object({
  type: z.string().min(1),
  parameters: z.unknown().optional(),
  ruleset_id: z.number().int().positive().optional(),
  ruleset_source: z.string().min(1).optional(),
  ruleset_source_type: z.enum(['Repository', 'Organization', 'Enterprise']).optional(),
});
const checkSchema = z.object({
  context: z.string().min(1),
  app_id: z.unknown().optional(),
  integration_id: z.unknown().optional(),
});

// Collections must describe completed reads, not turn a 404 or an omitted body into an empty list.
// Only a source that proves no classic protection can supply a complete empty classic collection.
export function normalizeContextPolicies(
  revision: GitHubPrReviewRevision,
  classic: PolicyCollection,
  branchRules: PolicyCollection
): Requirements {
  const { baseRepoFullName, baseRef, baseSha } = revision;
  const items: Requirements['items'] = [];
  let invalid = false;
  let invalidRetryable = false;
  for (const [source, collection] of [
    ['classic', classic],
    ['ruleset', branchRules],
  ] as const) {
    const markInvalid = () => {
      invalid = true;
      invalidRetryable ||= collection.source.availability === 'available';
    };
    for (const [index, raw] of collection.items.entries()) {
      const rule = source === 'ruleset' ? branchRuleSchema.safeParse(raw) : null;
      const configuration = parametersSchema.safeParse(
        source === 'classic' ? raw : rule?.data?.parameters
      );
      if (source === 'ruleset' && !rule?.success) {
        markInvalid();
        continue;
      }
      if (
        source === 'classic' &&
        (!configuration.success ||
          !Object.keys(configuration.data).some(
            key => !['url', 'name', 'protection_url'].includes(key)
          ))
      ) {
        markInvalid();
        continue;
      }
      if (!configuration.success && (source === 'classic' || rule?.data?.parameters != null))
        markInvalid();
      const parameters = configuration.success ? configuration.data : null;
      const ruleType = rule?.data?.type ?? 'branch_protection';
      const rulesetId = rule?.data?.ruleset_id ?? null;
      const policy = GitHubPrReviewPolicySchema.parse({
        id: JSON.stringify([source, baseRepoFullName, baseRef, rulesetId, ruleType, index]),
        source,
        // getBranchRules returns only active rules, including inherited rules, not ruleset definitions.
        enforcement: 'active',
        base: { baseRepoFullName, baseRef, baseSha },
        ruleType,
        parameters,
        ruleset:
          source === 'ruleset'
            ? {
                id: rulesetId,
                source: rule?.data?.ruleset_source ?? null,
                sourceType: rule?.data?.ruleset_source_type ?? null,
              }
            : null,
      });
      const requirement: Requirements['items'][number] = {
        id: policy.id,
        kind: ruleType,
        title: ruleType,
        state: 'unavailable',
        policy,
        check: null,
        evidence: collection.source.provenance.map(provenance => ({
          source: provenance,
          policyId: policy.id,
          observation: 'policy-configuration',
          headSha: revision.headSha,
          baseSha,
          evaluatedSha: null,
          observedAt: collection.source.observedAt,
        })),
      };
      items.push(requirement);
      const status =
        source === 'classic'
          ? parameters?.required_status_checks
          : ruleType === 'required_status_checks'
            ? parameters
            : undefined;
      if (status == null && ruleType !== 'required_status_checks') continue;
      const statusParameters = parametersSchema.safeParse(status);
      if (!statusParameters.success) {
        markInvalid();
        continue;
      }
      const checks =
        source === 'classic'
          ? statusParameters.data.checks
          : statusParameters.data.required_status_checks;
      const contexts = source === 'classic' ? statusParameters.data.contexts : undefined;
      const names = new Set<string>();
      let checkIndex = 0;
      const addCheck = (value: unknown) => {
        const parsed = checkSchema.safeParse(value);
        if (!parsed.success) {
          markInvalid();
          return;
        }
        const { context, app_id, integration_id } = parsed.data;
        const appId = source === 'classic' ? app_id : integration_id;
        items.push({
          ...requirement,
          id: `${policy.id}:check:${checkIndex++}`,
          kind: 'status-check',
          title: context,
          check: {
            name: context,
            // Configuration names neither a run nor a status; observations must retain both kinds.
            kind: 'unknown',
            application:
              typeof appId === 'number' && Number.isSafeInteger(appId) && appId > 0
                ? { kind: 'app', appId }
                : source === 'classic' && appId === -1
                  ? { kind: 'any' }
                  : { kind: 'unknown' },
          },
        });
        names.add(context);
      };
      if (Array.isArray(checks)) checks.forEach(addCheck);
      else markInvalid();
      if (Array.isArray(contexts)) {
        for (const context of contexts) {
          if (typeof context !== 'string' || !names.has(context)) addCheck({ context });
        }
      } else if (source === 'classic') markInvalid();
    }
  }
  const collections = [classic, branchRules];
  const sources = collections.map(collection => collection.source);
  const failure = sources.find(source => source.availability !== 'available');
  const complete =
    !invalid &&
    Boolean(baseRepoFullName && baseRef && baseSha) &&
    collections.every(
      collection =>
        collection.source.availability === 'available' &&
        collection.completeness === 'complete' &&
        collection.hasNextPage === false &&
        collection.knownCount === collection.items.length &&
        (collection.totalCount === null || collection.totalCount === collection.items.length)
    );
  return {
    items,
    knownCount: items.length,
    totalCount: complete ? items.length : null,
    completeness: complete ? 'complete' : items.length ? 'partial' : 'unknown',
    hasNextPage: collections.some(collection => collection.hasNextPage === true)
      ? true
      : collections.every(collection => collection.hasNextPage === false)
        ? false
        : null,
    endCursor: branchRules.endCursor,
    source: {
      observedAt: branchRules.source.observedAt ?? classic.source.observedAt,
      provenance: [...new Set(sources.flatMap(source => source.provenance))],
      availability: complete
        ? 'available'
        : sources.some(source => source.availability === 'stale')
          ? 'stale'
          : items.length
            ? 'partial'
            : failure?.availability === 'denied'
              ? 'denied'
              : 'unavailable',
      retryable: sources.some(source => source.retryable) || invalidRetryable,
      reason: complete
        ? null
        : (failure?.reason ?? (invalid ? 'invalid-policy-data' : 'policy-source-incomplete')),
    },
  };
}
