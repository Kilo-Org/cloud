import {
  EXA_USAGE_FEATURE_ID_MAX_LENGTH,
  EXA_USAGE_TYPE_MAX_LENGTH,
  type ExaAllowedPath,
  type ExaUsageRecord,
} from '@kilocode/usage-contracts';

export type ExaUsageRecordInput = {
  id: string;
  occurredAt: string;
  userId: string;
  organizationId: string | undefined;
  path: ExaAllowedPath;
  costMicrodollars: number;
  chargedToBalance: boolean;
  freeAllowanceMicrodollars: number;
  featureId: string | undefined;
  type: string | undefined;
};

export function buildExaUsageRecord(input: ExaUsageRecordInput): ExaUsageRecord {
  const featureId =
    input.featureId && input.featureId.length <= EXA_USAGE_FEATURE_ID_MAX_LENGTH
      ? input.featureId
      : undefined;
  // PostgreSQL text rejects an embedded NUL, so an optional type that carries one
  // is omitted rather than letting the whole usage insert and its charge fail.
  const type =
    input.type !== undefined &&
    input.type.length <= EXA_USAGE_TYPE_MAX_LENGTH &&
    !input.type.includes('\u0000')
      ? input.type
      : undefined;

  return {
    id: input.id,
    occurredAt: input.occurredAt,
    userId: input.userId,
    organizationId: input.organizationId ?? null,
    path: input.path,
    costMicrodollars: input.costMicrodollars,
    chargedToBalance: input.chargedToBalance,
    freeAllowanceMicrodollars: input.freeAllowanceMicrodollars,
    ...(featureId === undefined ? {} : { featureId }),
    ...(type === undefined ? {} : { type }),
  };
}
