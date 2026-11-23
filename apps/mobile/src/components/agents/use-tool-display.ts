import { useMemo } from 'react';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { getLanguageSnapshot } from '@/i18n';

import { getToolDisplay, type ToolDisplay } from './tool-card-display';

/**
 * `getToolDisplay` for a render body: the projection cuts a label with the
 * grapheme segmenter, and reads translated copy and a formatted badge, so it is
 * memoized on the part and the language rather than recomputed on every
 * re-render of a settled row. The language is a dependency because an in-place
 * switch re-renders the card with the same part, and the projection must then
 * resolve its copy in the new language.
 */
export function useToolDisplay(part: ToolPart): ToolDisplay {
  return useMemo(
    () => getToolDisplay(part),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the language snapshot is a real input: getToolDisplay resolves its copy and its badge through i18n, so the projection must re-derive when the app language changes
    [part, getLanguageSnapshot()]
  );
}
