import { describe, expect, it } from '@jest/globals';
import { organizations, platform_integrations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { getIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import { getInstallation, isInstallationGoneError } from './github-apps-service';

describe('getInstallation', () => {
  it('prefers a healthy installation when the owner has multiple GitHub rows', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub installation ${crypto.randomUUID()}` })
      .returning();
    const rows = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
          suspended_at: new Date().toISOString(),
        },
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
        },
      ])
      .returning();

    try {
      const integration = await getInstallation({ type: 'org', id: organization.id });
      const sharedIntegration = await getIntegrationForOrganization(organization.id, 'github');

      expect(integration?.id).toBe(rows[1].id);
      expect(sharedIntegration?.id).toBe(rows[1].id);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });
});

describe('isInstallationGoneError', () => {
  it('should return true for 404 Not Found errors', () => {
    const error = { status: 404, message: 'Not Found' };
    expect(isInstallationGoneError(error)).toBe(true);
  });

  it('should return true for 401 Unauthorized errors', () => {
    const error = { status: 401, message: 'Unauthorized' };
    expect(isInstallationGoneError(error)).toBe(true);
  });

  it('should return true for 403 Forbidden errors', () => {
    const error = { status: 403, message: 'Forbidden' };
    expect(isInstallationGoneError(error)).toBe(true);
  });

  it('should return false for 500 Internal Server Error', () => {
    const error = { status: 500, message: 'Internal Server Error' };
    expect(isInstallationGoneError(error)).toBe(false);
  });

  it('should return false for 502 Bad Gateway', () => {
    const error = { status: 502, message: 'Bad Gateway' };
    expect(isInstallationGoneError(error)).toBe(false);
  });

  it('should return false for errors without status property', () => {
    const error = new Error('Some error');
    expect(isInstallationGoneError(error)).toBe(false);
  });

  it('should return false for null', () => {
    expect(isInstallationGoneError(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isInstallationGoneError(undefined)).toBe(false);
  });

  it('should return false for string errors', () => {
    expect(isInstallationGoneError('Not Found')).toBe(false);
  });

  it('should return false for number errors', () => {
    expect(isInstallationGoneError(404)).toBe(false);
  });
});
