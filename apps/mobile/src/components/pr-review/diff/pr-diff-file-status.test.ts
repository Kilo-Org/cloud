import { describe, expect, it } from 'vitest';

import { type ProviderPrFileStatus } from '@kilocode/app-shared/provider-review';

import { File, FileMinus, FilePlus } from '@/components/ui/icons';
import { i18n } from '@/i18n';
import { fileStatusIcon, fileStatusLabel } from './pr-diff-file-status';

/**
 * Every status the contract allows, with the catalog key it paints and the
 * glyph it draws. The repository's own word for a deleted file is `deleted`;
 * the status vocabulary never carries it.
 */
const STATUSES = [
  ['added', 'common.added', FilePlus],
  ['removed', 'common.deleted', FileMinus],
  ['modified', 'prReview.fileStatus.modified', File],
  ['renamed', 'prReview.fileStatus.renamed', File],
  ['copied', 'prReview.fileStatus.copied', File],
  ['changed', 'prReview.fileStatus.changed', File],
  ['unknown', 'prReview.fileStatus.unknown', File],
] as const satisfies readonly (readonly [ProviderPrFileStatus, string, typeof File])[];

describe('fileStatusLabel', () => {
  it.each(STATUSES)('paints %s from its own catalog key', (status, key) => {
    const label = fileStatusLabel(status);
    expect(label).toBe(i18n.t(key));
    // A label that echoed the provider's word would be untranslated copy.
    expect(label).not.toBe(status);
    expect(label).not.toBe('deleted');
  });

  it('names an unrecognised provider word as unreported', () => {
    expect(fileStatusLabel('unknown')).toBe(i18n.t('prReview.fileStatus.unknown'));
  });
});

describe('fileStatusIcon', () => {
  it.each(STATUSES)('paints %s with its own glyph', (status, _key, icon) => {
    expect(fileStatusIcon(status)).toBe(icon);
  });
});
