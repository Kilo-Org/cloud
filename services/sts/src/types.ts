import {
  SecretNameSchema,
  StsEnvironmentSchema,
  WorkloadNameSchema,
} from '@kilocode/sts-contracts';
import { z } from 'zod';

/** A bundle's secrets as STS stores them: the manager id rides along for change detection. */
export type BundleSecrets = Record<string, { value: string; version: number; id: string }>;

export const BundleSecretsSchema: z.ZodType<BundleSecrets> = z.record(
  SecretNameSchema,
  z.strictObject({
    value: z.string(),
    version: z.number().int().nonnegative(),
    id: z.string().min(1),
  })
);

/**
 * What the refresher hands a bundle object. `stale` is true when it was built from a manager copy
 * the refresher could not confirm at its last read; `policyHash` is the workload's own policy hash.
 */
export type WorkloadBundle = {
  workload: string;
  secrets: BundleSecrets;
  missing: string[];
  fetchedAt: string;
  policyHash: string;
  stale: boolean;
};

export const WorkloadBundleSchema: z.ZodType<WorkloadBundle> = z.strictObject({
  workload: WorkloadNameSchema,
  secrets: BundleSecretsSchema,
  missing: z.array(SecretNameSchema),
  fetchedAt: z.iso.datetime(),
  policyHash: z.string().min(1),
  stale: z.boolean(),
});

export type PutBundleResult =
  | { status: 'stored'; changed: boolean; etag: string }
  | { status: 'mismatch' };

/** What a fill asks the refresher for: a bundle, or why there is none. */
export type FillResult =
  | { status: 'built'; bundle: WorkloadBundle }
  | { status: 'no_policy' }
  | { status: 'unavailable' };

export const BundleTargetSchema = z.strictObject({
  workload: WorkloadNameSchema,
  environment: StsEnvironmentSchema,
});
