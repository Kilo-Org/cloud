import { createParser } from 'eventsource-parser';

/**
 * Reads server-sent events. `eventsource-parser` holds the framing: a chunk may
 * stop in the middle of an event, a data field may run over several lines, and
 * a comment carries nothing.
 *
 * The reader holds state, so make one per stream. `[DONE]` is not part of the
 * event stream standard; it is how OpenAI marks the end, and it carries nothing.
 */
const sseReader = (): ((chunk: string) => readonly string[]) => {
  let events: string[] = [];
  const parser = createParser({
    onEvent: event => {
      events.push(event.data);
    },
  });
  return chunk => {
    events = [];
    parser.feed(chunk);
    return events.filter(data => data !== '' && data !== '[DONE]');
  };
};

export { sseReader };
