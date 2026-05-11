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
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  if (content.trim().length === 0) return null;

  if (content.length <= MAX_REVIEW_INSTRUCTIONS_CHARS) {
    return { content, truncated: false };
  }

  return {
    content: content.slice(0, MAX_REVIEW_INSTRUCTIONS_CHARS) + TRUNCATION_NOTE,
    truncated: true,
  };
}

export function formatRepositoryReviewInstructions(content: string): string {
  return `# ${REVIEW_INSTRUCTIONS_FILE} code review instructions

These repository instructions replace Kilo's default review guidance for what to flag, severity calibration, skip rules, verification bar, and summary shape. They do not override read-only mode, security/tooling constraints, or platform API instructions. @ imports are not expanded.

${content}`;
}
