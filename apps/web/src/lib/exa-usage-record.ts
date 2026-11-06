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
  const type =
    input.type !== undefined && input.type.length <= EXA_USAGE_TYPE_MAX_LENGTH
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
