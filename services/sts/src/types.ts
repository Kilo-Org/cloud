import {
  SecretNameSchema,
  StsEnvironmentSchema,
  WorkloadNameSchema,
} from '@kilocode/sts-contracts';
import { z } from 'zod';

export type BundleSecretValues = Record<string, { value: string; version: number }>;

export type WorkloadBundle = {
  workload: string;
  secrets: BundleSecretValues;
  missing: string[];
  fetchedAt: string;
  policyHash: string;
};

export const BundleSecretValuesSchema: z.ZodType<BundleSecretValues> = z.record(
  z.string(),
  z.object({ value: z.string(), version: z.number().int().nonnegative() })
);

export const WorkloadBundleSchema: z.ZodType<WorkloadBundle> = z.strictObject({
  workload: WorkloadNameSchema,
  secrets: BundleSecretValuesSchema,
  missing: z.array(SecretNameSchema),
  fetchedAt: z.iso.datetime(),
  policyHash: z.string().min(1),
});

export type PutBundleResult = {
  status: 'stored' | 'mismatch';
  changed: boolean;
  etag: string;
};

export const BundleTargetSchema = z.strictObject({
  workload: WorkloadNameSchema,
  environment: StsEnvironmentSchema,
});
export type BundleTarget = z.infer<typeof BundleTargetSchema>;
