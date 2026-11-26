import { UTS_APPS_PAGE_PATH } from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';
import type { HandoffResult, PendingAuthorization } from '../oauth/authorize';
import { classifyFailure } from '../oauth/errors';
import { readForm } from '../oauth/params';
import type { FeedPublish } from '../revocation/publish';
import type { ScopeRegistry } from '../scopes/policy';
import { returnPathOf, signInChoices, type SignInMethods } from '../signin/flows';
import {
  type AppListing,
  type ConsentView,
  appsPage,
  consentPage,
  messagePage,
  signInPage,
  unavailablePage,
} from '../signin/pages';
import { isSameOriginPost } from '../signin/requests';
import { sessionCookieValue } from '../signin/session';
import type { BrowserSession } from '../signin/store';
import { sha256 } from '../token/credentials';
import type { ThirdPartyAccess } from './store';

/**
 * The consent screen of third-party clients (design 5.9, 5.11). It runs inside the sign-in pages'
 * hand-off once the user has a browser session. Consent is per client, organization and scope
 * set: an active consent that covers the requested scopes approves the request at once; otherwise
 * the user sees the client's name, its metadata URL, one consent line per scope and the
 * organization, and ticks each line to allow. Allowing is a tier B action, decided inside the
 * consent statement: a sign-in of this session within 10 minutes, or a passkey step-up of it. The
 * form posts the same authorization URL back from this origin, so a page of another site cannot
 * allow anything for the user.
 *
 * The apps page lists the account's consents and withdraws one: the statement revokes the
 * consent and ends its grant families, and their `third_party_family` feed entries are published
 * before the page answers.
 */

export type ConsentDeps = {
  config: UtsConfig;
  thirdParty: ThirdPartyAccess;
  scopes: ScopeRegistry;
};

/** The consent part of the hand-off, for a request of a third-party client with a session. */
export type ConsentStep = (
  request: Request,
  pending: PendingAuthorization,
  session: BrowserSession
) => Promise<HandoffResult>;

/** The consent line of each scope; null when a scope has none (the registry check forbids it). */
function consentLines(
  scopes: readonly string[],
  registry: ScopeRegistry
): { scope: string; text: string }[] | null {
  const lines: { scope: string; text: string }[] = [];
  for (const scope of scopes) {
    const text = registry(scope)?.consentText ?? null;
    if (text === null) return null;
    lines.push({ scope, text });
  }
  return lines;
}

function interaction(response: Response): HandoffResult {
  return { status: 'interaction', response };
}

export function consentStep(deps: ConsentDeps, methods: SignInMethods): ConsentStep {
  return async (request, pending, session) => {
    const lines = consentLines(pending.scopes, deps.scopes);
    if (lines === null || pending.client.kind !== 'third_party') {
      console.error(JSON.stringify({ event: 'uts.consent.no_consent_line' }));
      return { status: 'denied' };
    }
    const client = pending.client;
    const view = (state: ConsentView['state']): HandoffResult =>
      interaction(
        consentPage({
          clientName: client.name,
          clientId: client.clientId,
          lines,
          orgId: pending.orgHint,
          redirectUri: pending.redirectUri,
          rpId: deps.config.relyingParty.rpId,
          state,
        })
      );
    const failed = (error: unknown): HandoffResult =>
      interaction(unavailablePage(classifyFailure(error, 'consent') === 'retryable'));

    if (request.method !== 'POST') {
      let consentId: string | null;
      try {
        consentId = await deps.thirdParty(store =>
          store.findConsent({
            accountId: session.accountId,
            clientId: client.clientId,
            orgId: pending.orgHint,
            scopes: pending.scopes,
          })
        );
      } catch (error) {
        return failed(error);
      }
      if (consentId === null) return view('ask');
      return approved(session, pending, consentId);
    }

    if (!isSameOriginPost(request)) {
      return interaction(messagePage('Allow an app', 'Open this page again.', 403, null));
    }
    const form = await readForm(request);
    if (form.status === 'invalid') {
      return interaction(messagePage('Allow an app', 'Open this page again.', 400, null));
    }
    const decision = form.params.one('decision');
    if (decision.status === 'present' && decision.value === 'deny') return { status: 'denied' };
    const ticked = new Set(form.params.all('consent'));
    if (
      decision.status !== 'present' ||
      decision.value !== 'allow' ||
      ticked.size !== pending.scopes.length ||
      !pending.scopes.every(scope => ticked.has(scope))
    ) {
      return view('untick');
    }
    const cookie = sessionCookieValue(request);
    if (cookie === null) return { status: 'denied' };
    let granted;
    try {
      const sessionTokenHash = await sha256(cookie);
      granted = await deps.thirdParty(store =>
        store.grantConsent({
          environment: deps.config.environment,
          sessionTokenHash,
          clientId: client.clientId,
          orgId: pending.orgHint,
          scopes: pending.scopes,
        })
      );
    } catch (error) {
      return failed(error);
    }
    switch (granted.outcome) {
      case 'granted':
        return approved(session, pending, granted.consentId);
      case 'gate_required':
        return view('gate');
      case 'no_session': {
        const { pathname, search } = new URL(request.url);
        return interaction(
          signInPage(signInChoices(methods, returnPathOf(`${pathname}${search}`)))
        );
      }
      case 'unknown_client':
      case 'org_denied':
        return { status: 'denied' };
    }
  };
}

function approved(
  session: BrowserSession,
  pending: PendingAuthorization,
  consentId: string
): HandoffResult {
  return {
    status: 'approved',
    approval: {
      clientKind: 'third_party',
      consentId,
      accountId: session.accountId,
      browserSessionId: session.sessionId,
      authTime: session.authTime,
      amr: session.amr,
      orgId: pending.orgHint,
    },
  };
}

export type AppsPageDeps = ConsentDeps & {
  methods: SignInMethods;
  /** Writes the withdrawn families' feed entries to the feed objects (src/revocation/publish.ts). */
  publish: FeedPublish;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** GET /signin/apps lists the account's apps; POST withdraws one, from this page only. */
export async function handleAppsPage(request: Request, deps: AppsPageDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return messagePage('Apps with access', 'Use the apps page.', 405, null);
  }
  const signIn = () => signInPage(signInChoices(deps.methods, UTS_APPS_PAGE_PATH));
  const cookie = sessionCookieValue(request);
  if (cookie === null) return signIn();
  let message: string | null = null;
  let status = 200;
  try {
    const sessionTokenHash = await sha256(cookie);
    if (request.method === 'POST') {
      if (!isSameOriginPost(request)) {
        return messagePage('Apps with access', 'Open this page again.', 403, UTS_APPS_PAGE_PATH);
      }
      const form = await readForm(request);
      const consentParam = form.status === 'ok' ? form.params.one('consent_id') : null;
      if (consentParam?.status !== 'present' || !UUID.test(consentParam.value)) {
        return messagePage('Apps with access', 'Open this page again.', 400, UTS_APPS_PAGE_PATH);
      }
      const consentId = consentParam.value;
      const withdrawn = await deps.thirdParty(store =>
        store.withdrawConsent({ environment: deps.config.environment, sessionTokenHash, consentId })
      );
      if (withdrawn.outcome === 'no_session') return signIn();
      if (withdrawn.outcome === 'not_found') {
        message = 'That app had no access left.';
      } else if ((await deps.publish(withdrawn.feedEntries)) === 'published') {
        message = 'Access withdrawn. The app can no longer act for you.';
      } else {
        // The withdrawal stands in the identity store; the feed backfill adds the entries.
        message = 'Access withdrawn. It can take a few minutes to stop everywhere.';
        status = 202;
      }
    }
    const listing = await deps.thirdParty(store => store.listConsents(sessionTokenHash));
    if (listing === null) return signIn();
    const apps: AppListing[] = listing.map(consent => ({
      consentId: consent.consentId,
      clientName: consent.clientName,
      clientId: consent.clientId,
      lines: consent.scopes.map(scope => deps.scopes(scope)?.consentText ?? scope),
      orgId: consent.orgId,
      grantedAt: consent.grantedAt,
    }));
    return appsPage(apps, message, status);
  } catch (error) {
    return unavailablePage(classifyFailure(error, 'apps_page') === 'retryable');
  }
}
