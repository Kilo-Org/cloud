import { createHash } from 'node:crypto';
import {
  watchPrDefaultTrustedBotLogins,
  watchPrMaintenanceReplyMarker,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { getCurrentReviewSummaryForContext } from '../code-reviews/summary/history';

const codeSegments = /`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*`/g;

function stripHtmlComments(body: string): string {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const start = body.indexOf('<!--', from);
    if (start === -1) break;
    const end = body.indexOf('-->', start + 4);
    if (end === -1) break;
    parts.push(body.slice(from, start));
    from = end + 3;
  }
  parts.push(body.slice(from));
  return parts.join('');
}

export function hasWatchPrMaintenanceReplyMarker(body: string): boolean {
  return body.replace(codeSegments, '').includes(watchPrMaintenanceReplyMarker);
}

function isClearAcknowledgement(body: string): boolean {
  const text = stripHtmlComments(body)
    .trim()
    .replace(/^(?:@[a-z0-9][a-z0-9-]{0,38}[ \t]+)+/i, '')
    .trim();
  return (
    /^(?:thanks|thank you|lgtm|looks good(?: to me)?|approved|ack(?:nowledged)?|done|👍|✅)[.! \t]*$/i.test(
      text
    ) ||
    /^(?:✅[ \t]*)?(?:all checks(?: have)? passed|tests passed|ci (?:is )?(?:running|pending|green)|build (?:passed|succeeded)|deployment (?:succeeded|is ready)|review (?:is running|in progress|completed))[.! \t]*$/i.test(
      text
    )
  );
}

export function watchPrFeedbackContent(body: string | null, authorLogin?: string): string {
  const text = body ?? '';
  if (isClearAcknowledgement(text)) return '';
  if (
    !watchPrDefaultTrustedBotLogins.some(login => login === authorLogin?.toLowerCase()) ||
    !text.trimStart().startsWith('<!-- kilo-review -->')
  )
    return text;
  const code: string[] = [];
  const prefix = `KILO_PR_CODE_${createHash('sha256').update(text).digest('hex')}_`;
  const protectedText = text.replace(codeSegments, value => `${prefix}${code.push(value) - 1}_END`);
  const current = getCurrentReviewSummaryForContext(protectedText);
  const content = current.replace(/^##[ \t]+Code Review[^\r\n]*(?:\r?\n)+/, '').trimStart();
  if (/^\*\*Status:\*\*[ \t]*(?:No Issues Found|No New Issues)\b/i.test(content)) return '';
  if (/^\*\*This review did not (?:finish|run)\.\*\*/.test(content)) return '';
  return content
    .replace(/^\*\*Status:\*\*[^\r\n]*(?:\r?\n|$)/i, '')
    .replace(
      /^##[ \t]+Fix Link(?:[ \t]*\([^\r\n]*\))?[ \t]*(?:\r?\n|$)[\s\S]*?(?=^##[ \t]+|(?![\s\S]))/gim,
      ''
    )
    .trim()
    .replace(
      new RegExp(`${prefix}(\\d+)_END`, 'g'),
      (value, index: string) => code[Number(index)] ?? value
    );
}

export function watchPrContentFingerprint(body: string): string {
  const text = body.replace(/\r\n/g, '\n');
  const segments = new RegExp(`<!--|${codeSegments.source}`, 'g');
  const normalized: string[] = [];
  let prose = '';
  let from = 0;
  let commentEndMissing = false;
  for (let match = segments.exec(text); match; match = segments.exec(text)) {
    if (match[0] === '<!--') {
      if (commentEndMissing) continue;
      const end = text.indexOf('-->', segments.lastIndex);
      if (end === -1) {
        commentEndMissing = true;
        continue;
      }
      prose += text.slice(from, match.index);
      from = segments.lastIndex = end + 3;
    } else {
      prose += text.slice(from, match.index);
      normalized.push(prose.replace(/\s+/g, ' '), match[0]);
      prose = '';
      from = segments.lastIndex;
    }
  }
  prose += text.slice(from);
  normalized.push(prose.replace(/\s+/g, ' '));
  return createHash('sha256').update(normalized.join('').trim()).digest('hex');
}
