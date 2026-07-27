export const COLLAPSE_LINE_THRESHOLD = 15;
export const COLLAPSE_PREVIEW_LINES = 8;

const normalizeNewlines = (code: string): string =>
  code.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

/** Trailing-newline tolerant line count (a trailing `\n` does not create a phantom empty line). */
export const countCodeLines = (code: string): number => {
  if (code === '') {
    return 0;
  }

  const normalized = normalizeNewlines(code);
  const withoutTrailingNewline = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;

  if (withoutTrailingNewline === '') {
    return 0;
  }

  return withoutTrailingNewline.split('\n').length;
};

export const isCollapsible = (code: string): boolean =>
  countCodeLines(code) > COLLAPSE_LINE_THRESHOLD;

/** First {@link COLLAPSE_PREVIEW_LINES} lines of the code block. */
export const previewCode = (code: string): string => {
  if (code === '') {
    return '';
  }

  const normalized = normalizeNewlines(code);
  const withoutTrailingNewline = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;

  if (withoutTrailingNewline === '') {
    return '';
  }

  return withoutTrailingNewline.split('\n').slice(0, COLLAPSE_PREVIEW_LINES).join('\n');
};

export type CodeBlockChrome = 'plain' | 'expanded-no-chrome' | 'collapsible';

/**
 * Pure render decision for an assistant markdown code block.
 * - plain: short block, identical to default ReactMarkdown output
 * - expanded-no-chrome: long block while this message is still streaming
 * - collapsible: long finalized block with collapse chrome
 */
export const resolveCodeBlockChrome = ({
  collapsible,
  forceExpanded,
}: {
  readonly collapsible: boolean;
  readonly forceExpanded: boolean;
}): CodeBlockChrome => {
  if (!collapsible) {
    return 'plain';
  }

  if (forceExpanded) {
    return 'expanded-no-chrome';
  }

  return 'collapsible';
};
