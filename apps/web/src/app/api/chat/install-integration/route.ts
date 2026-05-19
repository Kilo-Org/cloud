import { after } from 'next/server';
import { Message, ThreadImpl, type SerializedMessage, type SerializedThread } from 'chat';
import { APP_URL } from '@/lib/constants';
import {
  consumeLinkAccountContext,
  linkKiloUser,
  verifyLinkToken,
  type PlatformIdentity,
} from '@/lib/bot-identity';
import {
  initializeBotForLinkReplay,
  reprocessLinkedMessage,
} from '@/lib/bot/reprocess-linked-message';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getTeamsConversationNames } from '@/lib/bot/platforms/teams';
import {
  TeamsTenantAlreadyConnectedError,
  upsertTeamsInstallation,
} from '@/lib/integrations/teams-service';
import type { Owner } from '@/lib/integrations/core/types';
import { getProfileOrganizations } from '@/lib/organizations/organizations';
import { getUserFromAuth } from '@/lib/user.server';
import type { User } from '@kilocode/db';

type VerifiedTeamsInstallPayload = {
  contextKey: string;
  identity: PlatformIdentity & { platform: typeof PLATFORM.TEAMS };
  thread: SerializedThread;
  message: SerializedMessage;
};

type OwnerOption = {
  key: string;
  label: string;
  owner: Owner;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#121212;color:#fafafa">
<main style="width:min(560px,calc(100vw - 32px));border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:24px;background:#2b2b2b">
${body}
</main>
</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

function errorPage(title: string, message: string, status: number): Response {
  return htmlPage(
    title,
    `<h1 style="margin:0 0 8px;font-size:24px">${escapeHtml(title)}</h1><p style="margin:0;color:#a3a3a3;line-height:1.5">${escapeHtml(message)}</p>`,
    status
  );
}

// Redirect targets for the integrations page; the React surface
// (TeamsIntegrationDetails) consumes ?success=installed and
// ?error=tenant_already_connected and shows the matching toast/alert.
function teamsIntegrationsPath(owner: Owner, query: string): string {
  return owner.type === 'org'
    ? `/organizations/${owner.id}/integrations/teams?${query}`
    : `/integrations/teams?${query}`;
}

function redirectToTeamsIntegrations(owner: Owner, query: string): Response {
  return Response.redirect(new URL(teamsIntegrationsPath(owner, query), APP_URL).toString());
}

async function authenticateOrRedirect(url: URL): Promise<{ user: User } | Response> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set('callbackPath', url.pathname + url.search);
    return Response.redirect(signInUrl.toString());
  }
  return { user };
}

async function verifyTeamsInstallPayload(
  token: string
): Promise<VerifiedTeamsInstallPayload | null> {
  const bot = await initializeBotForLinkReplay();
  const payload = await verifyLinkToken(bot.getState(), token);
  if (!payload || payload.identity.platform !== PLATFORM.TEAMS) return null;
  return payload as VerifiedTeamsInstallPayload;
}

async function getOwnerOptions(user: User): Promise<OwnerOption[]> {
  const organizations = await getProfileOrganizations(user.id);
  const adminOrganizations = organizations.filter(
    org => org.role === 'owner' || org.role === 'billing_manager'
  );

  return [
    {
      key: `user:${user.id}`,
      label: `My Kilo account (${user.google_user_email})`,
      owner: { type: 'user', id: user.id },
    },
    ...adminOrganizations.map(org => ({
      key: `org:${org.id}`,
      label: `${org.name} (${org.role})`,
      owner: { type: 'org', id: org.id } satisfies Owner,
    })),
  ];
}

function findSelectedOwner(options: OwnerOption[], selectedKey: string | null): Owner | null {
  return options.find(option => option.key === selectedKey)?.owner ?? null;
}

async function linkAndReplay(params: {
  contextKey: string;
  identity: PlatformIdentity;
  thread: SerializedThread;
  message: SerializedMessage;
  user: User;
}): Promise<void> {
  const bot = await initializeBotForLinkReplay();
  await linkKiloUser(bot.getState(), params.identity, params.user.id);

  if (await consumeLinkAccountContext(bot.getState(), params.contextKey)) {
    after(() =>
      reprocessLinkedMessage({
        identity: params.identity,
        thread: ThreadImpl.fromJSON(params.thread),
        message: Message.fromJSON(params.message),
        user: params.user,
        op: 'install-integration-reprocess-message',
      })
    );
  }
}

function ownerForIntegration(integration: {
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
}): Owner | null {
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

async function finishExistingIntegration(params: {
  payload: VerifiedTeamsInstallPayload;
  user: User;
}): Promise<Response | null> {
  const integration = await getPlatformIntegration(params.payload.identity);
  if (!integration) return null;

  const owner = ownerForIntegration(integration);

  if (!(await canKiloUserAccessPlatformIntegration(integration, params.user.id))) {
    if (owner) {
      return redirectToTeamsIntegrations(owner, 'error=tenant_already_connected');
    }
    return errorPage(
      'Teams tenant already connected',
      'This Teams tenant is already connected to another Kilo account or organization.',
      403
    );
  }

  await linkAndReplay({ ...params.payload, user: params.user });
  if (owner) {
    return redirectToTeamsIntegrations(owner, 'success=installed');
  }
  return errorPage(
    'Teams integration is missing an owner',
    'This Teams integration is missing an owner. Please contact support.',
    500
  );
}

function renderOwnerSelectionForm(params: {
  token: string;
  message: SerializedMessage;
  options: OwnerOption[];
}): Response {
  const names = getTeamsConversationNames(Message.fromJSON(params.message));
  const tenantLabel = names.tenantName ?? 'this Microsoft Teams tenant';
  const optionsHtml = params.options
    .map(
      option =>
        `<label style="display:flex;gap:10px;align-items:flex-start;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px;margin-top:10px"><input type="radio" name="owner" value="${escapeHtml(option.key)}" required>${escapeHtml(option.label)}</label>`
    )
    .join('');

  return htmlPage(
    'Connect Teams to Kilo',
    `<h1 style="margin:0 0 8px;font-size:24px">Connect Teams to Kilo</h1>
<p style="margin:0 0 18px;color:#a3a3a3;line-height:1.5">Choose the Kilo account or organization that should own ${escapeHtml(tenantLabel)}.</p>
<form method="post">
  <input type="hidden" name="token" value="${escapeHtml(params.token)}">
  ${optionsHtml}
  <button type="submit" style="margin-top:18px;width:100%;height:40px;border:0;border-radius:8px;background:#edff00;color:#1f1f1f;font-weight:600;cursor:pointer">Connect Teams</button>
</form>`
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return errorPage('Bad Request', 'Missing token parameter.', 400);

  const payload = await verifyTeamsInstallPayload(token);
  if (!payload) {
    return errorPage(
      'Link Expired',
      'Invalid or expired Teams setup link. Please go back to Teams and mention Kilo again.',
      400
    );
  }

  const auth = await authenticateOrRedirect(url);
  if (auth instanceof Response) return auth;

  const existingResponse = await finishExistingIntegration({ payload, user: auth.user });
  if (existingResponse) return existingResponse;

  const options = await getOwnerOptions(auth.user);
  return renderOwnerSelectionForm({ token, message: payload.message, options });
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const formData = await request.formData();
  const tokenValue = formData.get('token');
  const selectedOwnerValue = formData.get('owner');
  const token = typeof tokenValue === 'string' ? tokenValue : null;
  const selectedOwner = typeof selectedOwnerValue === 'string' ? selectedOwnerValue : null;

  if (!token) return errorPage('Bad Request', 'Missing token parameter.', 400);

  const payload = await verifyTeamsInstallPayload(token);
  if (!payload) {
    return errorPage(
      'Link Expired',
      'Invalid or expired Teams setup link. Please go back to Teams and mention Kilo again.',
      400
    );
  }

  const auth = await authenticateOrRedirect(url);
  if (auth instanceof Response) return auth;

  const existingResponse = await finishExistingIntegration({ payload, user: auth.user });
  if (existingResponse) return existingResponse;

  const options = await getOwnerOptions(auth.user);
  const owner = findSelectedOwner(options, selectedOwner);
  if (!owner) {
    return errorPage('Access Denied', 'You cannot connect Teams to the selected owner.', 403);
  }

  const names = getTeamsConversationNames(Message.fromJSON(payload.message));
  try {
    await upsertTeamsInstallation({
      owner,
      tenantId: payload.identity.teamId,
      tenantName: names.tenantName ?? names.teamName,
    });
  } catch (error) {
    if (error instanceof TeamsTenantAlreadyConnectedError) {
      return redirectToTeamsIntegrations(owner, 'error=tenant_already_connected');
    }
    throw error;
  }

  await linkAndReplay({ ...payload, user: auth.user });
  return redirectToTeamsIntegrations(owner, 'success=installed');
}
