// Pure parser for the `kilo run --format json` event stream.
//
// The CLI emits one JSON event per line on stdout. We care about two things:
//   1. The final assistant answer — assembled from completed `text` events
//      (those whose part has `time.end` set), concatenated in order.
//   2. Total cost — summed across `step-finish` events' `part.cost` (USD).
//
// Event shapes vary across CLI versions; we accept both the documented
// `evt.part.*` shape and a flattened `evt.*` shape, preferring `part.*`.
// Everything is optional-chained so malformed lines can't throw.

export type ParsedKiloRun = {
  text: string;
  costUsd: number | null;
  // Diagnostics for empty-output investigations: how many event lines parsed
  // and the trailing event types (never the payloads, which may be sensitive).
  eventCount: number;
  lastEventTypes: string[];
};

type LooseEvent = {
  type?: unknown;
  text?: unknown;
  cost?: unknown;
  time?: { end?: unknown };
  part?: {
    text?: unknown;
    cost?: unknown;
    time?: { end?: unknown };
  };
};

function isCompletedTextEvent(evt: LooseEvent): boolean {
  const end = evt.part?.time?.end ?? evt.time?.end;
  return end !== undefined && end !== null;
}

function readText(evt: LooseEvent): string | null {
  const partText = evt.part?.text;
  if (typeof partText === 'string') return partText;
  if (typeof evt.text === 'string') return evt.text;
  return null;
}

function readCost(evt: LooseEvent): number | null {
  const partCost = evt.part?.cost;
  if (typeof partCost === 'number' && Number.isFinite(partCost)) return partCost;
  if (typeof evt.cost === 'number' && Number.isFinite(evt.cost)) return evt.cost;
  return null;
}

export function parseKiloRunEvents(lines: string[]): ParsedKiloRun {
  const textParts: string[] = [];
  let costUsd: number | null = null;
  const eventTypes: string[] = [];

  for (const line of lines) {
    let evt: LooseEvent;
    try {
      evt = JSON.parse(line) as LooseEvent;
    } catch {
      continue;
    }
    if (evt === null || typeof evt !== 'object') continue;
    if (typeof evt.type === 'string') eventTypes.push(evt.type);

    if (evt.type === 'text' && isCompletedTextEvent(evt)) {
      const text = readText(evt);
      if (text !== null) textParts.push(text);
    }

    // The CLI emits `step_finish` at the top level (part.type is the
    // hyphenated `step-finish`); accept both spellings across versions.
    if (evt.type === 'step_finish' || evt.type === 'step-finish') {
      const cost = readCost(evt);
      if (cost !== null) costUsd = (costUsd ?? 0) + cost;
    }
  }

  return {
    text: textParts.join('\n'),
    costUsd,
    eventCount: eventTypes.length,
    lastEventTypes: eventTypes.slice(-3),
  };
}
