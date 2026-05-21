import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { model_experiment } from '@kilocode/db/schema';
import { listAvailableExperimentModels } from './list-available-experiment-models';
import { inArray } from 'drizzle-orm';

const testPublicIds = [
  'kilo/preview-active-a',
  'kilo/preview-active-b',
  'kilo/preview-paused',
  'kilo/preview-draft',
];

describe('listAvailableExperimentModels', () => {
  afterEach(async () => {
    await db
      .delete(model_experiment)
      .where(inArray(model_experiment.public_model_id, testPublicIds));
  });

  it('returns only active experiment public ids as selectable models', async () => {
    await db
      .delete(model_experiment)
      .where(inArray(model_experiment.public_model_id, testPublicIds));
    await db.insert(model_experiment).values([
      {
        public_model_id: 'kilo/preview-active-a',
        name: 'Preview Active A',
        description: 'First active preview',
        status: 'active',
      },
      {
        public_model_id: 'kilo/preview-active-b',
        name: 'Preview Active B',
        description: null,
        status: 'active',
      },
      {
        public_model_id: 'kilo/preview-paused',
        name: 'Preview Paused',
        description: 'Paused preview',
        status: 'paused',
      },
      {
        public_model_id: 'kilo/preview-draft',
        name: 'Preview Draft',
        description: 'Draft preview',
        status: 'draft',
      },
    ]);

    const models = await listAvailableExperimentModels();

    expect(models.map(model => model.id)).toEqual([
      'kilo/preview-active-a',
      'kilo/preview-active-b',
    ]);
    expect(models[0]).toEqual(
      expect.objectContaining({
        id: 'kilo/preview-active-a',
        name: 'Preview Active A',
        description: 'First active preview',
        context_length: 200000,
      })
    );
    expect(models[1].description).toBe('Preview Active B');
  });
});
