import type { DeciderCase } from './datasets/decider-cases';
import { materializeLongContext } from './datasets/long-context';

// Appended to every decider prompt: the agent harness tends to wrap answers
// in prose ("The output is: ..."), which strict mechanical checks reject.
// One uniform instruction across all candidate models keeps grading fair.
export const FINAL_ANSWER_SUFFIX =
  '\n\nIMPORTANT: Your final message must contain ONLY the answer in the exact requested format - no explanations, no preamble, no extra words.';

/**
 * The text the CLI sends as the task: its system prompt folded into the user message,
 * because `kilo run` has no system-prompt flag.
 */
export function promptText(prompts: { systemPrompt: string; userPrompt: string }): string {
  return `${prompts.systemPrompt}\n\n${prompts.userPrompt}${FINAL_ANSWER_SUFFIX}`;
}

/** The task prompt of a decider case, long-context snapshot included. */
export function taskPrompt(benchCase: DeciderCase): string {
  return promptText(materializeLongContext(benchCase));
}
