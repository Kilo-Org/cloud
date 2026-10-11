import { describe, expect, it } from 'vitest';

import {
  ggufModelName,
  ggufProjectorName,
  modelIndexFullyParsed,
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

  it('reads an entry saved before projectors existed as text-only', () => {
    expect(readModelIndex(JSON.stringify([saved]))).toEqual([{ ...saved, vision: false }]);
    expect(readModelIndex(JSON.stringify([{ ...saved, vision: true }]))[0]?.vision).toBe(true);
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

    expect([...names].toSorted()).toEqual([
      ggufModelName('here'),
      ggufProjectorName('here'),
      ggufModelName('other'),
      ggufProjectorName('other'),
    ]);
  });

  it('deletes only files the list never names', () => {
    const names = ['here.gguf', 'other.gguf', 'orphan.gguf', 'partial.gguf.part'];
    const index = JSON.stringify([saved, { fileId: 'other', name: 'Other' }]);

    const orphans = orphanedModelFiles({
      names,
      index,
      kept: readModelIndex(index),
      partialNames: ['partial.gguf.part'],
    });

    expect(orphans).toEqual(['orphan.gguf']);
  });

  it('keeps a vision model and its projector, and deletes a projector no entry names', () => {
    const vision = { ...saved, fileId: 'eyes', vision: true };
    const names = [
      'eyes.gguf',
      'eyes.mmproj.gguf',
      'orphan.mmproj.gguf',
      'next.gguf.part',
      'next.mmproj.gguf.part',
    ];
    const index = JSON.stringify([vision]);

    const orphans = orphanedModelFiles({
      names,
      index,
      kept: readModelIndex(index),
      partialNames: ['next.gguf.part', 'next.mmproj.gguf.part'],
    });

    expect(orphans).toEqual(['orphan.mmproj.gguf']);
  });

  it('reports a list as fully parsed only when every entry parsed', () => {
    expect(modelIndexFullyParsed(JSON.stringify([saved]))).toBe(true);
    expect(modelIndexFullyParsed('{ not json')).toBe(false);
    expect(modelIndexFullyParsed('{"fileId":"one"}')).toBe(false);
    expect(modelIndexFullyParsed(JSON.stringify([saved, { fileId: 'other' }]))).toBe(false);
  });

  it('deletes nothing when the list cannot be read', () => {
    // A shape change or a truncated write must not destroy every download.
    expect(
      orphanedModelFiles({
        names: ['here.gguf'],
        index: '{ not json',
        kept: [],
        partialNames: [],
      })
    ).toEqual([]);
  });
});
