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
  duplicatePath: (path: string) => string;
  fileTooLarge: (path: string) => string;
  totalTooLarge: (total: number) => string;
};

const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;
const SKILL_MANIFEST_FILE_NAME = 'skill.md';

/**
 * The one segmentation rule for a companion-file key, shared by validation and
 * the session projection: a relative POSIX path whose segments are all
 * non-empty and neither `.` nor `..`.
 */
export function skillCompanionFileSegments(path: string): string[] | null {
  const segments = path.split('/');
  return segments.some(segment => segment === '' || segment === '.' || segment === '..')
    ? null
    : segments;
}

/**
 * Companion files to deliver for a stored skill: entries outside the path rule
 * are dropped, and the first spelling wins when two keys share a case-folded
 * value.
 */
export function acceptedSkillCompanionFiles(files: Record<string, string>): Record<string, string> {
  const accepted: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    const segments = skillCompanionFileSegments(path);
    if (segments === null) continue;
    const joined = segments.join('/');
    const folded = joined.toLowerCase();
    if (folded === SKILL_MANIFEST_FILE_NAME || seen.has(folded)) continue;
    seen.add(folded);
    accepted[joined] = content;
  }
  return accepted;
}

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
  const seen = new Set<string>();
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
    const segments = skillCompanionFileSegments(path);
    if (segments === null) {
      addIssue(spec.pathRejected(path));
      return;
    }
    if (path.includes('..')) {
      addIssue(spec.pathRejected(path));
      return;
    }
    const joined = segments.join('/');
    const folded = joined.toLowerCase();
    if (folded === SKILL_MANIFEST_FILE_NAME) {
      addIssue(spec.manifestInFiles);
      return;
    }
    if (seen.has(folded)) {
      addIssue(spec.duplicatePath(joined));
      return;
    }
    seen.add(folded);
    if (content.length > spec.maxFileSize) {
      addIssue(spec.fileTooLarge(joined));
      return;
    }
    total += content.length;
  }

  if (total > spec.maxTotalSize) {
    addIssue(spec.totalTooLarge(total));
  }
}
