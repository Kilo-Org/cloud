/** Limits and wording for one caller's companion-file rules. */
export type SkillCompanionFileSpec = {
  maxFiles: number;
  maxFileSize: number;
  maxTotalSize: number;
  /** Key-length rule. Omit where the schema enforces key length itself. */
  pathLength?: { max: number; tooLong: (path: string) => string };
  tooManyFiles: string;
  pathInvalidCharacters: (path: string) => string;
  pathRejected: (path: string) => string;
  manifestInFiles: string;
  fileTooLarge: (path: string) => string;
  totalTooLarge: (total: number) => string;
};

const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Report companion-file violations for a skill's `files` map.
 *
 * The profile storage schema and the runtime mirror both call this, so a path
 * rule cannot reach only one side of the intersection that admits an imported
 * skill. Limits and wording stay the caller's: they differ per side and are
 * supplied through `spec`.
 */
export function skillCompanionFileIssues(
  files: Record<string, string>,
  spec: SkillCompanionFileSpec,
  addIssue: (message: string) => void
): void {
  const entries = Object.entries(files);
  if (entries.length > spec.maxFiles) {
    addIssue(spec.tooManyFiles);
  }

  const pathLength = spec.pathLength;
  let total = 0;
  for (const [path, content] of entries) {
    if (pathLength && (path.length === 0 || path.length > pathLength.max)) {
      addIssue(pathLength.tooLong(path));
      return;
    }
    if (!SKILL_FILE_PATH_PATTERN.test(path)) {
      addIssue(spec.pathInvalidCharacters(path));
      return;
    }
    if (path.startsWith('/') || path.includes('..') || path.includes('//')) {
      addIssue(spec.pathRejected(path));
      return;
    }
    if (path === 'SKILL.md' || path.toLowerCase() === 'skill.md') {
      addIssue(spec.manifestInFiles);
      return;
    }
    if (content.length > spec.maxFileSize) {
      addIssue(spec.fileTooLarge(path));
      return;
    }
    total += content.length;
  }

  if (total > spec.maxTotalSize) {
    addIssue(spec.totalTooLarge(total));
  }
}
