// Shared status helpers for PR file rows. The status vocabulary is the
// contract's closed one (`ProviderPrFileStatus`), so a word the providers do
// not share cannot reach a row: every label comes from a catalog key and every
// icon from the three file glyphs.

import { type ProviderPrFileStatus } from '@kilocode/app-shared/provider-review';

import { File, FileMinus, FilePlus } from '@/components/ui/icons';
import { i18n } from '@/i18n';

/**
 * One key per status. The record is exhaustive, so a status added to the
 * contract fails this module instead of painting a raw provider word.
 */
const STATUS_LABEL_KEY = {
  added: 'common.added',
  removed: 'common.deleted',
  modified: 'prReview.fileStatus.modified',
  renamed: 'prReview.fileStatus.renamed',
  copied: 'prReview.fileStatus.copied',
  changed: 'prReview.fileStatus.changed',
  unknown: 'prReview.fileStatus.unknown',
} as const satisfies Record<ProviderPrFileStatus, string>;

export function fileStatusLabel(status: ProviderPrFileStatus): string {
  return i18n.t(STATUS_LABEL_KEY[status]);
}

const STATUS_ICON = {
  added: FilePlus,
  removed: FileMinus,
  modified: File,
  renamed: File,
  copied: File,
  changed: File,
  unknown: File,
} as const satisfies Record<ProviderPrFileStatus, typeof File>;

export function fileStatusIcon(status: ProviderPrFileStatus) {
  return STATUS_ICON[status];
}
