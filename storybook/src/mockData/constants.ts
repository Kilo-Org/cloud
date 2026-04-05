// Constant data used in our stories.

export const PROJECT_WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
  'quebec',
  'romeo',
  'sierra',
  'tango',
] as const;

export const MODELS = [
  'gpt-4',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'gemini-pro',
  'llama-3',
] as const;

export const PROVIDERS = ['openai', 'anthropic', 'google', 'meta'] as const;

// Generic English word lists used for mock data.
export const PROVIDER_DESCRIPTION_ADJECTIVES = [
  'powerful',
  'efficient',
  'advanced',
  'cutting-edge',
] as const;

export const PROVIDER_HEADQUARTERS = ['US', 'UK', 'FR', 'CA', 'DE'] as const;

export const ORG_ROLES = ['owner', 'member'] as const;

export const ORG_STATUSES = ['active', 'invited'] as const;

export const COMPANY_TYPES = ['Corp', 'Inc', 'LLC', 'Ltd', 'Co'] as const;
