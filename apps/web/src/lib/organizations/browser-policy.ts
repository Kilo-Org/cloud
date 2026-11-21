import {
  MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS,
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

export type OrganizationBrowserPolicyReport = {
  policy: OrganizationBrowserPolicy;
  /**
   * `unreadable` means a control mode is stored but no client can parse it, so the
   * policy is enforced as `off`. Settings surfaces use this to show the enforced
   * value and offer to repair it instead of re-sending the invalid one.
   */
  storedControl: 'absent' | 'readable' | 'unreadable';
};

type BrowserPolicyOrganization = { settings?: unknown };

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
function readControl(value: unknown): {
  browserControl: OrganizationBrowserControl;
  storedControl: OrganizationBrowserPolicyReport['storedControl'];
} {
  if (value === undefined) {
    return {
      browserControl: DEFAULT_ORGANIZATION_BROWSER_POLICY.browserControl,
      storedControl: 'absent',
    };
  }
  const parsed = OrganizationBrowserControlSchema.safeParse(value);
  return parsed.success
    ? { browserControl: parsed.data, storedControl: 'readable' }
    : { browserControl: 'off', storedControl: 'unreadable' };
}

/**
 * Origins are independent grants, so one unreadable entry drops only itself; the
 * rest of the list still applies. A missing or non-array value grants nothing. The
 * list stops at the stored maximum, which is also what a settings save accepts.
 */
function readOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const origins = new Set<string>();
  for (const entry of value) {
    if (origins.size >= MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS) {
      break;
    }
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
 * The policy every client applies, plus how the stored control mode read. The
 * settings column is jsonb, so each field is parsed on its own rather than as one
 * object: a damaged origin must not erase a readable control mode, and vice versa.
 */
export function inspectOrganizationBrowserPolicy(
  organization: BrowserPolicyOrganization
): OrganizationBrowserPolicyReport {
  const control = readControl(readField(organization.settings, 'browserControl'));
  return {
    policy: {
      browserControl: control.browserControl,
      browserAllowedOrigins: readOrigins(readField(organization.settings, 'browserAllowedOrigins')),
    },
    storedControl: control.storedControl,
  };
}

/** The policy every client applies; settings surfaces read the full report instead. */
export function resolveOrganizationBrowserPolicy(
  organization: BrowserPolicyOrganization
): OrganizationBrowserPolicy {
  return inspectOrganizationBrowserPolicy(organization).policy;
}
