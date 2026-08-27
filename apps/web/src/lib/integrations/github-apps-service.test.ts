import { describe, expect, it } from '@jest/globals';
import { organizations, platform_integrations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  getIntegrationForOrganization,
  getIntegrationForOwner,
  getPrimaryGitHubIntegrationForOrganization,
} from '@/lib/integrations/db/platform-integrations';
import { getInstallation, isInstallationGoneError, updateModel } from './github-apps-service';

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

  it('keeps the oldest healthy organization installation primary', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub primary ${crypto.randomUUID()}` })
      .returning();
    const oldestCreatedAt = '2026-01-01T00:00:00.000Z';
    const newestCreatedAt = '2026-02-01T00:00:00.000Z';
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
          created_at: oldestCreatedAt,
        },
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
          created_at: newestCreatedAt,
        },
      ])
      .returning();

    try {
      const integration = await getInstallation({ type: 'org', id: organization.id });
      expect(integration?.id).toBe(rows[0].id);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('keeps an auth-invalid installation visible without selecting it as primary', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub recovery ${crypto.randomUUID()}` })
      .returning();
    const [row] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: crypto.randomUUID(),
        integration_status: 'active',
        repository_access: 'all',
        auth_invalid_at: new Date().toISOString(),
        auth_invalid_reason: 'installation_token_auth_failed',
      })
      .returning();

    try {
      const visibleIntegration = await getIntegrationForOrganization(organization.id, 'github');
      const primaryIntegration = await getPrimaryGitHubIntegrationForOrganization(organization.id);
      const ownerIntegration = await getIntegrationForOwner(
        { type: 'org', id: organization.id },
        'github'
      );

      expect(visibleIntegration?.id).toBe(row.id);
      expect(primaryIntegration).toBeNull();
      expect(ownerIntegration).toBeNull();
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });
});

describe('updateModel', () => {
  it('updates only the selected organization installation', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub model update ${crypto.randomUUID()}` })
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
          metadata: { model_slug: 'first-model' },
        },
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
          metadata: { model_slug: 'second-model' },
        },
      ])
      .returning();

    try {
      await expect(
        updateModel({ type: 'org', id: organization.id }, 'updated-model', rows[1].id)
      ).resolves.toEqual({ success: true });

      const integrations = await db
        .select({ id: platform_integrations.id, metadata: platform_integrations.metadata })
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, organization.id));
      expect(integrations).toEqual(
        expect.arrayContaining([
          { id: rows[0].id, metadata: { model_slug: 'first-model' } },
          { id: rows[1].id, metadata: { model_slug: 'updated-model' } },
        ])
      );
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
