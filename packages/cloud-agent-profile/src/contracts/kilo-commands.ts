import * as z from 'zod';

export const MAX_PROFILE_KILO_COMMANDS = 50;
export const MAX_KILO_COMMAND_NAME_LENGTH = 50;
export const MAX_KILO_COMMAND_TEMPLATE_LENGTH = 100_000;
export const MAX_KILO_COMMAND_DESCRIPTION_LENGTH = 2000;

export const BUILTIN_COMMAND_NAMES = new Set([
  'init',
  'review',
  'local-review',
  'local-review-uncommitted',
]);

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const kiloCommandNameSchema = z
  .string()
  .min(1)
  .max(MAX_KILO_COMMAND_NAME_LENGTH)
  .regex(
    COMMAND_NAME_PATTERN,
    'Command name must start with a lowercase letter and contain only lowercase letters, digits, and dashes'
  )
  .refine((name: string) => !BUILTIN_COMMAND_NAMES.has(name), {
    message: 'Name conflicts with a built-in command; choose a different name',
  });

export const kiloCommandCreateInputSchema = z.object({
  name: kiloCommandNameSchema,
  description: z.string().max(MAX_KILO_COMMAND_DESCRIPTION_LENGTH).optional(),
  template: z
    .string()
    .min(1)
    .max(
      MAX_KILO_COMMAND_TEMPLATE_LENGTH,
      `Command template exceeds ${MAX_KILO_COMMAND_TEMPLATE_LENGTH} bytes`
    ),
  agent: z.string().optional(),
  model: z.string().optional(),
  subtask: z.boolean().optional(),
});

export const kiloCommandUpdateInputSchema = z.object({
  name: kiloCommandNameSchema.optional(),
  description: z.string().max(MAX_KILO_COMMAND_DESCRIPTION_LENGTH).nullable().optional(),
  template: z
    .string()
    .min(1)
    .max(
      MAX_KILO_COMMAND_TEMPLATE_LENGTH,
      `Command template exceeds ${MAX_KILO_COMMAND_TEMPLATE_LENGTH} bytes`
    )
    .optional(),
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  subtask: z.boolean().optional(),
});

export type KiloCommandCreateInput = z.infer<typeof kiloCommandCreateInputSchema>;
export type KiloCommandUpdateInput = z.infer<typeof kiloCommandUpdateInputSchema>;
