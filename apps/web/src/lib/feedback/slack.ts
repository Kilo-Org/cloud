import type { SectionBlock } from '@slack/types';

const SECTION_TEXT_LIMIT = 3_000;
const MESSAGE_PREVIEW_LIMIT = 40_000;
const TRUNCATION_NOTICE = '\n[Slack preview truncated; full feedback is stored.]';

export function feedbackPlainTextBlocks(text: string): SectionBlock[] {
  const truncated = text.length > MESSAGE_PREVIEW_LIMIT;
  let previewEnd = truncated ? MESSAGE_PREVIEW_LIMIT - TRUNCATION_NOTICE.length : text.length;
  if (truncated && /[\uD800-\uDBFF]/.test(text.charAt(previewEnd - 1))) previewEnd--;
  const preview = text.slice(0, previewEnd) + (truncated ? TRUNCATION_NOTICE : '');
  const blocks: SectionBlock[] = [];

  for (let offset = 0; offset < preview.length;) {
    let end = Math.min(offset + SECTION_TEXT_LIMIT, preview.length);
    if (end < preview.length && /[\uD800-\uDBFF]/.test(preview.charAt(end - 1))) end--;
    blocks.push({
      type: 'section',
      text: { type: 'plain_text', text: preview.slice(offset, end), emoji: false },
    });
    offset = end;
  }

  return blocks;
}
