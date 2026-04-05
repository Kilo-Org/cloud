import seedrandom from 'seedrandom';

export function createRng(seed: string): () => number {
  return seedrandom(seed) as () => number;
}

// Global RNG for all Storybook mock data. Stories should import and use this
// instead of creating their own RNG instances.
export const mockDataRng = createRng('mock-data-seed-12345');

export function randomChoice<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function randomFloat(rng: () => number, min: number, max: number): number {
  return rng() * (max - min) + min;
}

export function randomBoolean(rng: () => number, probability: number = 0.5): boolean {
  return rng() < probability;
}

export function randomId(rng: () => number, prefix: string = '', length: number = 9): string {
  const id = Math.floor(rng() * 36 ** length)
    .toString(36)
    .padStart(length, '0');
  return prefix ? `${prefix}-${id}` : id;
}
