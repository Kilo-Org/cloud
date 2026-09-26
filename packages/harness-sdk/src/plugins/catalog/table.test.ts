import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { ModelCatalog } from '../../core/catalog.js';
import { layerTableCatalog } from './table.js';

const facts = (
  table: Parameters<typeof layerTableCatalog>[0],
  fallback: Parameters<typeof layerTableCatalog>[1],
  model: string
) =>
  Effect.runSync(
    Effect.either(
      Effect.flatMap(ModelCatalog, catalog => catalog.facts(model)).pipe(
        Effect.provide(layerTableCatalog(table, fallback))
      )
    )
  );

it('answers from the table for a model it names', () => {
  const known = { apiKinds: ['messages'] } as const;
  expect(facts({ 'a/b': known }, undefined, 'a/b')).toMatchObject({ _tag: 'Right', right: known });
});

it('answers from the fallback for a model it does not name', () => {
  const other = { apiKinds: ['responses'] } as const;
  expect(facts({}, other, 'a/b')).toMatchObject({ _tag: 'Right', right: other });
});

it('refuses a model it does not name when there is no fallback', () => {
  /* A table meant to be complete must say so rather than guess a shape. The
     gateway turns this into a failed call, not a call to the wrong endpoint. */
  expect(facts({}, undefined, 'a/b')).toMatchObject({
    _tag: 'Left',
    left: { _tag: 'harness/CatalogError', model: 'a/b' },
  });
});
