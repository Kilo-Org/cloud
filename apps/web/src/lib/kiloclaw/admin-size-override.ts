import { z } from 'zod';
import {
  INSTANCE_TIERS,
  MachineSizeSchema,
  type MachineSize,
} from '@kilocode/kiloclaw-instance-tiers';

/**
 * Two presets exposed at the admin tRPC + worker platform-route boundary
 * for temporary CPU/RAM overrides. Resolved to a `MachineSize` from the
 * existing instance-tier catalog so a hardware-shape change in the
 * catalog propagates here automatically (the catalog forbids hardware
 * shape mutation, so this coupling is safe).
 *
 * Adding a third preset is strictly additive — the DO is preset-agnostic
 * and accepts any `MachineSize`. Free-form sizes are deliberately not
 * exposed; support's real need ("OOM recovery") is covered by these two.
 */
export const AdminSizeOverridePresetSchema = z.enum(['perf-4-8', 'perf-4-16']);

export type AdminSizeOverridePreset = z.infer<typeof AdminSizeOverridePresetSchema>;

export const ADMIN_SIZE_OVERRIDE_PRESETS: readonly AdminSizeOverridePreset[] = [
  'perf-4-8',
  'perf-4-16',
] as const;

export function presetToMachineSize(preset: AdminSizeOverridePreset): MachineSize {
  return INSTANCE_TIERS[preset].machineSize;
}

/**
 * Canonical shape for the `kiloclaw_instances.admin_size_override` JSONB
 * payload. Keep in sync with `adminMachineSizeOverrideMetadata` on the
 * DO's `PersistedStateSchema` — this is the single shared schema both
 * the worker (when writing) and the admin tRPC (when reading the
 * denormalized JSONB column) validate against.
 */
export const AdminSizeOverridePayloadSchema = z.object({
  size: MachineSizeSchema,
  reason: z.string().min(1).max(500),
  actorId: z.string().min(1),
  actorEmail: z.string().email(),
  setAt: z.number().int(),
});

export type AdminSizeOverridePayload = z.infer<typeof AdminSizeOverridePayloadSchema>;
