import { z } from 'zod';

export const InstanceTierStatusSchema = z.enum(['offered', 'legacy']);

export const MachineSizeSchema = z
  .object({
    cpus: z.number().int().min(1).max(8),
    memory_mb: z.number().int().min(256).max(16384),
    cpu_kind: z.enum(['shared', 'performance']).optional(),
  })
  .readonly();

export const InstanceTierKeySchema = z.enum([
  'perf-1-3',
  'perf-4-8',
  'perf-4-16',
  'shared-2-3',
  'shared-2-4',
]);

export const InstanceTypeSchema = z.union([InstanceTierKeySchema, z.literal('custom')]);

export const InstanceTierSpecSchema = z
  .object({
    key: InstanceTierKeySchema,
    label: z.string(),
    machineSize: MachineSizeSchema,
    volumeSizeGb: z.number().int().positive(),
    status: InstanceTierStatusSchema,
  })
  .readonly();

export type MachineSize = z.infer<typeof MachineSizeSchema>;
export type InstanceTierStatus = z.infer<typeof InstanceTierStatusSchema>;
export type InstanceTierKey = z.infer<typeof InstanceTierKeySchema>;
export type InstanceType = z.infer<typeof InstanceTypeSchema>;
export type InstanceTierSpec = z.infer<typeof InstanceTierSpecSchema>;
