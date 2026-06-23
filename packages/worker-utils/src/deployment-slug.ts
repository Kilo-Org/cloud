import * as z from 'zod';

const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const INTERNAL_WORKER_NAME_REGEX = /^dpl-/;
const PRIVATE_QUICK_DEPLOYMENT_WORKER_NAME_REGEX = /^qdpl-/;

/** Reserved slugs that cannot be used for deployments. */
export const RESERVED_SLUGS = [
  'www',
  'api',
  'app',
  'admin',
  'dashboard',
  'login',
  'auth',
  'static',
  'assets',
  'cdn',
  'mail',
  'email',
  'ftp',
  'ssh',
  'test',
  'staging',
  'dev',
  'prod',
  'production',
  'kilo',
  'kilocode',
  'kiloapps',
  'custom',
  'status',
  'health',
  'metrics',
] as const;

/** Schema for deployment slugs used as custom subdomains. */
export const slugSchema = z
  .string()
  .min(3, 'Subdomain must be at least 3 characters')
  .max(63, 'Subdomain must be at most 63 characters')
  .regex(
    SLUG_REGEX,
    'Subdomain must start and end with a letter or number, and contain only lowercase letters, numbers, and hyphens'
  )
  .refine(slug => !slug.includes('--'), {
    message: 'Subdomain cannot contain consecutive hyphens',
  })
  .refine(slug => !RESERVED_SLUGS.some(reservedSlug => reservedSlug === slug), {
    message: 'This subdomain is reserved',
  })
  .refine(slug => !INTERNAL_WORKER_NAME_REGEX.test(slug), {
    message: 'Subdomain cannot start with "dpl-"',
  })
  .refine(slug => !PRIVATE_QUICK_DEPLOYMENT_WORKER_NAME_REGEX.test(slug), {
    message: 'Subdomain cannot start with "qdpl-"',
  });

/** Return a user-facing validation error, or undefined for a valid slug. */
export function validateSlug(slug: string): string | undefined {
  const result = slugSchema.safeParse(slug);
  if (result.success) return undefined;
  return result.error.issues[0]?.message;
}

// Mixed-theme word lists: nature/poetic, neutral, and tech
// All words kept short (<=10 chars) to stay well within the 63-char slug limit.
const adjectives = [
  // nature / poetic
  'autumn',
  'bitter',
  'bold',
  'calm',
  'cold',
  'cool',
  'crimson',
  'damp',
  'dark',
  'dawn',
  'dry',
  'dusty',
  'empty',
  'fading',
  'falling',
  'floral',
  'frosty',
  'gentle',
  'golden',
  'green',
  'hidden',
  'hollow',
  'icy',
  'lush',
  'misty',
  'morning',
  'muddy',
  'mute',
  'pale',
  'plain',
  'proud',
  'quiet',
  'rapid',
  'rough',
  'round',
  'royal',
  'rustic',
  'shy',
  'silent',
  'snowy',
  'soft',
  'solitary',
  'spring',
  'steep',
  'still',
  'summer',
  'sweet',
  'tiny',
  'twilight',
  'wandering',
  'warm',
  'white',
  'wild',
  'winter',
  'young',
  // neutral / general
  'bright',
  'broad',
  'clean',
  'clear',
  'cosmic',
  'deep',
  'early',
  'even',
  'firm',
  'flat',
  'free',
  'fresh',
  'grand',
  'great',
  'keen',
  'late',
  'lean',
  'light',
  'long',
  'lucky',
  'neat',
  'next',
  'noble',
  'odd',
  'open',
  'prime',
  'rare',
  'real',
  'rich',
  'sharp',
  'shiny',
  'short',
  'slim',
  'smart',
  'smooth',
  'solid',
  'stark',
  'steady',
  'true',
  'vast',
  // tech / computing
  'active',
  'agile',
  'async',
  'atomic',
  'binary',
  'cubic',
  'cyber',
  'dual',
  'dynamic',
  'fast',
  'hyper',
  'linear',
  'live',
  'lunar',
  'mega',
  'micro',
  'neural',
  'nimble',
  'polar',
  'swift',
  'sonic',
  'super',
  'synced',
  'turbo',
  'ultra',
  'wired',
] as const;

const nouns = [
  // nature / poetic
  'birch',
  'bloom',
  'breeze',
  'brook',
  'cedar',
  'cliff',
  'cloud',
  'cove',
  'creek',
  'dale',
  'dawn',
  'dew',
  'dune',
  'elm',
  'ember',
  'fern',
  'field',
  'flame',
  'flint',
  'fog',
  'frost',
  'glade',
  'grove',
  'haze',
  'hill',
  'lake',
  'leaf',
  'marsh',
  'meadow',
  'mist',
  'moon',
  'moss',
  'oak',
  'peak',
  'pine',
  'pond',
  'rain',
  'reed',
  'ridge',
  'river',
  'shade',
  'shore',
  'sky',
  'snow',
  'star',
  'stone',
  'storm',
  'sun',
  'tide',
  'vale',
  'wave',
  'wind',
  'wood',
  // neutral / general
  'arch',
  'band',
  'base',
  'bell',
  'bolt',
  'bond',
  'bridge',
  'cap',
  'core',
  'crest',
  'crown',
  'drum',
  'edge',
  'forge',
  'gate',
  'guild',
  'harbor',
  'hatch',
  'haven',
  'helm',
  'hub',
  'key',
  'lance',
  'lens',
  'link',
  'loom',
  'mark',
  'mill',
  'mint',
  'nest',
  'orbit',
  'path',
  'port',
  'prism',
  'quest',
  'relay',
  'rune',
  'sail',
  'scope',
  'seal',
  'shell',
  'shard',
  'signal',
  'spark',
  'spire',
  'summit',
  'tower',
  'trail',
  'vault',
  'wing',
  // tech / computing
  'bit',
  'block',
  'buffer',
  'byte',
  'cache',
  'cell',
  'chip',
  'clock',
  'codec',
  'coil',
  'cycle',
  'data',
  'delta',
  'disk',
  'fiber',
  'flux',
  'frame',
  'grid',
  'hash',
  'index',
  'ion',
  'kernel',
  'latch',
  'matrix',
  'node',
  'null',
  'oxide',
  'packet',
  'pixel',
  'probe',
  'pulse',
  'queue',
  'rack',
  'ray',
  'rotor',
  'sector',
  'servo',
  'stack',
  'sync',
  'tensor',
  'token',
  'vector',
  'voxel',
  'wire',
] as const;

const MAX_SLUG_LENGTH = 63;
// "-" separator + 4-digit number
const SUFFIX_LENGTH = 1 + 4;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const EPHEMERAL_SUFFIX_LENGTH = 8;

function cryptoRandomInt(max: number): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  // Uint32Array(1) always has index 0 after getRandomValues
  const value = array[0] ?? 0;
  return value % max;
}

function pickRandom<T>(list: readonly T[]): T {
  const index = cryptoRandomInt(list.length);
  const value = list[index];
  if (value === undefined) {
    throw new Error(`pickRandom: index ${index} out of bounds for list of length ${list.length}`);
  }
  return value;
}

function generate4DigitNumber(): string {
  return String(cryptoRandomInt(10000)).padStart(4, '0');
}

function generateEphemeralSuffix(): string {
  const values = new Uint8Array(EPHEMERAL_SUFFIX_LENGTH);
  crypto.getRandomValues(values);
  return Array.from(values, value => BASE32_ALPHABET.charAt(value & 31)).join('');
}

function generatePronounceableDeploymentSlug(suffix: string): string {
  return `${pickRandom(adjectives)}-${pickRandom(nouns)}-${suffix}`;
}

function sanitizePrefix(raw: string): string {
  let prefix = raw
    .toLowerCase()
    // Replace anything that isn't a-z, 0-9, or hyphen
    .replace(/[^a-z0-9-]/g, '-')
    // Collapse consecutive hyphens
    .replace(/-{2,}/g, '-');

  if (prefix.startsWith('-')) prefix = prefix.slice(1);
  if (prefix.endsWith('-')) prefix = prefix.slice(0, -1);

  const maxPrefixLength = MAX_SLUG_LENGTH - SUFFIX_LENGTH;
  prefix = prefix.slice(0, maxPrefixLength);
  // Truncation may leave a trailing hyphen
  if (prefix.endsWith('-')) prefix = prefix.slice(0, -1);

  return prefix;
}

/** Generate a pronounceable slug with a high-entropy suffix for public ephemeral deployments. */
export function generateEphemeralDeploymentSlug(): string {
  return generatePronounceableDeploymentSlug(generateEphemeralSuffix());
}

/**
 * Generate a pronounceable deployment slug.
 *
 * - App-builder deployments (repoName is null): `adjective-noun-NNNN`
 * - Regular deployments: `repoName-NNNN` (repoName truncated to fit 63-char limit)
 */
export function generateDeploymentSlug(repoName: string | null): string {
  const number = generate4DigitNumber();

  let slug: string;
  if (repoName === null) {
    slug = generatePronounceableDeploymentSlug(number);
  } else {
    const prefix = sanitizePrefix(repoName);
    slug = prefix ? `${prefix}-${number}` : generatePronounceableDeploymentSlug(number);
  }

  // Safety: if the generated slug doesn't pass validation (shouldn't happen
  // with curated word lists, but just in case), fall back to a simple pattern.
  const result = slugSchema.safeParse(slug);
  if (!result.success) {
    slug = generatePronounceableDeploymentSlug(number);
  }

  return slug;
}
