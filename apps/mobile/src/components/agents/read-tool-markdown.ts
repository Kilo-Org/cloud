import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';

export type ReadFileDisplay = {
  path: string;
  text: string;
  lineStart: number;
  lineEnd: number;
  totalLines: number;
  truncated: boolean;
};

export type MarkdownBody = {
  /** Full markdown for the sheet body, code fences balanced. */
  text: string;
  /** e.g. 'lines 201–400 of 1,450'. Undefined for a complete, untruncated read. */
  footer: string | undefined;
};

export type ReadCodeBody = {
  /** Raw file text for the highlighted code body; fences are NOT balanced. */
  text: string;
  /** Resolved path, used to pick the highlight language. */
  path: string;
  /** e.g. 'lines 201–400 of 1,450'. Undefined for a complete, untruncated read. */
  footer: string | undefined;
};

export function isMarkdownPath(filePath: string): boolean {
  return /\.mdx?$/i.test(filePath.trim());
}

/** Zod's validation `.catch()` fallback, not a Promise catch. */
function tolerant<T>(schema: z.ZodType<T>, fallback: T): z.ZodType<T> {
  // oxlint-disable-next-line promise/prefer-await-to-then -- zod schema fallback, not a Promise
  return schema.catch(fallback);
}

const readFileDisplaySchema = z.object({
  display: z.object({
    type: z.literal('file'),
    text: z.string(),
    path: tolerant(z.string(), ''),
    lineStart: z.number(),
    lineEnd: z.number(),
    totalLines: z.number(),
    truncated: tolerant(z.literal(true), false),
  }),
});

export function parseReadFileDisplay(metadata: unknown): ReadFileDisplay | undefined {
  const parsed = readFileDisplaySchema.safeParse(metadata);
  if (!parsed.success) {
    return undefined;
  }
  const { path, text, lineStart, lineEnd, totalLines, truncated } = parsed.data.display;
  return { path, text, lineStart, lineEnd, totalLines, truncated };
}

const LINE_PREFIX = /^(\d+): (.*)$/;
const TRAILER = /\n\n\((End of file[^)]*|Showing lines[^)]*|Output capped[^)]*)\)$/;
const PATH_RE = /^<path>(.*)<\/path>$/m;

function contentBlockEnd(output: string, start: number): number {
  const closed = output.lastIndexOf('\n</content>');
  if (closed > start) {
    return closed;
  }
  const reminder = output.indexOf('\n\n<system-reminder>', start);
  return reminder !== -1 ? reminder : output.length;
}

function stripLinePrefixes(body: string):
  | {
      text: string;
      lineStart: number;
      lineEnd: number;
    }
  | undefined {
  const lines = body.split('\n');
  const stripped: string[] = [];
  let lineStart = 0;
  let lastMatchingNumber = 0;

  for (const [index, line] of lines.entries()) {
    const match = LINE_PREFIX.exec(line);
    if (index === 0 && !match) {
      return undefined;
    }
    if (match) {
      const num = Number(match[1]);
      if (index === 0) {
        lineStart = num;
      }
      lastMatchingNumber = num;
      stripped.push(match[2] ?? '');
    } else {
      stripped.push(line);
    }
  }

  return {
    text: stripped.join('\n'),
    lineStart,
    lineEnd: lastMatchingNumber,
  };
}

function trailerFields(trailer: string | undefined, lineEnd: number) {
  if (!trailer) {
    return { totalLines: lineEnd, truncated: false };
  }
  const totalMatch = /total (\d+) lines/.exec(trailer);
  if (totalMatch) {
    return { totalLines: Number(totalMatch[1]), truncated: false };
  }
  const ofMatch = /of (\d+)\./.exec(trailer);
  if (ofMatch) {
    return { totalLines: Number(ofMatch[1]), truncated: true };
  }
  if (trailer.startsWith('Output capped')) {
    return { totalLines: lineEnd, truncated: true };
  }
  return { totalLines: lineEnd, truncated: false };
}

export function parseReadOutputFallback(output: string): ReadFileDisplay | undefined {
  const marker = '<content>\n';
  const start = output.indexOf(marker);
  if (start === -1) {
    return undefined;
  }

  const pathMatch = PATH_RE.exec(output);
  const path = pathMatch?.[1] ?? '';
  const end = contentBlockEnd(output, start);

  let body = output.slice(start + marker.length, end);
  const trailerMatch = TRAILER.exec(body);
  const trailer = trailerMatch?.[1];
  if (trailerMatch) {
    body = body.slice(0, trailerMatch.index);
  }

  if (body === '') {
    return {
      path,
      text: '',
      lineStart: 1,
      lineEnd: 0,
      totalLines: 0,
      truncated: false,
    };
  }

  const parsed = stripLinePrefixes(body);
  if (!parsed) {
    return undefined;
  }

  const { totalLines, truncated } = trailerFields(trailer, parsed.lineEnd);
  return {
    path,
    text: parsed.text,
    lineStart: parsed.lineStart,
    lineEnd: parsed.lineEnd,
    totalLines,
    truncated,
  };
}

export function balanceCodeFences(text: string): string {
  const fenceCount = text.split('\n').filter(line => /^\s*```/.test(line)).length;
  if (fenceCount % 2 === 1) {
    return `${text}\n\`\`\``;
  }
  return text;
}

function formatGroupedNumber(n: number): string {
  return String(n).replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function buildFooter(display: ReadFileDisplay): string | undefined {
  const { truncated, lineStart, lineEnd, totalLines } = display;
  if (!truncated && lineStart <= 1 && lineEnd >= totalLines) {
    return undefined;
  }
  const a = formatGroupedNumber(lineStart);
  const b = formatGroupedNumber(lineEnd);
  if (truncated && lineEnd >= totalLines) {
    return `lines ${a}–${b} (truncated)`;
  }
  const n = formatGroupedNumber(totalLines);
  return `lines ${a}–${b} of ${n}`;
}

/** Shared completed-status display lookup for the markdown and code bodies. */
function resolveReadDisplay(part: ToolPart): ReadFileDisplay | undefined {
  if (part.state.status !== 'completed') {
    return undefined;
  }
  return parseReadFileDisplay(part.state.metadata) ?? parseReadOutputFallback(part.state.output);
}

export function resolveMarkdownBody(part: ToolPart): MarkdownBody | undefined {
  const display = resolveReadDisplay(part);
  if (!display) {
    return undefined;
  }

  return { text: balanceCodeFences(display.text), footer: buildFooter(display) };
}

export function resolveReadCodeBody(part: ToolPart): ReadCodeBody | undefined {
  const display = resolveReadDisplay(part);
  if (!display) {
    return undefined;
  }

  return { text: display.text, path: display.path, footer: buildFooter(display) };
}
