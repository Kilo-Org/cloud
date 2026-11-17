import type { EnkryptUsageWrite, UsageRecordRequest } from '@kilocode/usage-contracts';
import type { MicrodollarUsage } from '@kilocode/db/schema';
import type {
  EnkryptDetectorId,
  EnkryptGuardrailApiKind,
  EnkryptGuardrailDecision,
  EnkryptGuardrailDirection,
} from '@kilocode/db/schema-types';
import type { UsageMetaData } from './processUsage.types';

/**
 * Compile-time proof that the wire schemas stay aligned with the database types.
 * If a column is added to `microdollar_usage` or a field to `UsageMetaData`
 * without updating the shared wire schemas, these assignments stop type-checking.
 * The Enkrypt enums are literals in the contract, which cannot depend on the
 * database package, so a value added on either side also stops type-checking.
 */
type AssertExact<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : never
  : never;

export type CoreUsageContractMatchesDb = AssertExact<UsageRecordRequest['core'], MicrodollarUsage>;
export type UsageMetadataContractMatchesType = AssertExact<
  UsageRecordRequest['metadata'],
  UsageMetaData
>;
export type EnkryptApiKindContractMatchesDb = AssertExact<
  EnkryptUsageWrite['apiKind'],
  EnkryptGuardrailApiKind
>;
export type EnkryptDecisionContractMatchesDb = AssertExact<
  EnkryptUsageWrite['decision'],
  EnkryptGuardrailDecision
>;
export type EnkryptGuardrailContractMatchesDb = AssertExact<
  EnkryptUsageWrite['guardrail'],
  EnkryptGuardrailDirection
>;
export type EnkryptDetectorContractMatchesDb = AssertExact<
  NonNullable<EnkryptUsageWrite['detectorsFired']>[number],
  EnkryptDetectorId
>;

const _coreContractIsExact: CoreUsageContractMatchesDb = true;
const _metadataContractIsExact: UsageMetadataContractMatchesType = true;
const _enkryptApiKindIsExact: EnkryptApiKindContractMatchesDb = true;
const _enkryptDecisionIsExact: EnkryptDecisionContractMatchesDb = true;
const _enkryptGuardrailIsExact: EnkryptGuardrailContractMatchesDb = true;
const _enkryptDetectorIsExact: EnkryptDetectorContractMatchesDb = true;
void _coreContractIsExact;
void _metadataContractIsExact;
void _enkryptApiKindIsExact;
void _enkryptDecisionIsExact;
void _enkryptGuardrailIsExact;
void _enkryptDetectorIsExact;
