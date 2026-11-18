export type Random = (max: number) => number;

export function seededRandom(seed: number): Random {
  let state = seed >>> 0 || 0x9e3779b9;
  return max => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % max;
  };
}

export type LongContextScenario = {
  sections: readonly string[];
  question: string;
  answer: Record<string, string | number>;
};

export type LongContextGenerator = {
  scenario: (seed: number) => LongContextScenario;
  filler: (index: number, random: Random) => string;
};
