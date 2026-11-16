import * as z from 'zod';

/**
 * The app-shell URL space. Every route in `src/app/(app-shell)/app-shell` lives
 * under this prefix, and the shell session cookie is set with `Path` equal to
 * it, so the browser never presents that cookie outside the shell.
 */
export const APP_SHELL_PREFIX = '/app-shell';

/** The shell entry point the native app opens with a one-time hand-off token. */
export const APP_SHELL_HANDOFF_PATH = `${APP_SHELL_PREFIX}/handoff`;

/** The terminal shell page that closes the in-app browser. */
export const APP_SHELL_COMPLETE_PATH = `${APP_SHELL_PREFIX}/complete`;

/** The terminal shell page for a missing, used, or expired hand-off. */
export const APP_SHELL_EXPIRED_PATH = `${APP_SHELL_PREFIX}/expired`;

/**
 * The providers whose connect/manage page the shell hosts. Bitbucket is absent
 * on purpose: the app connects Bitbucket natively.
 */
export const APP_SHELL_PLATFORMS = ['github', 'gitlab', 'slack', 'linear', 'discord'] as const;

export type AppShellPlatform = (typeof APP_SHELL_PLATFORMS)[number];

/** The provider names the shell pages show. */
export const APP_SHELL_PLATFORM_LABELS = {
  github: 'GitHub',
  gitlab: 'GitLab',
  slack: 'Slack',
  linear: 'Linear',
  discord: 'Discord',
} as const satisfies Record<AppShellPlatform, string>;

export function isAppShellPlatform(value: string): value is AppShellPlatform {
  return (APP_SHELL_PLATFORMS as readonly string[]).includes(value);
}

const organizationIdSchema = z.uuid();
const platformSchema = z.enum(APP_SHELL_PLATFORMS);

/**
 * Every page the native app may hand off to, with the identifiers each one
 * needs. The hand-off mutation validates against this union, so a target the
 * app never asked for is refused before a token exists.
 */
export const appShellTargetSchema = z.discriminatedUnion('page', [
  z.object({ page: z.literal('github-app'), organizationId: organizationIdSchema.optional() }),
  z.object({
    page: z.literal('integration'),
    platform: platformSchema,
    organizationId: organizationIdSchema.optional(),
  }),
  z.object({ page: z.literal('connected-accounts') }),
  z.object({ page: z.literal('organization-sso'), organizationId: organizationIdSchema }),
  z.object({
    page: z.literal('organization-data-collection'),
    organizationId: organizationIdSchema,
  }),
]);

export type AppShellTarget = z.infer<typeof appShellTargetSchema>;

/**
 * The organization whose membership the hand-off must verify before minting a
 * token, when the target names one.
 */
export function organizationIdOfTarget(target: AppShellTarget): string | null {
  return 'organizationId' in target && target.organizationId ? target.organizationId : null;
}

function integrationPath(platform: AppShellPlatform, organizationId?: string): string {
  if (organizationId) {
    return `${APP_SHELL_PREFIX}/organizations/${organizationId}/integrations/${platform}`;
  }
  return `${APP_SHELL_PREFIX}/integrations/${platform}`;
}

/** The shell path a target opens, including the query the page needs. */
export function buildAppShellTargetPath(target: AppShellTarget): string {
  switch (target.page) {
    case 'github-app':
      return target.organizationId
        ? `${APP_SHELL_PREFIX}/github-app?organizationId=${target.organizationId}`
        : `${APP_SHELL_PREFIX}/github-app`;
    case 'integration':
      return integrationPath(target.platform, target.organizationId);
    case 'connected-accounts':
      return `${APP_SHELL_PREFIX}/connected-accounts`;
    case 'organization-sso':
      return `${APP_SHELL_PREFIX}/organizations/${target.organizationId}/sso`;
    case 'organization-data-collection':
      return `${APP_SHELL_PREFIX}/organizations/${target.organizationId}/data-collection`;
  }
}

/**
 * Whether a path belongs to the shell. Used to assert the boundary in tests and
 * to reject a stored target that is not a shell path.
 */
export function isAppShellPath(path: string): boolean {
  if (!path.startsWith(`${APP_SHELL_PREFIX}/`) && path !== APP_SHELL_PREFIX) return false;
  // `//host` and `/app-shell/../x` would leave the prefix after normalization.
  if (path.includes('\\') || path.startsWith('//')) return false;
  const normalized = new URL(path, 'https://app-shell.invalid');
  return (
    normalized.origin === 'https://app-shell.invalid' &&
    (normalized.pathname === APP_SHELL_PREFIX ||
      normalized.pathname.startsWith(`${APP_SHELL_PREFIX}/`))
  );
}

/**
 * The shell sign-in page for the device-auth flow. The app is not signed in
 * yet when it starts a device-auth sign-in, so it cannot mint a hand-off token;
 * this page is opened directly and keeps the user inside the shell.
 */
export function buildAppShellSignInPath(options: { email?: string; callbackPath: string }): string {
  const params = new URLSearchParams({ callbackPath: options.callbackPath });
  if (options.email) params.set('email', options.email);
  return `${APP_SHELL_PREFIX}/sign-in?${params.toString()}`;
}

/**
 * The shell page that owns a provider's connect/manage state for one owner. A
 * provider the shell does not host has no page, so its flow ends on the
 * terminal shell page rather than a full web page.
 */
export function buildAppShellIntegrationPath(platform: string, organizationId?: string): string {
  if (!isAppShellPlatform(platform)) return APP_SHELL_EXPIRED_PATH;
  return integrationPath(platform, organizationId);
}

/** The OAuth start route the shell opens instead of the full-app one. */
export function buildAppShellConnectPath(
  platform: AppShellPlatform,
  options: { organizationId?: string } = {}
): string {
  const base = `${APP_SHELL_PREFIX}/connect/${platform}`;
  return options.organizationId
    ? `${base}?${new URLSearchParams({ organizationId: options.organizationId }).toString()}`
    : base;
}
