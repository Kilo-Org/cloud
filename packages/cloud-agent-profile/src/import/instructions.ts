import * as z from 'zod';

/**
 * Imported instruction files are materialized as `.kilocode/rules/<name>.md`
 * next to the Cloud-Agent-owned `cloud-agent.md`, so the derived name must be
 * a filesystem-safe slug and must not shadow that reserved file.
 */
export const MAX_IMPORT_INSTRUCTIONS = 50;
export const MAX_IMPORT_INSTRUCTION_LENGTH = 100_000;
export const MAX_IMPORT_INSTRUCTION_NAME_LENGTH = 100;

export const RESERVED_INSTRUCTION_NAMES = new Set(['cloud-agent']);

export const instructionNameSchema = z
  .string()
  .min(1)
  .max(MAX_IMPORT_INSTRUCTION_NAME_LENGTH)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Instruction name must be a lowercase slug')
  .refine(name => !RESERVED_INSTRUCTION_NAMES.has(name), {
    message:
      'Instruction name conflicts with the Cloud-Agent-owned rules file; choose another name',
  });

export const instructionImportSchema = z.object({
  name: instructionNameSchema,
  content: z
    .string()
    .min(1)
    .max(
      MAX_IMPORT_INSTRUCTION_LENGTH,
      `Instruction content exceeds ${MAX_IMPORT_INSTRUCTION_LENGTH} bytes`
    ),
});

/** Derive a rules filename slug from an archive-relative markdown path. */
export function slugifyInstructionName(relativePath: string): string {
  return relativePath
    .replace(/\.md$/i, '')
    .toLowerCase()
    .split('/')
    .join('-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Canonical identity of an archived instruction file. The `instructions/`
 * directory prefix is not part of the identity, so directory discovery and a
 * `kilo.json` glob that match the same file derive one name instead of two.
 */
export function instructionNameForPath(relativePath: string): string {
  return slugifyInstructionName(relativePath.replace(/^instructions\//i, ''));
}
