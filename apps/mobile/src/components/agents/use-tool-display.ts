import { useMemo } from 'react';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

import { getToolDisplay, type ToolDisplay } from './tool-card-display';

/**
 * `getToolDisplay` for a render body: the projection cuts a label with the
 * grapheme segmenter and reads translated copy and a formatted badge, so it is
 * memoized on the part and the language rather than recomputed on every
 * re-render of a settled row. The language is a dependency because an in-place
 * switch re-renders the card through `useTranslation` with the same part.
 */
export function useToolDisplay(part: ToolPart): ToolDisplay {
  return useMemo(() => getToolDisplay(part), [part, i18n.language]);
}
