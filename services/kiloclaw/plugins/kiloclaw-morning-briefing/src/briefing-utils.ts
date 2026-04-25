import path from 'node:path';

export type BriefingSourceStatus = {
  source: 'github' | 'linear' | 'web';
  configured: boolean;
  ok: boolean;
  summary: string;
};

export type BriefingDocumentSection = {
  title: string;
  lines: string[];
};

function readPart(parts: Intl.DateTimeFormatPart[], partType: 'year' | 'month' | 'day'): string {
  const match = parts.find(part => part.type === partType);
  if (!match) {
    throw new Error(`Unable to format ${partType} from date`);
  }
  return match.value;
}

export function formatDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = readPart(parts, 'year');
  const month = readPart(parts, 'month');
  const day = readPart(parts, 'day');
  return `${year}-${month}-${day}`;
}

export function offsetDateKey(base: Date, offset: number, timezone: string): string {
  const [year, month, day] = formatDateKey(base, timezone).split('-').map(Number);
  const copy = new Date(Date.UTC(year, month - 1, day));
  copy.setUTCDate(copy.getUTCDate() + offset);
  const offsetYear = copy.getUTCFullYear();
  const offsetMonth = String(copy.getUTCMonth() + 1).padStart(2, '0');
  const offsetDay = String(copy.getUTCDate()).padStart(2, '0');
  return `${offsetYear}-${offsetMonth}-${offsetDay}`;
}

export function resolveBriefingPath(briefingsDir: string, dateKey: string): string {
  return path.join(briefingsDir, `${dateKey}.md`);
}

export function buildBriefingMarkdown(params: {
  dateKey: string;
  generatedAt: Date;
  statuses: BriefingSourceStatus[];
  sections: BriefingDocumentSection[];
  failures: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# Morning Briefing - ${params.dateKey}`);

  for (const section of params.sections) {
    if (section.lines.length === 0) {
      continue;
    }
    lines.push('');
    lines.push(`## ${section.title}`);
    lines.push(...section.lines);
  }

  if (params.failures.length > 0) {
    lines.push('');
    lines.push('## Failures');
    for (const failure of params.failures) {
      lines.push(`- ${failure}`);
    }
  }

  lines.push('');
  lines.push('## Source Status');
  for (const status of params.statuses) {
    const marker = status.ok ? '[ok]' : status.configured ? '[error]' : '[skipped]';
    lines.push(`- ${status.source}: ${marker} ${status.summary}`);
  }

  lines.push('');
  lines.push(`_Generated at ${params.generatedAt.toISOString()}_`);
  lines.push('');

  return lines.join('\n');
}

function expandMarkdownLinks(line: string): string {
  let result = '';
  let i = 0;

  while (i < line.length) {
    const labelStart = line.indexOf('[', i);
    if (labelStart < 0) {
      result += line.slice(i);
      break;
    }

    const labelEnd = line.indexOf(']', labelStart + 1);
    if (labelEnd < 0 || line[labelEnd + 1] !== '(') {
      result += line.slice(i, labelStart + 1);
      i = labelStart + 1;
      continue;
    }

    let urlEnd = labelEnd + 2;
    let depth = 1;
    while (urlEnd < line.length && depth > 0) {
      const char = line[urlEnd];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      urlEnd += 1;
    }

    if (depth !== 0) {
      result += line.slice(i, labelStart + 1);
      i = labelStart + 1;
      continue;
    }

    const label = line.slice(labelStart + 1, labelEnd);
    const url = line.slice(labelEnd + 2, urlEnd - 1);

    result += line.slice(i, labelStart);
    result += `${label} - ${url}`;
    i = urlEnd;
  }

  return result;
}

function convertInlineMarkdownToText(line: string): string {
  const withLinksExpanded = expandMarkdownLinks(line);
  return withLinksExpanded
    .replace(/\[(ok|error|skipped)\]/gi, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

export function formatBriefingMarkdownForMessage(markdown: string): string {
  const transformedLines = markdown.split(/\r?\n/).map(rawLine => {
    const heading = /^#{1,2}\s+(.+)$/.exec(rawLine);
    if (heading) {
      return heading[1]?.trim() ?? '';
    }

    if (/^_.*_$/.test(rawLine.trim())) {
      return rawLine.trim().slice(1, -1);
    }

    if (rawLine.startsWith('- ')) {
      return `• ${convertInlineMarkdownToText(rawLine.slice(2))}`;
    }

    return convertInlineMarkdownToText(rawLine);
  });

  const compacted: string[] = [];
  let previousBlank = false;
  for (const line of transformedLines) {
    const blank = line.trim().length === 0;
    if (blank && previousBlank) {
      continue;
    }
    compacted.push(line);
    previousBlank = blank;
  }

  return compacted.join('\n').trim();
}
