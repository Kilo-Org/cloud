/**
 * Server-sent events framing. A chunk of the body can stop in the middle of an
 * event, so `frames` keeps the unfinished tail and returns it as `rest`.
 */
const frames = (buffer: string): { readonly events: readonly string[]; readonly rest: string } => {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  return { events: parts, rest };
};

/** Joins the `data:` lines of one event. Returns undefined for an event with none. */
const dataOf = (frame: string): string | undefined => {
  const data = frame
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
    .join('\n');
  return data === '' || data === '[DONE]' ? undefined : data;
};

export { dataOf, frames };
