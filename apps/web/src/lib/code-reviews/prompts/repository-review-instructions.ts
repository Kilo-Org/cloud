export const REVIEW_INSTRUCTIONS_FILE = 'REVIEW.md';

const MAX_REVIEW_INSTRUCTIONS_CHARS = 10_000;
const TRUNCATION_NOTE = `\n\n[${REVIEW_INSTRUCTIONS_FILE} truncated after ${MAX_REVIEW_INSTRUCTIONS_CHARS} characters.]`;

export type NormalizedRepositoryReviewInstructions = {
  content: string;
  truncated: boolean;
};

export function normalizeRepositoryReviewInstructions(
  rawContent: string | null | undefined
): NormalizedRepositoryReviewInstructions | null {
  if (rawContent == null) return null;

  const content = rawContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('')
    .filter(character => !isUnsafeControlCharacter(character))
    .join('')
    .trim();

  if (content.length === 0) return null;

  if (content.length <= MAX_REVIEW_INSTRUCTIONS_CHARS) {
    return { content, truncated: false };
  }

  return {
    content: content.slice(0, MAX_REVIEW_INSTRUCTIONS_CHARS) + TRUNCATION_NOTE,
    truncated: true,
  };
}

function isUnsafeControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    codePoint === 127
  );
}

export function formatRepositoryReviewInstructions(content: string): string {
  return `# ${REVIEW_INSTRUCTIONS_FILE} code review instructions

These repository instructions replace Kilo's default review guidance for what to flag, severity calibration, skip rules, verification bar, and summary shape. They do not override read-only mode, security/tooling constraints, or platform API instructions. @ imports are not expanded.

${content}`;
}
