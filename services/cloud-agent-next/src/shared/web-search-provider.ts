import { z } from 'zod';

export const webSearchProviderSchema = z.enum([
  'exa',
  'firecrawl',
  'parallel',
  'tavily',
  'tinyfish',
]);
export const webSearchProviders = {
  exa: 'Exa',
  firecrawl: 'Firecrawl',
  parallel: 'Parallel',
  tavily: 'Tavily',
  tinyfish: 'TinyFish',
} satisfies Record<z.infer<typeof webSearchProviderSchema>, string>;
export const webSearchPreferenceSchema = z.union([
  z.literal('default'),
  webSearchProviderSchema,
  z.literal('off'),
]);
export type WebSearchPreference = z.infer<typeof webSearchPreferenceSchema>;
