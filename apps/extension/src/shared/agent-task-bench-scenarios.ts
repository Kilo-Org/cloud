/**
 * Task scenario registry for the use-case benchmark.
 *
 * Each scenario is one realistic single-message request on a public page
 * (the action scenarios log in to a demo shop with published test
 * credentials), pinned to the most popular browser-agent use cases
 * (summarize, page Q&A, extract, translate, draft, research, act on the
 * page).
 * Unlike the workflow scenarios, correctness is scored on the final
 * assistant answer: pinned content checks, a minimum length, and — for
 * facts a model could know from training — tool-result evidence.
 * Scoring reads only these specs — nothing in the product is allowed to
 * special-case a benchmark site by name.
 */

export interface BenchTaskCheck {
  readonly key: string;
  readonly re: RegExp;
  /**
   * The same pattern must also match an ok tool-result value. This pins the
   * answer to page evidence for facts a model could hallucinate from
   * training data.
   */
  readonly requireToolEvidence?: boolean;
}

export interface BenchTaskScenario {
  /** Answer checks; evidence-flagged checks also need a tool-result match. */
  readonly answerChecks: readonly BenchTaskCheck[];
  readonly id: string;
  readonly kind: 'task';
  readonly message: string;
  readonly minAnswerChars: number;
  /**
   * Minimum answerChecks whose pattern must appear in the answer. Defaults
   * to all of them. A generative task (a summary) may set a quorum: a model
   * that provably read the whole page can still choose its own top themes.
   * Tool-evidence requirements are never relaxed by the quorum.
   */
  readonly minAnswerCheckPasses?: number;
  readonly mode: 'dangerous' | 'safe';
  /** True when the scenario needs at least one ok eval exchange (an action, not a lookup). */
  readonly requiresAction: boolean;
  readonly startUrl: string;
  /** Matches the target-tab option label for this scenario's tab. */
  readonly tabLabelRe: RegExp;
  /** The researched use case this scenario pins. */
  readonly useCase: string;
}

/**
 * Summarize a ~67k-char essay. The themes checked first appear ~2k, ~13k,
 * and ~24k characters into the visible text, so a summary read only from a
 * truncated head misses the later ones.
 */
const SUMMARIZE_ARTICLE_SCENARIO: BenchTaskScenario = {
  // The deep themes require tool evidence: this essay is in training data, and the baseline model summarized the truncated page "from familiarity" — the pass must prove the later sections were actually read. Each theme accepts its honest paraphrases: a good summary can say "distraction" for procrastination or "novel ideas" for originality.
  answerChecks: [
    { key: 'curiosity', re: /curiosity|curious/iu },
    {
      key: 'procrastination',
      re: /procrastinat|distract|putting.{1,12}off/iu,
      requireToolEvidence: true,
    },
    { key: 'originality', re: /original|novel|new ideas/iu, requireToolEvidence: true },
  ],
  id: 'summarize-article',
  kind: 'task',
  message:
    'Summarize this essay for me in a few paragraphs. Cover its main themes from beginning to end.',
  minAnswerChars: 400,
  // A full-read summary may still pick its own top themes; two of three must appear, and both deep-theme evidence gates stay mandatory.
  minAnswerCheckPasses: 2,
  mode: 'safe',
  requiresAction: false,
  startUrl: 'https://www.paulgraham.com/greatwork.html',
  tabLabelRe: /great work/iu,
  useCase: 'summarize',
};

/**
 * Answer a question whose answer sits ~50k characters into the page text.
 * Both facts require tool evidence: a model may know them from training.
 */
const QA_DEEP_FACT_SCENARIO: BenchTaskScenario = {
  answerChecks: [
    { key: 'hotel', re: /new yorker/iu, requireToolEvidence: true },
    { key: 'room', re: /3327/u, requireToolEvidence: true },
  ],
  id: 'qa-deep-fact',
  kind: 'task',
  message:
    'According to this page, where exactly did Tesla die? Give the hotel name and the room number.',
  minAnswerChars: 10,
  mode: 'safe',
  requiresAction: false,
  startUrl: 'https://en.wikipedia.org/wiki/Nikola_Tesla',
  tabLabelRe: /tesla/iu,
  useCase: 'page-qa',
};

/** Extract listed titles and prices into a markdown table (small static page). */
const EXTRACT_TABLE_SCENARIO: BenchTaskScenario = {
  answerChecks: [
    { key: 'table', re: /\|[^\n]+\|/u },
    { key: 'price', re: /£\s?\d+\.\d\d/u, requireToolEvidence: true },
    // The site itself truncates long titles ("A Light in the ..."), so the pinned title must be one that renders fully.
    { key: 'title', re: /tipping the velvet/iu, requireToolEvidence: true },
  ],
  id: 'extract-table',
  kind: 'task',
  message:
    'Extract the titles and prices of the first five books on this page into a markdown table with columns Title and Price.',
  minAnswerChars: 100,
  mode: 'safe',
  requiresAction: false,
  startUrl: 'https://books.toscrape.com/',
  tabLabelRe: /books to scrape/iu,
  useCase: 'extract',
};

/** Summarize a German page in English; the height fact must come from the page. */
const TRANSLATE_PAGE_SCENARIO: BenchTaskScenario = {
  answerChecks: [
    { key: 'tower', re: /(?:television|tv) tower/iu },
    { key: 'city', re: /berlin/iu },
    { key: 'height', re: /368/u, requireToolEvidence: true },
  ],
  id: 'translate-page',
  kind: 'task',
  message: "I don't read German. Summarize this page in English for me.",
  minAnswerChars: 200,
  mode: 'safe',
  requiresAction: false,
  startUrl: 'https://de.wikipedia.org/wiki/Berliner_Fernsehturm',
  tabLabelRe: /fernsehturm/iu,
  useCase: 'translate',
};

/** Draft a grounded reply to a stable, closed GitHub issue. */
const DRAFT_REPLY_SCENARIO: BenchTaskScenario = {
  // The issue is famous enough to draft from training memory, so one check pins a fact only the page carries in context: the author says he has worked on his language for 10 years.
  answerChecks: [
    { key: 'topic', re: /\bname\b|naming/iu },
    { key: 'language', re: /language/iu },
    { key: 'tone', re: /thank|appreciate/iu },
    { key: 'grounding', re: /10 years|ten years|a decade/iu, requireToolEvidence: true },
  ],
  id: 'draft-reply',
  kind: 'task',
  message:
    "Draft a polite reply to this GitHub issue on behalf of the maintainers. Summarize the author's concern, including how long he says he has worked on his language, and state a decision.",
  minAnswerChars: 200,
  mode: 'safe',
  requiresAction: false,
  startUrl: 'https://github.com/golang/go/issues/9',
  tabLabelRe: /already used the name/iu,
  useCase: 'draft',
};

/** Log in on a demo shop and report the product count (dangerous mode). */
const ACTION_LOGIN_SCENARIO: BenchTaskScenario = {
  answerChecks: [
    // The saucedemo product count is a canonical tutorial fact; the count must appear in an ok tool result, not from training memory.
    { key: 'count', re: /\b6\b|\bsix\b/iu, requireToolEvidence: true },
    { key: 'context', re: /product|inventory|item/iu },
  ],
  id: 'action-login',
  kind: 'task',
  // The prompt tells the model to ask before authentication actions; the explicit approval keeps a compliant model from stalling on a question the driver never answers.
  message:
    'Log in with username standard_user and password secret_sauce — I approve the login — then tell me how many products are listed.',
  minAnswerChars: 20,
  mode: 'dangerous',
  requiresAction: true,
  startUrl: 'https://www.saucedemo.com/',
  tabLabelRe: /swag labs/iu,
  useCase: 'act',
};

/** Log in, add one item to the cart, and report the badge count (dangerous mode). */
const ACTION_CART_SCENARIO: BenchTaskScenario = {
  answerChecks: [
    // The badge count after one add is a canonical tutorial fact; it must appear in an ok tool result, not from training memory.
    { key: 'count', re: /\b(?:1|one)\b/iu, requireToolEvidence: true },
    { key: 'item', re: /backpack/iu },
  ],
  id: 'action-cart',
  kind: 'task',
  message:
    'Log in with username standard_user and password secret_sauce — I approve the login — add the Sauce Labs Backpack to the cart, and tell me the cart badge count.',
  minAnswerChars: 20,
  mode: 'dangerous',
  requiresAction: true,
  startUrl: 'https://www.saucedemo.com/',
  tabLabelRe: /swag labs/iu,
  useCase: 'act',
};

/**
 * Answer a question the selected page cannot answer, via web_search. The
 * year is trivia any model knows, so it requires tool evidence: the pass
 * proves the answer came from returned search results.
 */
const WEB_RESEARCH_SCENARIO: BenchTaskScenario = {
  answerChecks: [
    { key: 'year', re: /1889/u, requireToolEvidence: true },
    // The scenario's own tab is example.com, so only an off-tab URL proves a citation.
    { key: 'source', re: /https?:\/\/(?!example\.com)/iu },
  ],
  id: 'web-research',
  kind: 'task',
  message:
    'Search the web: in which year was the Eiffel Tower completed? Give the year and cite a source URL.',
  minAnswerChars: 20,
  mode: 'safe',
  requiresAction: false,
  startUrl: 'https://example.com/',
  tabLabelRe: /example/iu,
  useCase: 'research',
};

export const TASK_BENCH_SCENARIOS: Readonly<Record<string, BenchTaskScenario>> = {
  'action-cart': ACTION_CART_SCENARIO,
  'action-login': ACTION_LOGIN_SCENARIO,
  'draft-reply': DRAFT_REPLY_SCENARIO,
  'extract-table': EXTRACT_TABLE_SCENARIO,
  'qa-deep-fact': QA_DEEP_FACT_SCENARIO,
  'summarize-article': SUMMARIZE_ARTICLE_SCENARIO,
  'translate-page': TRANSLATE_PAGE_SCENARIO,
  'web-research': WEB_RESEARCH_SCENARIO,
};
