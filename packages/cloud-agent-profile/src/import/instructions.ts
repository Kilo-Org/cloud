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

/** Prefix of a derived name whose path has no ASCII letters left to keep. */
const EMPTY_NAME_PREFIX = 'instruction';

/** Characters of a FNV-1a 32-bit digest appended to a name that lost characters. */
const NAME_HASH_LENGTH = 8;

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

/**
 * Stable 32-bit digest of an archive path, as lowercase hex. Several distinct
 * paths can fold onto one ASCII base, so the digest keeps their derived names
 * apart. It uses UTF-16 code units, so a browser and the server agree without
 * an encoding library.
 */
function pathDigest(path: string): string {
  let digest = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    digest ^= path.charCodeAt(index);
    digest = Math.imul(digest, 0x01000193);
  }
  return (digest >>> 0).toString(16).padStart(NAME_HASH_LENGTH, '0');
}

function collapseAsciiSlug(value: string): string {
  return value
    .split('/')
    .join('-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive a rules filename slug from an archive-relative markdown path.
 *
 * Accents and compatibility forms are folded to ASCII first, so `café-notes.md`
 * reads as `cafe-notes` instead of `caf-notes`. A path that loses characters in
 * that fold (non-Latin scripts, symbols, accents) also gets a stable digest of
 * the path, because several distinct files can fold onto one ASCII base; the
 * digest keeps their names distinct and deterministic. A path that exceeds the
 * name budget is truncated and digested for the same reason. Pure-ASCII paths
 * keep the plain resolved slug.
 */
export function slugifyInstructionName(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.md$/i, '');
  const lowercased = withoutExtension.toLowerCase();
  const folded = lowercased.normalize('NFKD').replace(/\p{M}/gu, '');
  const base = collapseAsciiSlug(folded);
  const lostCharacters = folded !== lowercased || /\P{ASCII}/u.test(folded);
  if (base.length === 0) {
    return `${EMPTY_NAME_PREFIX}-${pathDigest(withoutExtension)}`;
  }
  if (!lostCharacters && base.length <= MAX_IMPORT_INSTRUCTION_NAME_LENGTH) return base;

  const digest = pathDigest(withoutExtension);
  const headBudget = MAX_IMPORT_INSTRUCTION_NAME_LENGTH - NAME_HASH_LENGTH - 1;
  return `${base.slice(0, headBudget).replace(/-+$/, '')}-${digest}`;
}

/**
 * Canonical identity of an archived instruction file. The `instructions/`
 * directory prefix is not part of the identity, so directory discovery and a
 * `kilo.json` glob that match the same file derive one name instead of two.
 */
export function instructionNameForPath(relativePath: string): string {
  return slugifyInstructionName(relativePath.replace(/^instructions\//i, ''));
}
