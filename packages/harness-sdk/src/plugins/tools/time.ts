import { Clock, Effect } from 'effect';
import type { JsonSchema, Tool, ToolCall } from '../../core/tool.js';

/**
 * What time it is.
 *
 * A model does not know. It knows roughly when it was trained, states that date
 * with the same confidence it states everything else, and is wrong by however
 * long it has been since. Every harness hits this: a model asked how old a file
 * is, whether a deadline has passed, or what to put at the top of a changelog
 * answers from a stale prior and nothing in the reply says so.
 *
 * The fix is one call, and it is the package's to own for the same reason
 * `question` is: every harness needs it, and there is nothing about it a
 * harness would write differently.
 *
 * It reads the clock through Effect's `Clock`, so a test pins it rather than
 * asserting around a moving number.
 */

/**
 * Named rather than derived, because deriving the weekday needs `Intl` and this
 * does not. A model asked what day it is should not depend on a runtime's
 * locale data being complete.
 */
const weekdays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** No arguments. There is nothing about the current time for a model to choose. */
const parameters: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const description =
  'Answers with the current date and time. Call it whenever the answer depends ' +
  'on what the date is now — how old something is, whether a deadline has ' +
  'passed, what to write as today — rather than working from the date you were ' +
  'trained on, which is in the past and which you cannot tell has moved.';

/** What the caller may change. Everything else is the clock's. */
interface TimeOptions {
  /** The name the model calls it by, for a harness that already has one. */
  readonly name?: string;
  /**
   * An IANA zone — `Europe/Amsterdam` — to give the local time in as well.
   *
   * The harness's and never the model's: a model naming its own zone guesses,
   * and a guess that is not a zone is a failed call for no gain. UTC is always
   * given, so a harness that leaves this out loses nothing a model can reason
   * with, and a runtime without complete `Intl` data must leave it out.
   */
  readonly zone?: string;
}

/** ISO 8601 to the second. The milliseconds are noise in an answer. */
const utcOf = (at: Date): string => `${at.toISOString().slice(0, 19)}Z`;

/**
 * The same layout as the UTC line, assembled from named parts.
 *
 * The parts are read out by name rather than taking a locale's own formatting,
 * so the answer does not change shape with the runtime's locale data. The
 * shorter version of this was `toLocaleString('sv-SE')`, which reads as ISO
 * only because Swedish convention happens to be — and which falls back to
 * another format, silently and with no error, on a runtime whose ICU data does
 * not carry Swedish.
 *
 * `h23` and not `hour12: false`: the two differ at midnight, where some ICU
 * versions answer hour 24.
 */
const localOf = (at: Date, zone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const of = (type: string): string => parts.find(part => part.type === type)?.value ?? '';
  return `${of('year')}-${of('month')}-${of('day')} ${of('hour')}:${of('minute')}:${of('second')}`;
};

const wordsFor = (at: Date, zone: string | undefined): string => {
  const now = `${utcOf(at)} (${weekdays[at.getUTCDay()] ?? ''}, UTC)`;
  return zone === undefined ? now : `${now}\n${zone}: ${localOf(at, zone)}`;
};

/**
 * The tool.
 *
 * `run` reads nothing off the call, so there is nothing to validate: the model
 * sends `{}` and a model that sends more is answered anyway rather than being
 * failed over a field nobody reads.
 */
const timeTool = (options?: TimeOptions): Tool => ({
  definition: { name: options?.name ?? 'time', description, parameters },
  run: (_call: ToolCall) =>
    Effect.map(Clock.currentTimeMillis, (at: number) => wordsFor(new Date(at), options?.zone)),
});

export type { TimeOptions };
export { timeTool };
