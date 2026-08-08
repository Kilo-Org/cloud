/**
 * Golden-star scenario registry for the workflow-create benchmark.
 *
 * Each scenario is one realistic "automate what I do in the browser" request
 * on a public, login-free site, with pinned correctness expectations:
 * which params the agent must declare, what the stored script must mention,
 * and what a verifying run's result must contain.
 *
 * The five scenarios cover five task shapes: a JS-heavy SPA search (flights),
 * a query-parameter search (hn), a path-encoded lookup (wikipedia), a
 * filtered list on a code host (github), and a classic GET-form site
 * (weather). Scoring reads only these specs — nothing in the product is
 * allowed to special-case a benchmark site by name.
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
  minResultChars: 300,
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

export const BENCH_SCENARIOS: Readonly<Record<string, BenchScenario>> = {
  flights: FLIGHTS_SCENARIO,
  github: GITHUB_SCENARIO,
  hn: HN_SCENARIO,
  weather: WEATHER_SCENARIO,
  wikipedia: WIKIPEDIA_SCENARIO,
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
