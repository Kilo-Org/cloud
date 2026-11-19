import { router } from 'expo-router';

// Development-only entry for the PR-review copy surfaces, reached through the
// app's own link scheme and the dev fixture prefix below.
//
// It navigates itself and reports the link as handled, the way the GitLab
// instance fixture does: a link that returns a route to the resolver is
// re-dispatched and races a reset to the tabs root, which lands the reader on
// Home instead of the surface. The link's own query rides along, because the
// submit surface reads the PR triple from it.
//
// The `screen-*` names open the real route SCREENS (`pr-review/[platform]/
// [...identity]/*` and `pr-review/[owner]/[repo]/[number]/*`), so the link has
// to carry the params those screens parse. The shape is the link's choice:
// `?shape=gitlab` reaches the provider route shape, anything else the GitHub
// one; the rest of the query is the screen's own params (the composer's path
// and line, the edit sheet's comment id and body).

const FIXTURE_PATH = /(?:^|\/)dev\/pr-review-copy-fixture\/([a-z0-9-]+)\/?(?:\?([^#]*))?(?:#.*)?$/;

const COPY_SURFACES = [
  'tabs',
  'checks',
  'navigator',
  'files',
  'files-context',
  'merge',
  'submit',
  'checks-not-available',
  'composer',
  'gate-github-error',
  'gate-gitlab-error',
  'gate-bitbucket-error',
  'gate-gitlab-admin-only',
  'overview',
  'overview-no-checks',
  'overview-multi-group',
  'overview-blocked',
  'overview-merged',
  'overview-auto-merge',
  'merge-request',
  'merge-request-missing',
  'merge-request-error',
] as const;

/**
 * The one rejection every fixture write produces. The mutation cache refuses
 * before a mutation function runs and the http link refuses a non-GET, so a
 * pressed submit always settles on this error: the copy surfaces classify it
 * into their own retryable inline failure. Declared here, in the fixture's
 * React-free contract module, so the fake client and the fixture's test read
 * the same string.
 */
export const FIXTURE_WRITE_REFUSED = 'Review copy fixture does not allow writes';

/**
 * The real route screens the fixture can mount. The component that renders
 * them reads this list, so a link can never name a screen the fixture does not
 * mount; this module stays free of React, so the link handler runs before any
 * screen loads.
 */
const ROUTE_SURFACES = [
  'screen-file-navigator',
  'screen-merge',
  'screen-review-submit',
  'screen-comment-composer',
  'screen-conversation-comment',
  'screen-comment-edit',
] as const;

export type PrReviewRouteSurface = (typeof ROUTE_SURFACES)[number];

/** True when a path segment names one of the real-screen surfaces. */
export function isRouteSurface(surface: string | undefined): surface is PrReviewRouteSurface {
  return ROUTE_SURFACES.some(candidate => candidate === surface);
}

const SURFACES: readonly string[] = [...COPY_SURFACES, ...ROUTE_SURFACES];

/** The GitHub route shape's triple: `pr-review/[owner]/[repo]/[number]`. */
const GITHUB_TRIPLE = 'owner=sample&repo=review-copy&number=1';
/**
 * The provider route shape's segments: `[platform]/[...identity]`, project
 * path first and the number last. Repeated keys arrive as the array the
 * catch-all segment would give the route.
 */
const GITLAB_SEGMENTS = 'platform=gitlab&identity=acme&identity=review-copy&identity=7';

/** The diff position the comment-composer screen insists on. */
const COMPOSER_POSITION = 'path=src/greeting.ts&side=RIGHT&line=2';

/**
 * The long body the route screens open with under `state=long`: the edit
 * sheet takes it as its `body` param, the two composers as the draft they
 * seed. Exported here because the link itself carries it.
 */
export const LONG_BODY = [
  'This change folds four separate greeting helpers into one, and the wording',
  'matters more than the diff suggests: the home card, the empty state, the',
  'session list heading and the shared transcript footer all read from this',
  'string, so a rename here is visible in every one of them at once. I checked',
  'each surface against the current copy deck and the only wording that still',
  'matches is "Hello" — "Hi", "Hey" and "Greetings" all came from the older',
  'helper this pull request removes. Please keep the apostrophe in "you\'re"',
  'and the trailing period, because the footer sentence is built by joining',
  'two fragments and the period is what ends the combined sentence. If the',
  'copy deck changes again this list of call sites is the place to start.',
].join(' ');

const MARKDOWN_BODY =
  'Nit: keep the helper name `greeting` so the call sites read the same as before.';

/**
 * The params one screen surface's route parses. `query` is the link's own
 * query, so `shape` and `state` are read from it and everything else rides
 * along untouched.
 */
function screenParams(surface: PrReviewRouteSurface, query: string): string {
  const provider = /(?:^|&)shape=gitlab(?:&|$)/.test(query);
  const shape = provider ? GITLAB_SEGMENTS : GITHUB_TRIPLE;
  if (surface === 'screen-comment-composer') {
    return `${shape}&${COMPOSER_POSITION}`;
  }
  if (surface === 'screen-comment-edit') {
    // The provider route shape has no comment-edit sheet: its own-comment edit
    // lives in the discussion list. The GitHub route carries the body.
    const body = /(?:^|&)state=long(?:&|$)/.test(query) ? LONG_BODY : MARKDOWN_BODY;
    return `${GITHUB_TRIPLE}&commentId=1&kind=review&body=${encodeURIComponent(body)}`;
  }
  return shape;
}

/**
 * Handle a fixture link. True when the path names one of the fixture's
 * surfaces (navigated, so the caller returns falsy and nothing else resolves
 * the link).
 */
export function handlePrReviewCopyFixturePath(path: string): boolean {
  const match = FIXTURE_PATH.exec(path);
  if (!match) {
    return false;
  }
  const surface = match[1];
  if (surface === undefined || !SURFACES.some(candidate => candidate === surface)) {
    return false;
  }
  const extras = match[2] ? `&${match[2]}` : '';
  const routeParams = isRouteSurface(surface) ? `&${screenParams(surface, match[2] ?? '')}` : '';
  // `router` queues the navigation when the router is not mounted yet, so a
  // cold delivery still lands.
  router.replace(`/(auth)/pr-review-copy-fixture?surface=${surface}${routeParams}${extras}`);
  return true;
}
