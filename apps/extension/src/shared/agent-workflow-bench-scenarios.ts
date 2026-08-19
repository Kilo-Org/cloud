/* eslint-disable max-lines -- One flat registry of twenty pinned scenario specs; splitting it would only scatter the pins. */
/**
 * Golden-star scenario registry for the workflow-create benchmark.
 *
 * Each scenario is one realistic "automate what I do in the browser" request
 * on a public, login-free site, with pinned correctness expectations:
 * which params the agent must declare, what the stored script must mention,
 * and what a verifying run's result must contain.
 *
 * The scenarios cover the common task shapes: JS-heavy SPA searches,
 * query-parameter searches, path-encoded lookups, filtered lists, classic
 * GET-form sites, price and status lookups, and a zero-param workflow.
 * Scoring reads only these specs — nothing in the product is allowed to
 * special-case a benchmark site by name.
 */

export interface BenchRegexCheck {
  readonly key: string;
  readonly re: RegExp;
}

export interface BenchScenario {
  readonly createMessage: string;
  /** Each entry must match at least one declared param's name + description. */
  readonly expectedParams: readonly BenchRegexCheck[];
  /** May contain {key} placeholders for followUpValues keys, including {date}. */
  readonly followUpMessage: string;
  /** Values the verifying run must receive; the literal "{date}" is replaced by the pinned date. */
  readonly followUpValues: Readonly<Record<string, string>>;
  readonly id: string;
  /** Minimum character count of the verifying run's result strings, joined. */
  readonly minResultChars: number;
  /** Content patterns the verifying run's result must match (e.g. a price). */
  readonly resultContentChecks: readonly BenchRegexCheck[];
  /** Keys of followUpValues that must appear in the verifying run's result. */
  readonly resultMustContainValues: readonly string[];
  readonly scopeOrigin: string;
  /** Patterns the stored script must contain. */
  readonly scriptMarkers: readonly BenchRegexCheck[];
  readonly startUrl: string;
  /** Matches the target-tab option label for this scenario's tab. */
  readonly tabLabelRe: RegExp;
  /** True when the scenario pins a follow-up date via --date. */
  readonly usesDate: boolean;
}

const FLIGHTS_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to find business class flights from Belgrade',
  expectedParams: [
    { key: 'destination', re: /destination|city|to\b|arrival|where/iu },
    { key: 'date', re: /date|day|when|time|departure/iu },
  ],
  followUpMessage: 'Run it for {destination} on {date}',
  followUpValues: { date: '{date}', destination: 'Paris' },
  id: 'flights',
  minResultChars: 100,
  resultContentChecks: [
    { key: 'price', re: /(?:€|\$|USD|EUR|RSD)\s?\d|\d\s?(?:€|USD|EUR|RSD)/iu },
    {
      key: 'carrier',
      re: /(?:airlines|airways|air serbia|air france|lufthansa|wizz|ryanair|easyjet|turkish|swiss|austrian|klm|tarom|pegasus|flydubai)\b|\b[a-z]{2}\d{3,4}\b/iu,
    },
  ],
  resultMustContainValues: ['destination'],
  scopeOrigin: 'https://www.google.com',
  scriptMarkers: [{ key: 'business', re: /business/iu }],
  startUrl: 'https://www.google.com/travel/flights',
  tabLabelRe: /flights/iu,
  usesDate: true,
};

const HN_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to find recent Hacker News stories about a topic',
  expectedParams: [{ key: 'topic', re: /topic|query|search|term|keyword|subject/iu }],
  followUpMessage: 'Run it for {topic}',
  followUpValues: { topic: 'rust' },
  id: 'hn',
  minResultChars: 100,
  resultContentChecks: [{ key: 'points', re: /\d+\s*points?/iu }],
  resultMustContainValues: ['topic'],
  scopeOrigin: 'https://hn.algolia.com',
  scriptMarkers: [],
  startUrl: 'https://hn.algolia.com/',
  tabLabelRe: /hn|algolia|hacker/iu,
  usesDate: false,
};

const WIKIPEDIA_SCENARIO: BenchScenario = {
  createMessage:
    'Create a workflow that gives me the summary of a Wikipedia article about a topic I choose',
  expectedParams: [{ key: 'topic', re: /topic|article|title|subject|term|search|query/iu }],
  followUpMessage: 'Run it for {topic}',
  followUpValues: { topic: 'Nikola Tesla' },
  id: 'wikipedia',
  // A genuine REST summary can be short (Tesla's is ~200 chars).
  minResultChars: 100,
  resultContentChecks: [],
  resultMustContainValues: ['topic'],
  scopeOrigin: 'https://en.wikipedia.org',
  scriptMarkers: [],
  startUrl: 'https://en.wikipedia.org/wiki/Main_Page',
  tabLabelRe: /wikipedia/iu,
  usesDate: false,
};

const GITHUB_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to list open issues with a given label in a GitHub repository',
  expectedParams: [
    { key: 'repo', re: /repo/iu },
    { key: 'label', re: /label|tag/iu },
  ],
  followUpMessage: 'Run it for {repo} with label {label}',
  followUpValues: { label: 'bug', repo: 'microsoft/vscode' },
  id: 'github',
  minResultChars: 100,
  resultContentChecks: [{ key: 'issues', re: /#\d{3,}|\bissues?\b/iu }],
  resultMustContainValues: ['label'],
  scopeOrigin: 'https://github.com',
  scriptMarkers: [],
  startUrl: 'https://github.com/microsoft/vscode/issues',
  tabLabelRe: /issues|vscode/iu,
  usesDate: false,
};

const WEATHER_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to get the weather forecast for a city',
  expectedParams: [{ key: 'city', re: /city|location|place|where|zip/iu }],
  followUpMessage: 'Run it for {city}',
  followUpValues: { city: 'San Francisco' },
  id: 'weather',
  minResultChars: 100,
  resultContentChecks: [{ key: 'forecast', re: /°|\bhigh\b|\blow\b|forecast|sunny|cloudy|rain/iu }],
  resultMustContainValues: ['city'],
  scopeOrigin: 'https://forecast.weather.gov',
  scriptMarkers: [],
  // A real forecast page: the root of forecast.weather.gov redirects off-origin, and this page carries the same city-search GET form on the scenario origin.
  startUrl: 'https://forecast.weather.gov/MapClick.php?lat=37.7749&lon=-122.4194',
  tabLabelRe: /weather|forecast/iu,
  usesDate: false,
};

const YOUTUBE_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to find YouTube videos about a topic',
  expectedParams: [{ key: 'topic', re: /topic|query|search|term|keyword|subject/iu }],
  followUpMessage: 'Run it for {topic}',
  followUpValues: { topic: 'woodworking' },
  id: 'youtube',
  minResultChars: 100,
  // View counts, durations, or age markers — whichever the locale renders into text.
  resultContentChecks: [
    { key: 'videos', re: /\bviews?\b|aufrufe|\d+:\d\d|\bago\b|subscribers?/iu },
  ],
  resultMustContainValues: ['topic'],
  scopeOrigin: 'https://www.youtube.com',
  scriptMarkers: [],
  startUrl: 'https://www.youtube.com/',
  tabLabelRe: /youtube/iu,
  usesDate: false,
};

const NPM_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to search npm for packages',
  expectedParams: [{ key: 'query', re: /package|query|search|term|keyword|name/iu }],
  followUpMessage: 'Run it for {query}',
  followUpValues: { query: 'markdown parser' },
  id: 'npm',
  minResultChars: 100,
  resultContentChecks: [{ key: 'registry', re: /downloads|published|version|\d+\.\d+\.\d+/iu }],
  resultMustContainValues: ['query'],
  scopeOrigin: 'https://www.npmjs.com',
  scriptMarkers: [],
  startUrl: 'https://www.npmjs.com/',
  tabLabelRe: /npm/iu,
  usesDate: false,
};

// MDN was probed and rejected: its search results never render in an automated browser, so no workflow can succeed there.
const TMDB_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to look up a movie on TMDB',
  expectedParams: [{ key: 'movie', re: /movie|film|title|query|search/iu }],
  followUpMessage: 'Run it for {movie}',
  followUpValues: { movie: 'Inception' },
  id: 'tmdb',
  minResultChars: 100,
  // A release year renders in every locale.
  resultContentChecks: [{ key: 'year', re: /\b(?:19|20)\d\d\b/u }],
  resultMustContainValues: ['movie'],
  scopeOrigin: 'https://www.themoviedb.org',
  scriptMarkers: [],
  startUrl: 'https://www.themoviedb.org/',
  tabLabelRe: /movie|tmdb/iu,
  usesDate: false,
};

const STACKOVERFLOW_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to list recent Stack Overflow questions for a tag',
  expectedParams: [{ key: 'tag', re: /tag|topic|technology|language/iu }],
  followUpMessage: 'Run it for the {tag} tag',
  followUpValues: { tag: 'kubernetes' },
  id: 'stackoverflow',
  minResultChars: 100,
  resultContentChecks: [{ key: 'questions', re: /votes?|answers?|asked|views/iu }],
  resultMustContainValues: ['tag'],
  scopeOrigin: 'https://stackoverflow.com',
  scriptMarkers: [],
  startUrl: 'https://stackoverflow.com/questions',
  tabLabelRe: /stack overflow|stackoverflow|newest questions/iu,
  usesDate: false,
};

const ARXIV_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to find recent arXiv papers about a topic',
  expectedParams: [{ key: 'topic', re: /topic|query|search|term|keyword|subject/iu }],
  followUpMessage: 'Run it for {topic}',
  followUpValues: { topic: 'diffusion models' },
  id: 'arxiv',
  minResultChars: 100,
  resultContentChecks: [{ key: 'papers', re: /arxiv:\s?\d{4}|\bpdf\b|submitted/iu }],
  resultMustContainValues: ['topic'],
  scopeOrigin: 'https://arxiv.org',
  scriptMarkers: [],
  startUrl: 'https://arxiv.org/',
  tabLabelRe: /arxiv/iu,
  usesDate: false,
};

const OPENLIBRARY_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to search Open Library for books',
  expectedParams: [{ key: 'book', re: /book|title|author|query|search|term/iu }],
  followUpMessage: 'Run it for {book}',
  followUpValues: { book: 'neuromancer' },
  id: 'openlibrary',
  minResultChars: 100,
  resultContentChecks: [{ key: 'editions', re: /first published|editions?|by\s/iu }],
  resultMustContainValues: ['book'],
  scopeOrigin: 'https://openlibrary.org',
  scriptMarkers: [],
  startUrl: 'https://openlibrary.org/',
  tabLabelRe: /open library/iu,
  usesDate: false,
};

const COINGECKO_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to check the current price of a cryptocurrency',
  expectedParams: [{ key: 'coin', re: /coin|crypto|currency|token|symbol|name/iu }],
  followUpMessage: 'Run it for {coin}',
  followUpValues: { coin: 'ethereum' },
  id: 'coingecko',
  minResultChars: 100,
  resultContentChecks: [{ key: 'price', re: /\$\s?[\d,]+(?:\.\d+)?/u }],
  resultMustContainValues: ['coin'],
  scopeOrigin: 'https://www.coingecko.com',
  scriptMarkers: [],
  startUrl: 'https://www.coingecko.com/',
  tabLabelRe: /coingecko|crypto/iu,
  usesDate: false,
};

const MERRIAM_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to look up the definition of a word',
  expectedParams: [{ key: 'word', re: /word|term|query/iu }],
  followUpMessage: 'Run it for {word}',
  followUpValues: { word: 'ephemeral' },
  id: 'merriam',
  minResultChars: 100,
  resultContentChecks: [{ key: 'definition', re: /noun|verb|adjective|adverb|definition/iu }],
  resultMustContainValues: ['word'],
  scopeOrigin: 'https://www.merriam-webster.com',
  scriptMarkers: [],
  startUrl: 'https://www.merriam-webster.com/',
  tabLabelRe: /merriam|dictionary/iu,
  usesDate: false,
};

const ALLRECIPES_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to find recipes that use an ingredient',
  expectedParams: [{ key: 'ingredient', re: /ingredient|food|query|search|term|dish/iu }],
  followUpMessage: 'Run it for {ingredient}',
  followUpValues: { ingredient: 'eggplant' },
  id: 'allrecipes',
  minResultChars: 100,
  resultContentChecks: [{ key: 'recipes', re: /recipes?|ratings?/iu }],
  resultMustContainValues: ['ingredient'],
  scopeOrigin: 'https://www.allrecipes.com',
  scriptMarkers: [],
  startUrl: 'https://www.allrecipes.com/',
  tabLabelRe: /allrecipes/iu,
  usesDate: false,
};

// The zero-param shape: the workflow takes no input at all.
const NPR_SCENARIO: BenchScenario = {
  createMessage: "Create a workflow that gets me today's top news headlines from this site",
  expectedParams: [],
  followUpMessage: 'Run it',
  followUpValues: {},
  id: 'npr',
  minResultChars: 200,
  resultContentChecks: [{ key: 'headlines', re: /npr|news/iu }],
  resultMustContainValues: [],
  scopeOrigin: 'https://text.npr.org',
  scriptMarkers: [],
  startUrl: 'https://text.npr.org/',
  tabLabelRe: /npr/iu,
  usesDate: false,
};

const GITHUB_TRENDING_SCENARIO: BenchScenario = {
  createMessage:
    'Create a workflow to show trending GitHub repositories for a programming language',
  expectedParams: [{ key: 'language', re: /language|lang/iu }],
  followUpMessage: 'Run it for {language}',
  followUpValues: { language: 'go' },
  id: 'github-trending',
  minResultChars: 100,
  resultContentChecks: [{ key: 'stars', re: /stars?/iu }],
  // The run-input binding already proves the language flows.
  // Trending repo names only contain the language token by luck, so a result check would fail honest runs.
  resultMustContainValues: [],
  scopeOrigin: 'https://github.com',
  scriptMarkers: [],
  startUrl: 'https://github.com/trending',
  tabLabelRe: /trending/iu,
  usesDate: false,
};

const CRATES_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to search crates.io for Rust crates',
  expectedParams: [{ key: 'crate', re: /crate|package|query|search|term|name/iu }],
  followUpMessage: 'Run it for {crate}',
  followUpValues: { crate: 'serde' },
  id: 'crates',
  minResultChars: 100,
  resultContentChecks: [{ key: 'downloads', re: /downloads|v?\d+\.\d+\.\d+|all-time/iu }],
  resultMustContainValues: ['crate'],
  scopeOrigin: 'https://crates.io',
  scriptMarkers: [],
  startUrl: 'https://crates.io/',
  tabLabelRe: /crates/iu,
  usesDate: false,
};

const TIMEANDDATE_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to get the current local time in a city',
  expectedParams: [{ key: 'city', re: /city|location|place|where/iu }],
  followUpMessage: 'Run it for {city}',
  followUpValues: { city: 'Tokyo' },
  id: 'timeanddate',
  minResultChars: 100,
  resultContentChecks: [{ key: 'clock', re: /\d{1,2}:\d\d/u }],
  resultMustContainValues: ['city'],
  scopeOrigin: 'https://www.timeanddate.com',
  scriptMarkers: [],
  startUrl: 'https://www.timeanddate.com/worldclock/',
  tabLabelRe: /time and date|timeanddate|world clock/iu,
  usesDate: false,
};

const STOCKANALYSIS_SCENARIO: BenchScenario = {
  createMessage: "Create a workflow to check a stock's current price by ticker",
  expectedParams: [{ key: 'ticker', re: /ticker|symbol|stock/iu }],
  followUpMessage: 'Run it for {ticker}',
  followUpValues: { ticker: 'msft' },
  id: 'stockanalysis',
  minResultChars: 100,
  resultContentChecks: [{ key: 'price', re: /\d+\.\d\d/u }],
  resultMustContainValues: ['ticker'],
  scopeOrigin: 'https://stockanalysis.com',
  scriptMarkers: [],
  startUrl: 'https://stockanalysis.com/',
  tabLabelRe: /stock analysis|stockanalysis/iu,
  usesDate: false,
};

const REMOTEOK_SCENARIO: BenchScenario = {
  createMessage: 'Create a workflow to find remote jobs for a keyword',
  expectedParams: [{ key: 'keyword', re: /keyword|role|job|title|skill|search|query/iu }],
  followUpMessage: 'Run it for {keyword}',
  followUpValues: { keyword: 'devops' },
  id: 'remoteok',
  minResultChars: 100,
  resultContentChecks: [{ key: 'jobs', re: /remote|apply|salary|jobs?/iu }],
  resultMustContainValues: ['keyword'],
  scopeOrigin: 'https://remoteok.com',
  scriptMarkers: [],
  startUrl: 'https://remoteok.com/',
  tabLabelRe: /remote/iu,
  usesDate: false,
};

// oxlint-disable-next-line anti-slop/no-known-value-widening -- exported as an open dictionary; workflow-create-benchmark.ts looks scenarios up by a dynamic scenario id from CLI args
export const BENCH_SCENARIOS: Readonly<Record<string, BenchScenario>> = {
  allrecipes: ALLRECIPES_SCENARIO,
  arxiv: ARXIV_SCENARIO,
  coingecko: COINGECKO_SCENARIO,
  crates: CRATES_SCENARIO,
  flights: FLIGHTS_SCENARIO,
  github: GITHUB_SCENARIO,
  'github-trending': GITHUB_TRENDING_SCENARIO,
  hn: HN_SCENARIO,
  merriam: MERRIAM_SCENARIO,
  npm: NPM_SCENARIO,
  npr: NPR_SCENARIO,
  openlibrary: OPENLIBRARY_SCENARIO,
  remoteok: REMOTEOK_SCENARIO,
  stackoverflow: STACKOVERFLOW_SCENARIO,
  stockanalysis: STOCKANALYSIS_SCENARIO,
  timeanddate: TIMEANDDATE_SCENARIO,
  tmdb: TMDB_SCENARIO,
  weather: WEATHER_SCENARIO,
  wikipedia: WIKIPEDIA_SCENARIO,
  youtube: YOUTUBE_SCENARIO,
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const ISO_DATE_RE = /^20\d\d-\d\d-\d\d$/u;

/**
 * Human renderings of an ISO date, for matching a page that shows
 * "Sep 22" or "September 22" instead of "2026-09-22". A non-ISO input
 * returns just itself.
 */
export const isoDateVariants = (value: string): string[] => {
  if (!ISO_DATE_RE.test(value)) {
    return [value];
  }
  const [, monthText, dayText] = value.split('-');
  const monthIndex = Number(monthText) - 1;
  const day = String(Number(dayText));
  const month = MONTH_NAMES[monthIndex];
  if (month === undefined) {
    return [value];
  }
  const shortMonth = month.slice(0, 3);
  return [
    value,
    `${shortMonth} ${day}`,
    `${month} ${day}`,
    `${day} ${shortMonth}`,
    `${day} ${month}`,
  ];
};
