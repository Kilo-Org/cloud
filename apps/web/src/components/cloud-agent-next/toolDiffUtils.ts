import * as z from 'zod';

export const MAX_TOOL_DIFF_CHARACTERS = 100_000;
export const MAX_TOOL_DIFF_LINES = 2_000;

const optionalText = z.string().optional().catch(undefined);
const optionalPath = z
  .string()
  .refine(value => value.trim().length > 0)
  .optional()
  .catch(undefined);
const optionalCount = z.number().int().nonnegative().optional().catch(undefined);

const fileDiffSchema = z.object({
  file: optionalPath,
  patch: optionalText,
  additions: optionalCount,
  deletions: optionalCount,
});

const fileToolMetadataSchema = z
  .object({
    filediff: fileDiffSchema.optional().catch(undefined),
    diagnostics: z.record(z.string(), z.unknown()).optional().catch(undefined),
  })
  .catch({});

const applyPatchMetadataSchema = z
  .object({ files: z.array(z.unknown()).optional().catch(undefined) })
  .catch({});

const applyPatchFileSchema = z
  .object({
    filePath: optionalPath,
    relativePath: optionalPath,
    type: z.enum(['add', 'update', 'delete', 'move']).optional().catch(undefined),
    patch: optionalText,
    diff: optionalText,
    additions: optionalCount,
    deletions: optionalCount,
    movePath: optionalPath,
  })
  .refine(file => Boolean(file.filePath || file.relativePath || file.movePath));

const diagnosticSchema = z.object({
  severity: z.literal(1),
  message: z.string().trim().min(1),
  range: z
    .object({
      start: z.object({
        line: z.number().int().nonnegative(),
        character: z.number().int().nonnegative(),
      }),
    })
    .optional()
    .catch(undefined),
});

export type ToolFileChanges = {
  additions?: number;
  deletions?: number;
};

export function readFileToolMetadata(value: unknown) {
  return fileToolMetadataSchema.parse(value);
}

export function readApplyPatchFiles(value: unknown) {
  const { files } = applyPatchMetadataSchema.parse(value);
  return (files ?? []).flatMap(file => {
    const result = applyPatchFileSchema.safeParse(file);
    return result.success ? [result.data] : [];
  });
}

export function getUnifiedPatch(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^--- [^\r\n]+\r?\n\+\+\+ [^\r\n]+/m.test(value)) return undefined;
  if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[^\r\n]*\r?\n[-+ ]/m.test(value)) {
    return undefined;
  }
  return value;
}

export function countLines(value: string): number {
  if (value.length === 0) return 0;
  let lines = value.endsWith('\n') ? 0 : 1;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\n') lines++;
  }
  return lines;
}

export function sumFileChanges(files: ToolFileChanges[]): ToolFileChanges {
  return {
    additions:
      files.length > 0 && files.every(file => file.additions !== undefined)
        ? files.reduce((total, file) => total + (file.additions ?? 0), 0)
        : undefined,
    deletions:
      files.length > 0 && files.every(file => file.deletions !== undefined)
        ? files.reduce((total, file) => total + (file.deletions ?? 0), 0)
        : undefined,
  };
}

export function readToolDiagnostics(value: unknown, filePath: string | undefined) {
  const result = z.record(z.string(), z.unknown()).safeParse(value);
  if (!result.success || !filePath) return [];
  const entries = result.data[filePath] ?? result.data[filePath.replaceAll('\\', '/')];
  if (!Array.isArray(entries)) return [];

  const diagnostics: z.infer<typeof diagnosticSchema>[] = [];
  for (const entry of entries) {
    const diagnostic = diagnosticSchema.safeParse(entry);
    if (!diagnostic.success) continue;
    const message = diagnostic.data.message;
    diagnostics.push({
      ...diagnostic.data,
      message: message.length > 400 ? `${message.slice(0, 400)}…` : message,
    });
    if (diagnostics.length === 3) break;
  }
  return diagnostics;
}
