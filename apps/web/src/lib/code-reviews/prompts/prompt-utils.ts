/**
 * Prompt utilities for code review agent
 */

/**
 * Sanitizes user input by escaping special characters
 * Prevents injection attacks in prompts
 */
export function sanitizeUserInput(input: string): string {
  return input
    .replace(/[`${}]/g, '') // Remove template literal characters
    .replace(/[\r\n]+/g, ' ') // Replace newlines with spaces
    .trim();
}
