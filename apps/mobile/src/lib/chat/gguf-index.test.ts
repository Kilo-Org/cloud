import { describe, expect, it } from 'vitest';

import {
  ggufModelName,
  modelIndexIsReadable,
  modelIndexMentionedNames,
  orphanedModelFiles,
  readModelIndex,
} from './gguf-records';

const saved = {
  fileId: 'here',
  name: 'Here',
  url: 'https://example.com/h.gguf',
  sizeBytes: 10,
  contextWindow: 4096,
  tools: false,
};

describe('the saved model list', () => {
  it('keeps the entries it can read and drops only the ones it cannot', () => {
    const records = readModelIndex(JSON.stringify([saved, { fileId: 'other', name: 'Other' }]));

    expect(records.map(record => record.fileId)).toEqual(['here']);
  });

  it('reads nothing out of text that is not a list', () => {
    expect(readModelIndex('{ not json')).toEqual([]);
    expect(readModelIndex('{"fileId":"one"}')).toEqual([]);
    expect(modelIndexIsReadable('{ not json')).toBe(false);
    expect(modelIndexIsReadable('[]')).toBe(true);
  });

  it('names every file the list mentions, whatever shape its entries have', () => {
    const names = modelIndexMentionedNames(
      JSON.stringify([saved, { fileId: 'other', name: 'Other' }, { name: 'Nameless' }])
    );

    expect([...names].toSorted()).toEqual([ggufModelName('here'), ggufModelName('other')]);
  });

  it('deletes only files the list never names', () => {
    const names = ['here.gguf', 'other.gguf', 'orphan.gguf', 'partial.gguf.part'];
    const index = JSON.stringify([saved, { fileId: 'other', name: 'Other' }]);
    const keep = new Set([ggufModelName('here'), 'partial.gguf.part']);

    expect(orphanedModelFiles(names, index, keep)).toEqual(['orphan.gguf']);
  });

  it('deletes nothing when the list cannot be read', () => {
    // A shape change or a truncated write must not destroy every download.
    expect(orphanedModelFiles(['here.gguf'], '{ not json', new Set())).toEqual([]);
  });
});
