import type { ReasoningPart } from './types';

function formatReasoningDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  return `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h`;
}

export function getReasoningHeader(
  title: string | undefined,
  time: ReasoningPart['time'],
  streaming: boolean
): string {
  const label = streaming ? 'Thinking' : 'Thought';
  const duration =
    !streaming && time.end !== undefined
      ? formatReasoningDuration(Math.max(0, time.end - time.start))
      : undefined;
  const detail = [title, duration].filter(Boolean).join(' · ');
  return detail ? `${label}: ${detail}` : label;
}

type ReasoningPresentation = {
  title?: string;
  body: string;
};

function plainTitle(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleBody(value: string): string {
  const withoutComments = value.replace(/<!--[\s\S]*?-->/g, '');
  const openComment = withoutComments.indexOf('<!--');
  if (openComment === -1) return withoutComments.trim() ? value : '';
  const body = `${withoutComments.slice(0, openComment)}${withoutComments.slice(openComment + 4)}`;
  return body.trim() ? body.trimStart() : '';
}

function leadingHeading(
  text: string,
  expression: RegExp,
  group = 1
): ReasoningPresentation | undefined {
  const match = text.match(expression);
  const value = match?.[group];
  if (!match || !value) return undefined;
  const title = plainTitle(value);
  if (!title) return undefined;
  return { title, body: visibleBody(text.slice(match[0].length).trimStart()) };
}

export function getReasoningPresentation(text: string): ReasoningPresentation {
  const normalized = text.replaceAll('[REDACTED]', '').replace(/\r\n?/g, '\n').trim();
  return (
    leadingHeading(normalized, /^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>[ \t]*(?:\n|$)?/i) ??
    leadingHeading(normalized, /^#{1,6}[ \t]+([^\n]+?)(?:[ \t]+#+[ \t]*)?(?:\n|$)/) ??
    leadingHeading(normalized, /^([^\n]+)\n(?:=+|-+)[ \t]*(?:\n|$)/) ??
    leadingHeading(normalized, /^(\*\*|__)([^\n]+?)\1[ \t]*(?:\n|$)/, 2) ?? {
      body: visibleBody(normalized),
    }
  );
}
