import type { Organization } from '@kilocode/db/schema';
import {
  OrganizationBrowserAllowedOriginSchema,
  OrganizationBrowserControlSchema,
  normalizeOrganizationBrowserOrigin,
  type OrganizationBrowserControl,
} from '@kilocode/db/schema-types';

/**
 * What a Kilo client must apply for browser automation in this organization.
 * `browserControl` is `allow` (the member's own configuration decides),
 * `playwright_only` (the bundled browser only), or `off` (no browser tools).
 */
export type OrganizationBrowserPolicy = {
  browserControl: OrganizationBrowserControl;
  browserAllowedOrigins: string[];
};

export const DEFAULT_ORGANIZATION_BROWSER_POLICY: OrganizationBrowserPolicy = {
  browserControl: 'allow',
  browserAllowedOrigins: [],
};

type BrowserPolicyOrganization = Pick<Organization, 'settings'>;

function readField(settings: unknown, key: string): unknown {
  if (typeof settings !== 'object' || settings === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(settings, key)?.value;
}

/**
 * An absent control mode means the organization never set a policy, so the client
 * default applies. A stored but unreadable value fails closed: a policy nobody can
 * read must not grant browser access the organization may not have intended.
 */
function readControl(value: unknown): OrganizationBrowserControl {
  if (value === undefined) {
    return DEFAULT_ORGANIZATION_BROWSER_POLICY.browserControl;
  }
  const parsed = OrganizationBrowserControlSchema.safeParse(value);
  return parsed.success ? parsed.data : 'off';
}

/**
 * Origins are independent grants, so one unreadable entry drops only itself; the
 * rest of the list still applies. A missing or non-array value grants nothing.
 */
function readOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const origins = new Set<string>();
  for (const entry of value) {
    const parsed = OrganizationBrowserAllowedOriginSchema.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    const origin = normalizeOrganizationBrowserOrigin(parsed.data);
    if (origin !== null) {
      origins.add(origin);
    }
  }
  return [...origins];
}

/**
 * The policy every client applies. The settings column is jsonb, so each field is
 * parsed on its own rather than as one object: a damaged origin must not erase a
 * readable control mode, and vice versa.
 */
export function resolveOrganizationBrowserPolicy(
  organization: BrowserPolicyOrganization
): OrganizationBrowserPolicy {
  return {
    browserControl: readControl(readField(organization.settings, 'browserControl')),
    browserAllowedOrigins: readOrigins(readField(organization.settings, 'browserAllowedOrigins')),
  };
}
