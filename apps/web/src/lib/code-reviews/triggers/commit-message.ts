export function hasReviewSkipDirective(message: string | undefined): boolean {
  return message !== undefined && /\[(?:ci[ -]skip|skip[ -]ci)\]/i.test(message);
}
