import { bot } from '@/lib/bot';
import { APP_URL } from '@/lib/constants';
import { linkKiloUser, type PlatformIdentity, verifyLinkToken } from '@/lib/bot-identity';
import { db } from '@/lib/drizzle';
import {
  getUserOrganizationsWithSeats,
  isOrganizationMember,
} from '@/lib/organizations/organizations';
import { getUserFromAuth } from '@/lib/user.server';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { upsertSlackInstallation } from '@/lib/integrations/slack-service';
import { upsertTeamsInstallation } from '@/lib/integrations/teams-service';
import { platform_integrations } from '@kilocode/db';
import type { User } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

const INSTALLABLE_PLATFORMS = new Set<string>([PLATFORM.SLACK, PLATFORM.TEAMS]);
const ORG_OWNER_ROLES = new Set(['owner', 'billing_manager']);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a">
<main style="width:min(560px,calc(100vw - 32px));background:white;border:1px solid #e2e8f0;border-radius:16px;padding:32px;box-shadow:0 20px 50px rgba(15,23,42,.08)">
${body}
</main>
</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

function errorPage(title: string, message: string, status: number): Response {
  return page(
    title,
    `<h1 style="margin:0 0 12px;font-size:24px">${escapeHtml(title)}</h1>
<p style="margin:0;line-height:1.5;color:#475569">${escapeHtml(message)}</p>`,
    status
  );
}

function successPage(platform: string): Response {
  return page(
    'Workspace Connected',
    `<h1 style="margin:0 0 12px;font-size:24px">Workspace connected</h1>
<p style="margin:0;line-height:1.5;color:#475569">Your ${escapeHtml(platformLabel(platform))} workspace and chat account are now linked to Kilo. You can close this tab and @mention Kilo again.</p>`
  );
}

function platformLabel(platform: string): string {
  switch (platform) {
    case PLATFORM.SLACK:
      return 'Slack';
    case PLATFORM.TEAMS:
      return 'Microsoft Teams';
    default:
      return platform;
  }
}

async function authenticateOrRedirect(requestUrl: URL) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (!authFailedResponse) return { user, response: null };

  const signInUrl = new URL('/users/sign_in', APP_URL);
  signInUrl.searchParams.set('callbackPath', requestUrl.pathname + requestUrl.search);
  return { user: null, response: Response.redirect(signInUrl.toString()) };
}

function verifyInstallToken(token: string | null): PlatformIdentity | null {
  if (!token) return null;
  const identity = verifyLinkToken(token);
  if (!identity || !INSTALLABLE_PLATFORMS.has(identity.platform)) return null;
  return identity;
}

async function findPlatformIntegration(identity: PlatformIdentity) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, identity.platform),
        eq(platform_integrations.platform_installation_id, identity.teamId)
      )
    )
    .limit(1);

  return integration ?? null;
}

async function verifyIntegrationAccess(
  integration: NonNullable<Awaited<ReturnType<typeof findPlatformIntegration>>>,
  kiloUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (integration.integration_status !== INTEGRATION_STATUS.ACTIVE) {
    return { ok: false, error: 'This workspace integration is not active.' };
  }

  if (integration.owned_by_organization_id) {
    const isMember = await isOrganizationMember(integration.owned_by_organization_id, kiloUserId);
    if (!isMember) {
      return {
        ok: false,
        error: 'You are not a member of the organization that owns this workspace integration.',
      };
    }
    return { ok: true };
  }

  if (integration.owned_by_user_id === kiloUserId) {
    return { ok: true };
  }

  return { ok: false, error: 'You are not the owner of this workspace integration.' };
}

async function parseOwner(
  ownerValue: FormDataEntryValue | null,
  user: User
): Promise<Owner | null> {
  if (ownerValue === `user:${user.id}`) {
    return { type: 'user', id: user.id };
  }

  if (typeof ownerValue !== 'string' || !ownerValue.startsWith('org:')) {
    return null;
  }

  const organizationId = ownerValue.slice('org:'.length);
  const organizations = await getUserOrganizationsWithSeats(user.id);
  const organization = organizations.find(org => org.organizationId === organizationId);
  if (!organization || !ORG_OWNER_ROLES.has(organization.role)) {
    return null;
  }

  return { type: 'org', id: organizationId };
}

async function createIntegration(identity: PlatformIdentity, owner: Owner): Promise<void> {
  if (identity.platform === PLATFORM.TEAMS) {
    await upsertTeamsInstallation({
      owner,
      tenantId: identity.teamId,
      tenantName: identity.teamName,
    });
    return;
  }

  if (identity.platform === PLATFORM.SLACK) {
    await bot.initialize();
    const installation = await bot.getAdapter('slack').getInstallation(identity.teamId);
    if (!installation) {
      throw new Error('Slack authorization is missing. Please reinstall Slack from Kilo.');
    }

    await upsertSlackInstallation({ owner, teamId: identity.teamId, installation });
    return;
  }

  throw new Error(`Unsupported platform: ${identity.platform}`);
}

async function linkIdentity(identity: PlatformIdentity, kiloUserId: string): Promise<void> {
  await bot.initialize();
  await linkKiloUser(bot.getState(), identity, kiloUserId);
}

function installForm({
  identity,
  token,
  organizations,
  user,
}: {
  identity: PlatformIdentity;
  token: string;
  organizations: Awaited<ReturnType<typeof getUserOrganizationsWithSeats>>;
  user: User;
}): Response {
  const platform = platformLabel(identity.platform);
  const orgOptions = organizations
    .filter(org => ORG_OWNER_ROLES.has(org.role))
    .map(
      org =>
        `<label style="display:block;margin-top:10px"><input type="radio" name="owner" value="org:${escapeHtml(org.organizationId)}"> ${escapeHtml(org.organizationName)}</label>`
    )
    .join('');

  return page(
    `Connect ${platform}`,
    `<h1 style="margin:0 0 12px;font-size:24px">Connect ${escapeHtml(platform)} to Kilo</h1>
<p style="margin:0 0 24px;line-height:1.5;color:#475569">Choose the Kilo account or organization that should own this ${escapeHtml(platform)} workspace integration.</p>
<form method="post" style="margin:0">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <label style="display:block"><input type="radio" name="owner" value="user:${escapeHtml(user.id)}" checked> My Kilo account</label>
  ${orgOptions}
  <button type="submit" style="margin-top:24px;border:0;border-radius:10px;background:#0f172a;color:white;padding:10px 16px;font-weight:600;cursor:pointer">Connect workspace</button>
</form>`
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const identity = verifyInstallToken(token);
  if (!identity || !token) {
    return errorPage(
      'Invalid Link',
      'Invalid or expired workspace connection link. Please go back to your chat and try again.',
      400
    );
  }

  const auth = await authenticateOrRedirect(url);
  if (auth.response) return auth.response;
  const user = auth.user;

  const existing = await findPlatformIntegration(identity);
  if (existing) {
    const access = await verifyIntegrationAccess(existing, user.id);
    if (!access.ok) return errorPage('Access Denied', access.error, 403);

    await linkIdentity(identity, user.id);
    return successPage(identity.platform);
  }

  const organizations = await getUserOrganizationsWithSeats(user.id);
  return installForm({ identity, token, organizations, user });
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const formData = await request.formData();
  const tokenEntry = formData.get('token');
  const token = typeof tokenEntry === 'string' ? tokenEntry : null;
  const identity = verifyInstallToken(token);
  if (!identity) {
    return errorPage(
      'Invalid Link',
      'Invalid or expired workspace connection link. Please go back to your chat and try again.',
      400
    );
  }

  const auth = await authenticateOrRedirect(url);
  if (auth.response) return auth.response;
  const user = auth.user;

  const existing = await findPlatformIntegration(identity);
  if (existing) {
    const access = await verifyIntegrationAccess(existing, user.id);
    if (!access.ok) return errorPage('Access Denied', access.error, 403);

    await linkIdentity(identity, user.id);
    return successPage(identity.platform);
  }

  const owner = await parseOwner(formData.get('owner'), user);
  if (!owner) {
    return errorPage(
      'Access Denied',
      'You cannot connect this workspace to the selected Kilo owner.',
      403
    );
  }

  try {
    await createIntegration(identity, owner);
    await linkIdentity(identity, user.id);
    return successPage(identity.platform);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to connect this workspace.';
    return errorPage('Connection Failed', message, 500);
  }
}
