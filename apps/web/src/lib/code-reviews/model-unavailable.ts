export const CODE_REVIEW_MODEL_UNAVAILABLE_PREFLIGHT_MESSAGE =
  'Selected model is not available for this cloud agent session';
export const CODE_REVIEW_MODEL_UNAVAILABLE_PREFLIGHT_SQL_LITERAL = `'%${CODE_REVIEW_MODEL_UNAVAILABLE_PREFLIGHT_MESSAGE}%'`;

const NORMALIZED_CODE_REVIEW_MODEL_UNAVAILABLE_PREFLIGHT_MESSAGE =
  CODE_REVIEW_MODEL_UNAVAILABLE_PREFLIGHT_MESSAGE.toLowerCase();

export function isCodeReviewModelUnavailableFailure(
  terminalReason?: string | null,
  errorMessage?: string | null
): boolean {
  if (terminalReason === 'model_not_found') {
    return true;
  }

  const message = errorMessage?.toLowerCase();
  if (!message) {
    return false;
  }

  return (
    /\bmodel\s+not\s+found\b/i.test(message) ||
    message.includes(NORMALIZED_CODE_REVIEW_MODEL_UNAVAILABLE_PREFLIGHT_MESSAGE)
  );
}
