import { Context } from 'effect';

/**
 * How many web searches one question may spend. Each search Kilo answers draws
 * on the account's allowance, so a model that keeps searching is stopped here,
 * as the extension's tool stops it. An attempt that produced no answer, because
 * the device was offline, the person was signed out, the proxy was unreachable,
 * the proxy refused, or the attempt timed out, costs nothing.
 */
export const MAX_SEARCHES_PER_QUESTION = 5;

/**
 * How many web searches one question may send, answered or not. A model whose
 * searches keep failing would otherwise retry until the chat loop's round
 * ceiling, and every attempt costs a round trip. A failed attempt spends a
 * fraction here but nothing of the answered-search allowance.
 *
 * The answered-search slot is reserved together with this one, before the
 * search leaves the device, so a turn that issues all its calls at once is
 * bounded by whichever cap it reaches first. One call after another still
 * reaches this higher bound.
 */
export const MAX_ATTEMPTS_PER_QUESTION = 15;

export type QuestionSearches = {
  /** Searches Kilo answered, which draw on the account's allowance. */
  used: number;
  /** Searches sent, answered or not. */
  attempts: number;
};

/**
 * The searches spent on the question being answered.
 *
 * Tools are shared by every chat and are told nothing about the session that
 * calls them, but a tool runs inside the fiber that reads the answer. The
 * registry sets a fresh counter on that fiber for each question, so a retry and
 * a new question both start from zero. Outside an answer there is none, and
 * nothing is counted.
 */
export const questionSearches = Context.Reference<QuestionSearches | undefined>(
  'kilo/questionSearches',
  { defaultValue: () => undefined }
);
