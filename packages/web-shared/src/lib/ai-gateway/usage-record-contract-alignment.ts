import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import type { MicrodollarUsage } from '@kilocode/db/schema';
import type { UsageMetaData } from './processUsage.types';

/**
 * Compile-time proof that the wire schemas stay aligned with the database types.
 * If a column is added to `microdollar_usage` or a field to `UsageMetaData`
 * without updating the shared wire schemas, these assignments stop type-checking.
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

const _coreContractIsExact: CoreUsageContractMatchesDb = true;
const _metadataContractIsExact: UsageMetadataContractMatchesType = true;
void _coreContractIsExact;
void _metadataContractIsExact;
