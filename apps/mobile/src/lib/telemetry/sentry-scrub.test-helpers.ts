import { scrubEvent as scrubEventOrDrop } from './sentry-scrub';

/**
 * `scrubEvent` for tests that check what a scrubbed event keeps: a dropped event
 * (`null`, which a scrub that throws returns) fails the test instead.
 */
export function scrubEvent<T>(event: T): T {
  const scrubbed = scrubEventOrDrop(event);
  if (scrubbed === null) {
    throw new Error('scrubEvent dropped the event');
  }
  return scrubbed;
}
