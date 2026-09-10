import { describe, expect, it } from '@jest/globals';
import { organizations, platform_integrations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  getIntegrationForOrganization,
  getIntegrationForOwner,
  getPrimaryGitHubIntegrationForOrganization,
  upsertRepositoryCustomization,
} from '@/lib/integrations/db/platform-integrations';
import {
  getInstallation,
  getRepositoryCustomizations,
  isInstallationGoneError,
  updateInstallationSettings,
  updateModel,
  updateRepositorySettings,
} from './github-apps-service';

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
  it('updates only the targeted installation when integrationId is provided', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub model ${crypto.randomUUID()}` })
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
      const result = await updateModel(
        { type: 'org', id: organization.id },
        'anthropic/claude-sonnet-5',
        rows[1].id
      );

      expect(result).toEqual({ success: true });

      const [updated] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, rows[1].id));
      const [untouched] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, rows[0].id));

      expect((updated?.metadata as Record<string, unknown> | null)?.model_slug).toBe(
        'anthropic/claude-sonnet-5'
      );
      expect(untouched?.metadata).toBeNull();
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('returns an error when no installation matches the owner and integrationId', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub model missing ${crypto.randomUUID()}` })
      .returning();

    try {
      const result = await updateModel(
        { type: 'org', id: organization.id },
        'anthropic/claude-sonnet-5',
        crypto.randomUUID()
      );

      expect(result).toEqual({ success: false, error: 'No GitHub App installation found' });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });
});

async function createGitHubIntegrationWithRepositories() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: `GitHub repo settings ${crypto.randomUUID()}` })
    .returning();
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: crypto.randomUUID(),
      integration_status: 'active',
      repository_access: 'all',
      platform_account_login: 'acme',
      metadata: { model_slug: 'model-a', pr_review_mode: 'on' },
      repositories: [
        { id: 1, name: 'repo-one', full_name: 'acme/repo-one', private: false },
        { id: 2, name: 'repo-two', full_name: 'acme/repo-two', private: true },
      ],
    })
    .returning();

  return { organization, integration };
}

describe('getRepositoryCustomizations', () => {
  it('returns installation defaults and null overrides for every accessible repository', async () => {
    const { organization, integration } = await createGitHubIntegrationWithRepositories();

    try {
      const result = await getRepositoryCustomizations(
        { type: 'org', id: organization.id },
        integration.id
      );

      expect(result.defaultModel).toBe('model-a');
      expect(result.defaultPrReviews).toBe('on');
      expect(result.repositories).toEqual([
        { id: 1, name: 'acme/repo-one', private: false, model: null, prReviews: null },
        { id: 2, name: 'acme/repo-two', private: true, model: null, prReviews: null },
      ]);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('returns the raw (unresolved) override for a repository with a customization row', async () => {
    const { organization, integration } = await createGitHubIntegrationWithRepositories();

    try {
      await upsertRepositoryCustomization(integration.id, '2', {
        bot_mention_model_slug: 'model-b',
        pr_review_mode: 'off',
      });

      const result = await getRepositoryCustomizations(
        { type: 'org', id: organization.id },
        integration.id
      );
      const repoTwo = result.repositories.find(repository => repository.id === 2);

      expect(repoTwo).toEqual({
        id: 2,
        name: 'acme/repo-two',
        private: true,
        model: 'model-b',
        prReviews: 'off',
      });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('throws NOT_FOUND for an integration the owner does not own', async () => {
    const { organization, integration } = await createGitHubIntegrationWithRepositories();

    try {
      await expect(
        getRepositoryCustomizations({ type: 'org', id: crypto.randomUUID() }, integration.id)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });
});

describe('updateInstallationSettings', () => {
  it('atomically merges only the supplied fields, preserving unrelated metadata', async () => {
    const { organization, integration } = await createGitHubIntegrationWithRepositories();

    try {
      const result = await updateInstallationSettings(
        { type: 'org', id: organization.id },
        integration.id,
        { prReviewMode: 'off' }
      );

      expect(result).toEqual({ success: true });

      const [updated] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));

      expect(updated?.metadata).toMatchObject({ model_slug: 'model-a', pr_review_mode: 'off' });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('returns an error when no installation matches the owner and integrationId', async () => {
    const { organization, integration } = await createGitHubIntegrationWithRepositories();

    try {
      const result = await updateInstallationSettings(
        { type: 'org', id: crypto.randomUUID() },
        integration.id,
        { prReviewMode: 'off' }
      );

      expect(result).toEqual({ success: false, error: 'No GitHub App installation found' });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });
});

describe('updateRepositorySettings', () => {
  it('sets a repository override, then clears it back to inheriting with null', async () => {
    const { organization, integration } = await createGitHubIntegrationWithRepositories();

    try {
      const setResult = await updateRepositorySettings(
        { type: 'org', id: organization.id },
        integration.id,
        1,
        { modelSlug: 'model-b', prReviewMode: 'off' }
      );
      expect(setResult).toEqual({ success: true });

      const afterSet = await getRepositoryCustomizations(
        { type: 'org', id: organization.id },
        integration.id
      );
      expect(afterSet.repositories.find(repository => repository.id === 1)).toEqual({
        id: 1,
        name: 'acme/repo-one',
        private: false,
        model: 'model-b',
        prReviews: 'off',
      });

      const clearResult = await updateRepositorySettings(
        { type: 'org', id: organization.id },
        integration.id,
        1,
        { modelSlug: null }
      );
      expect(clearResult).toEqual({ success: true });

      const afterClear = await getRepositoryCustomizations(
        { type: 'org', id: organization.id },
        integration.id
      );
      // Clearing modelSlug alone leaves prReviewMode untouched.
      expect(afterClear.repositories.find(repository => repository.id === 1)).toEqual({
        id: 1,
        name: 'acme/repo-one',
        private: false,
        model: null,
        prReviews: 'off',
      });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('rejects a repository the installation does not currently have access to', async () => {
    const { organization, integration } = await createGitHubIntegrationWithRepositories();

    try {
      const result = await updateRepositorySettings(
        { type: 'org', id: organization.id },
        integration.id,
        999,
        { prReviewMode: 'off' }
      );

      expect(result).toEqual({
        success: false,
        error: 'Repository is not accessible to this installation',
      });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('returns an error when no installation matches the owner and integrationId', async () => {
    const { organization, integration } = await createGitHubIntegrationWithRepositories();

    try {
      const result = await updateRepositorySettings(
        { type: 'org', id: crypto.randomUUID() },
        integration.id,
        1,
        { prReviewMode: 'off' }
      );

      expect(result).toEqual({ success: false, error: 'No GitHub App installation found' });
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
