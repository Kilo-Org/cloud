import { allFixtures } from './__fixtures__';

// Fixtures mirror real wire shapes, so every identifier they carry is invented.
// Sample identifiers keep the production prefix and use a numeric body. The
// check reads the parsed fixture data rather than the source text, so it also
// covers values that the fixture helpers compose at import time.
const IDENTIFIER_PREFIX = /^(?:agent|exc|exec|msg|prt|sandbox|sbx|ses|workspace)_/;
const SAMPLE_IDENTIFIER = /^(?:agent|exc|exec|msg|prt|sandbox|sbx|ses|workspace)_[0-9-]+$/;

type FixtureString = { path: string; value: string };

function collectStrings(value: unknown, path: string, out: FixtureString[]): FixtureString[] {
  if (typeof value === 'string') {
    out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) collectStrings(item, `${path}.${key}`, out);
  }
  return out;
}

function fixtureStrings(events: unknown, expected: unknown): FixtureString[] {
  return collectStrings({ events, expected }, '', []);
}

describe.each(allFixtures)('fixture data: $name', ({ events, expected }) => {
  it('uses sample identifiers', () => {
    const others = fixtureStrings(events, expected).filter(
      ({ value }) => IDENTIFIER_PREFIX.test(value) && !SAMPLE_IDENTIFIER.test(value)
    );

    expect(others).toEqual([]);
  });
});
