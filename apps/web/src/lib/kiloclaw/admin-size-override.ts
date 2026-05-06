import { z } from 'zod';
import { INSTANCE_TIERS, type MachineSize } from '@kilocode/kiloclaw-instance-tiers';

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
