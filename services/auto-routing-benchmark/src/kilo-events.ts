/**
 * What the measured turn did with tools. Only events of the run itself count: a continuation
 * case's imported steps are not replayed on stdout.
 */
export type ToolEvidence = {
  /** Tool calls that finished, completed or failed. */
  calls: number;
  /** Distinct tool names in first-use order. */
  names: string[];
  steps: number;
  /** `reason` of the last step_finish: `stop` ends the turn, `tool-calls` expects another step. */
  finalFinishReason: string | null;
};

export type ParsedKiloRun = {
  text: string;
  costUsd: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  // Diagnostics for empty-output investigations: how many event lines parsed
  // and the trailing event types (never the payloads, which may be sensitive).
  eventCount: number;
  lastEventTypes: string[];
  tools: ToolEvidence;
};

type LooseEvent = {
  type?: unknown;
  text?: unknown;
  cost?: unknown;
  time?: { end?: unknown };
  part?: {
    text?: unknown;
    cost?: unknown;
    tool?: unknown;
    reason?: unknown;
    tokens?: {
      input?: unknown;
      cache?: { read?: unknown };
      output?: unknown;
      reasoning?: unknown;
    };
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

function readTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseKiloRunEvents(lines: string[]): ParsedKiloRun {
  const textParts: string[] = [];
  let costUsd: number | null = null;
  let inputTokens: number | null = null;
  let cachedInputTokens: number | null = null;
  let outputTokens: number | null = null;
  let reasoningTokens: number | null = null;
  const eventTypes: string[] = [];
  const tools: ToolEvidence = { calls: 0, names: [], steps: 0, finalFinishReason: null };

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

    if (evt.type === 'tool_use') {
      tools.calls += 1;
      const name = evt.part?.tool;
      if (typeof name === 'string' && !tools.names.includes(name)) tools.names.push(name);
    }

    if (evt.type === 'step_start' || evt.type === 'step-start') tools.steps += 1;

    // The CLI emits `step_finish` at the top level (part.type is the
    // hyphenated `step-finish`); accept both spellings across versions.
    if (evt.type === 'step_finish' || evt.type === 'step-finish') {
      const cost = readCost(evt);
      if (cost !== null) costUsd = (costUsd ?? 0) + cost;
      const tokens = evt.part?.tokens;
      const input = readTokenCount(tokens?.input);
      const cachedInput = readTokenCount(tokens?.cache?.read);
      const output = readTokenCount(tokens?.output);
      const reasoning = readTokenCount(tokens?.reasoning);
      if (input !== null) inputTokens = (inputTokens ?? 0) + input;
      if (cachedInput !== null) cachedInputTokens = (cachedInputTokens ?? 0) + cachedInput;
      if (output !== null) outputTokens = (outputTokens ?? 0) + output;
      if (reasoning !== null) reasoningTokens = (reasoningTokens ?? 0) + reasoning;
      const reason = evt.part?.reason;
      tools.finalFinishReason = typeof reason === 'string' ? reason : null;
    }
  }

  return {
    text: textParts.join('\n'),
    costUsd,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    eventCount: eventTypes.length,
    lastEventTypes: eventTypes.slice(-3),
    tools,
  };
}
