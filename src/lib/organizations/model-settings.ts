import * as z from 'zod';

export const ToolSchema = z.enum([
  'apply_diff',
  'apply_patch',
  'delete_file',
  'edit_file',
  'search_replace',
  'search_and_replace',
  'write_file',
  'write_to_file',
]);

export type Tool = z.infer<typeof ToolSchema>;

export const ModelSettingsSchema = z.object({
  included_tools: z.array(ToolSchema), // adds to the standard tool set
  excluded_tools: z.array(ToolSchema), // removes from the standard tool set
});

export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const VersionedSettingsSchema = z.record(z.string(), ModelSettingsSchema);

export type VersionedSettings = z.infer<typeof VersionedSettingsSchema>;
