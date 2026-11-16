import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { legacyOpenRouterAliases } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-openrouter-model-ids';
import type { inferenceModelCatalogAdmission } from '@kilocode/web-shared/lib/ai-gateway/inference-model-catalog';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
  getRawOpenRouterModels: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  readDb: { select: jest.fn() },
  db: { select: jest.fn() },
}));

type CatalogBuilder = (options: {
  countryCode: string | null;
  fromDb: unknown;
}) => Promise<unknown>;
type Admission = typeof inferenceModelCatalogAdmission;

const START_MS = 1_000_000;
const TTL_MS = 60_000;
const FAILURE_BACKOFF_MS = 30_000;
const listedModel = 'vendor/listed-model';
const omittedModel = 'vendor/raw-only-model';
let admission: Admission;
let builder: jest.Mock<CatalogBuilder>;
let rawBuilder: jest.Mock<() => Promise<unknown>>;
let clock: jest.SpiedFunction<typeof Date.now>;

beforeEach(async () => {
  jest.resetModules();
  clock = jest.spyOn(Date, 'now').mockReturnValue(START_MS);
  const mocks = jest.requireMock<{
    getEnhancedOpenRouterModels: jest.Mock<CatalogBuilder>;
    getRawOpenRouterModels: jest.Mock<() => Promise<unknown>>;
  }>('@kilocode/web-shared/lib/ai-gateway/providers/openrouter');
  builder = mocks.getEnhancedOpenRouterModels;
  rawBuilder = mocks.getRawOpenRouterModels;
  builder.mockResolvedValue({ data: [{ id: listedModel }] });
  rawBuilder.mockResolvedValue({ data: [{ id: listedModel }, { id: omittedModel }] });
  ({ inferenceModelCatalogAdmission: admission } =
    await import('@kilocode/web-shared/lib/ai-gateway/inference-model-catalog'));
});

afterEach(() => {
  const { db } = jest.requireMock<{ db: { select: jest.Mock } }>(
    '@kilocode/web-shared/lib/drizzle'
  );
  expect(db.select).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe('inferenceModelCatalogAdmission', () => {
  it('admits only enhanced catalog IDs, regardless of raw upstream metadata', async () => {
    const { readDb } = jest.requireMock<{ readDb: unknown }>('@kilocode/web-shared/lib/drizzle');

    expect(await admission(listedModel)).toBe('allowed');
    expect(await admission(omittedModel)).toBe('unlisted');
    expect(builder).toHaveBeenCalledTimes(1);
    expect(rawBuilder).toHaveBeenCalledTimes(1);
    expect(builder).toHaveBeenCalledWith({ countryCode: null, fromDb: readDb });
  });

  it('normalizes catalog IDs to match lowercased inference requests', async () => {
    builder.mockResolvedValue({ data: [{ id: 'Vendor/Listed-Model' }] });

    expect(await admission(listedModel)).toBe('allowed');
  });

  it('admits every explicit legacy alias without needing a working catalog', async () => {
    builder.mockRejectedValue(new Error('Catalog unavailable'));

    for (const alias of legacyOpenRouterAliases) {
      expect(await admission(alias)).toBe('allowed');
    }
    expect(builder).not.toHaveBeenCalled();
    expect(rawBuilder).not.toHaveBeenCalled();
    expect(await admission(omittedModel)).toBe('unavailable');
  });

  it('does not mistake Auto padding for a healthy cold upstream snapshot', async () => {
    rawBuilder.mockResolvedValue({ data: [] });
    builder.mockResolvedValue({ data: [{ id: 'kilo-auto/small' }] });

    expect(await admission(listedModel)).toBe('unavailable');
    expect(await admission('kilo-auto/small')).toBe('unavailable');
    expect(builder).not.toHaveBeenCalled();
    expect(rawBuilder).toHaveBeenCalledTimes(1);
  });

  it('retains last-good admission when an empty raw refresh would leave only Auto padding', async () => {
    expect(await admission(listedModel)).toBe('allowed');
    rawBuilder.mockResolvedValue({ data: [] });
    builder.mockResolvedValue({ data: [{ id: 'kilo-auto/small' }] });
    clock.mockReturnValue(START_MS + TTL_MS);

    expect(await admission(listedModel)).toBe('allowed');
    expect(await admission(omittedModel)).toBe('unlisted');
    expect(builder).toHaveBeenCalledTimes(1);
    expect(rawBuilder).toHaveBeenCalledTimes(2);
  });

  it.each(['gpt-4o-mini-extra', 'gpt-4o-mini:free', 'vendor/gpt-4o-mini', 'vercel/gpt-4o-mini'])(
    'does not broaden legacy aliases to %s',
    async model => {
      expect(await admission(model)).toBe('unlisted');
    }
  );

  it.each([
    ['null catalog', null],
    ['missing data', {}],
    ['null data', { data: null }],
    ['invalid data', { data: 'not-an-array' }],
    ['empty data', { data: [] }],
    ['invalid entry', { data: [{ id: listedModel }, null] }],
    ['missing ID', { data: [{ id: listedModel }, {}] }],
    ['invalid ID', { data: [{ id: listedModel }, { id: 123 }] }],
    ['empty ID', { data: [{ id: listedModel }, { id: '' }] }],
  ])(
    'reports a cold %s as unavailable rather than publishing a partial catalog',
    async (_label, value) => {
      builder.mockResolvedValue(value);

      expect(await admission(listedModel)).toBe('unavailable');
      expect(await admission(omittedModel)).toBe('unavailable');
      expect(builder).toHaveBeenCalledTimes(1);
    }
  );

  it('backs off a cold failure and recovers without caching unavailable as success', async () => {
    builder.mockRejectedValueOnce(new Error('Catalog unavailable'));

    expect(await admission(listedModel)).toBe('unavailable');
    clock.mockReturnValue(START_MS + FAILURE_BACKOFF_MS - 1);
    expect(await admission(listedModel)).toBe('unavailable');
    expect(builder).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(START_MS + FAILURE_BACKOFF_MS);
    expect(await admission(listedModel)).toBe('allowed');
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it.each(['failure', 'invalid', 'empty'])(
    'retains last-good membership during a warm refresh %s and its backoff',
    async kind => {
      expect(await admission(listedModel)).toBe('allowed');
      if (kind === 'failure') builder.mockRejectedValueOnce(new Error('Catalog unavailable'));
      else builder.mockResolvedValueOnce(kind === 'empty' ? { data: [] } : { data: null });

      clock.mockReturnValue(START_MS + TTL_MS);
      expect(await admission(listedModel)).toBe('allowed');
      expect(await admission(omittedModel)).toBe('unlisted');
      clock.mockReturnValue(START_MS + TTL_MS + FAILURE_BACKOFF_MS - 1);
      expect(await admission(listedModel)).toBe('allowed');
      expect(builder).toHaveBeenCalledTimes(2);

      builder.mockResolvedValue({ data: [{ id: omittedModel }] });
      clock.mockReturnValue(START_MS + TTL_MS + FAILURE_BACKOFF_MS);
      expect(await admission(listedModel)).toBe('unlisted');
      expect(await admission(omittedModel)).toBe('allowed');
      expect(builder).toHaveBeenCalledTimes(3);
    }
  );

  it('refreshes additions and removals at the TTL boundary', async () => {
    expect(await admission(listedModel)).toBe('allowed');
    builder.mockResolvedValue({ data: [{ id: omittedModel }] });

    clock.mockReturnValue(START_MS + TTL_MS - 1);
    expect(await admission(listedModel)).toBe('allowed');
    expect(await admission(omittedModel)).toBe('unlisted');
    expect(builder).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(START_MS + TTL_MS);
    expect(await admission(listedModel)).toBe('unlisted');
    expect(await admission(omittedModel)).toBe('allowed');
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it.each(['cold', 'expired'])('deduplicates concurrent %s catalog reads', async state => {
    if (state === 'expired') {
      expect(await admission(listedModel)).toBe('allowed');
      clock.mockReturnValue(START_MS + TTL_MS);
    }
    const pending = Promise.withResolvers<unknown>();
    builder.mockImplementationOnce(() => pending.promise);

    const results = [admission(listedModel), admission(omittedModel), admission(listedModel)];
    expect(rawBuilder).toHaveBeenCalledTimes(state === 'expired' ? 2 : 1);
    pending.resolve({ data: [{ id: listedModel }] });

    expect(await Promise.all(results)).toEqual(['allowed', 'unlisted', 'allowed']);
    expect(builder).toHaveBeenCalledTimes(state === 'expired' ? 2 : 1);
  });
});
