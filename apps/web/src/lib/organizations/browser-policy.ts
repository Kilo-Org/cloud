import type { Organization } from '@kilocode/db/schema';
import {
  MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS,
  OrganizationBrowserAllowedOriginSchema,
  OrganizationBrowserControlSchema,
  type OrganizationBrowserControl,
} from '@kilocode/db/schema-types';
import * as z from 'zod';

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

const BrowserPolicySettingsSchema = z.object({
  browserControl: OrganizationBrowserControlSchema.optional(),
  browserAllowedOrigins: z
    .array(OrganizationBrowserAllowedOriginSchema)
    .max(MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS)
    .optional(),
});

type BrowserPolicyOrganization = Pick<Organization, 'settings'>;

/**
 * The policy every client applies. The settings column is jsonb, so the browser
 * fields are validated here rather than trusted; an unreadable value falls back
 * to the documented default for that field.
 */
export function resolveOrganizationBrowserPolicy(
  organization: BrowserPolicyOrganization
): OrganizationBrowserPolicy {
  const parsed = BrowserPolicySettingsSchema.safeParse(organization.settings);
  if (!parsed.success) {
    return DEFAULT_ORGANIZATION_BROWSER_POLICY;
  }
  return {
    browserControl:
      parsed.data.browserControl ?? DEFAULT_ORGANIZATION_BROWSER_POLICY.browserControl,
    browserAllowedOrigins: parsed.data.browserAllowedOrigins ?? [],
  };
}
