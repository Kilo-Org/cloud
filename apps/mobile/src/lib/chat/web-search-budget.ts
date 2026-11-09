import { Context } from 'effect';

/**
 * How many web searches one question may spend. Each search draws on the
 * account's allowance, so a model that keeps searching is stopped here, as the
 * extension's tool stops it.
 */
export const MAX_SEARCHES_PER_QUESTION = 5;

export type QuestionSearches = { used: number };

/**
 * The searches spent on the question being answered.
 *
 * Tools are shared by every chat and are told nothing about the session that
 * calls them, but a tool runs inside the fiber that reads the answer. The
 * registry sets a fresh counter on that fiber for each question, so a new
 * question and a retry both start from zero. Outside an answer there is none,
 * and nothing is counted.
 */
export const questionSearches = Context.Reference<QuestionSearches | undefined>(
  'kilo/questionSearches',
  { defaultValue: () => undefined }
);
