import type { TimeseriesDataPoint } from '@/components/organizations/usage-details/types';
import { mockDataRng as rng, randomChoice, randomInt, randomBoolean } from './random';
import { PROJECT_WORDS, MODELS, PROVIDERS } from './constants';

function generateEmail(): string {
  const isLongEmail = rng() < 0.1;

  if (isLongEmail) {
    return 'very-long-email-address-that-should-trigger-ellipsis-behavior@example-company-with-long-domain-name.com';
  }

  return `user${randomInt(rng, 0, 99)}@example.com`;
}

function generateProjectId(): string | null {
  const hasProject = randomBoolean(rng, 0.7);
  if (!hasProject) return null;

  const word1 = randomChoice(rng, PROJECT_WORDS);
  const word2 = randomChoice(rng, PROJECT_WORDS);
  return `${word1}-${word2}`;
}

function generateDataPoint(baseDate: Date, hourOffset: number): TimeseriesDataPoint {
  const datetime = new Date(baseDate.getTime() + hourOffset * 3600000);

  return {
    datetime: datetime.toISOString(),
    name: `User ${randomInt(rng, 0, 99)}`,
    email: generateEmail(),
    model: randomChoice(rng, MODELS),
    provider: randomChoice(rng, PROVIDERS),
    projectId: generateProjectId(),
    costMicrodollars: randomInt(rng, 100000, 9999999),
    inputTokenCount: randomInt(rng, 100, 49999),
    outputTokenCount: randomInt(rng, 50, 24999),
    requestCount: randomInt(rng, 1, 999),
  };
}

export function generateTimeseriesData(
  count: number = 50,
  startDate?: Date
): TimeseriesDataPoint[] {
  const baseDate = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const points: TimeseriesDataPoint[] = [];
  let currentOffset = 0;

  for (let i = 0; i < count; i++) {
    points.push(generateDataPoint(baseDate, currentOffset));
    currentOffset += rng() * 2.5 + 0.5;
  }

  return points;
}

export const mockTimeseriesData = generateTimeseriesData(50);
