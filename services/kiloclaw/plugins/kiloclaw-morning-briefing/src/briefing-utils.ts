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
    lines.push('## Failures / Skipped');
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
