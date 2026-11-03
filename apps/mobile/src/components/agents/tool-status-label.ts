import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { type TFunction } from 'i18next';

/**
 * The tool row's state in the reader's language. `part.state.status` is a wire
 * discriminator (`pending`/`running`/`completed`/`error`), so it may never fill
 * a spoken label's status slot as-is: the surrounding words are translated, and
 * the slot has to be too.
 */
export const TOOL_STATUS_LABEL_KEY = {
  pending: 'common.pending',
  running: 'common.running',
  completed: 'common.completed',
  error: 'common.failed',
} satisfies Record<ToolPart['state']['status'], string>;

/** The row's spoken state, taken from the caller's `t` so it follows a language change. */
export function toolStatusLabel(t: TFunction, status: ToolPart['state']['status']): string {
  return t(TOOL_STATUS_LABEL_KEY[status]);
}
