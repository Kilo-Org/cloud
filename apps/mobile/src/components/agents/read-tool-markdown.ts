import { type ToolPart } from '@kilocode/cloud-agent-sdk';

/** Inline preview cap. Matches the maxLength ReadToolCard already gives MonoScrollBlock. */
export const MARKDOWN_INLINE_MAX_CHARS = 2000;

export type ReadFileDisplay = {
  path: string;
  text: string;
  lineStart: number;
  lineEnd: number;
  totalLines: number;
  truncated: boolean;
};

export type MarkdownPreview = {
  path: string;
  /** Full markdown for the reader, code fences balanced. */
  text: string;
  /** Capped copy for the card, code fences balanced. */
  inlineText: string;
  inlineTruncated: boolean;
  /** e.g. 'lines 201–400 of 1,450'. Undefined for a complete, untruncated read. */
  footer: string | undefined;
};

export function isMarkdownPath(filePath: string): boolean {
  return /\.mdx?$/i.test(filePath.trim());
}

export function parseReadFileDisplay(metadata: unknown): ReadFileDisplay | undefined {
  if (metadata === null || typeof metadata !== 'object') {
    return undefined;
  }
  const display = (metadata as { display?: unknown }).display;
  if (display === null || typeof display !== 'object') {
    return undefined;
  }
  const d = display as Record<string, unknown>;
  if (d.type !== 'file') {
    return undefined;
  }
  if (typeof d.text !== 'string') {
    return undefined;
  }
  if (
    typeof d.lineStart !== 'number' ||
    !Number.isFinite(d.lineStart) ||
    typeof d.lineEnd !== 'number' ||
    !Number.isFinite(d.lineEnd) ||
    typeof d.totalLines !== 'number' ||
    !Number.isFinite(d.totalLines)
  ) {
    return undefined;
  }
  return {
    path: typeof d.path === 'string' ? d.path : '',
    text: d.text,
    lineStart: d.lineStart,
    lineEnd: d.lineEnd,
    totalLines: d.totalLines,
    truncated: d.truncated === true,
  };
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
  let sawMatch = false;

  for (const [index, line] of lines.entries()) {
    const match = LINE_PREFIX.exec(line);
    if (index === 0 && !match) {
      return undefined;
    }
    if (match) {
      const num = Number(match[1]);
      if (!sawMatch) {
        lineStart = num;
        sawMatch = true;
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
    lineEnd: sawMatch ? lastMatchingNumber : lineStart + lines.length - 1,
  };
}

function trailerFields(
  trailer: string | undefined,
  lineEnd: number
): { totalLines: number; truncated: boolean } {
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

function buildInlineText(text: string): { inlineText: string; inlineTruncated: boolean } {
  if (text.length <= MARKDOWN_INLINE_MAX_CHARS) {
    return { inlineText: text, inlineTruncated: false };
  }
  let slice = text.slice(0, MARKDOWN_INLINE_MAX_CHARS);
  const lastNewline = slice.lastIndexOf('\n');
  if (lastNewline !== -1) {
    slice = slice.slice(0, lastNewline);
  }
  return { inlineText: balanceCodeFences(slice), inlineTruncated: true };
}

export function resolveMarkdownPreview(part: ToolPart): MarkdownPreview | undefined {
  if (part.state.status !== 'completed') {
    return undefined;
  }
  const display =
    parseReadFileDisplay(part.state.metadata) ?? parseReadOutputFallback(part.state.output);
  if (!display) {
    return undefined;
  }

  const input = part.state.input;
  const inputPath = typeof input.filePath === 'string' ? input.filePath : '';
  const path = inputPath !== '' ? inputPath : display.path;

  const text = balanceCodeFences(display.text);
  const { inlineText, inlineTruncated } = buildInlineText(text);
  const footer = buildFooter(display);

  return {
    path,
    text,
    inlineText,
    inlineTruncated,
    footer,
  };
}
