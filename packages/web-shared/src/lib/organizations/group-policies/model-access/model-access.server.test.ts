import { afterEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { organizations } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ORGANIZATION_GROUPS_ENTERPRISE_ONLY_MESSAGE } from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
import { getModelAccessPolicyEditorData } from './model-access.server';

const MISSING_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000000';

async function catchTrpcError(promise: Promise<unknown>): Promise<TRPCError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TRPCError) return error;
    throw error;
  }
  throw new Error('Expected the call to throw a TRPCError');
}

describe('getModelAccessPolicyEditorData', () => {
  const createdOrganizationIds: string[] = [];

  afterEach(async () => {
    for (const organizationId of createdOrganizationIds.toReversed()) {
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
    createdOrganizationIds.length = 0;
  });

  it('reports an absent organization as not found', async () => {
    const error = await catchTrpcError(getModelAccessPolicyEditorData(MISSING_ORGANIZATION_ID));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Organization not found');
  });

  it('reports an existing non-Enterprise organization as an Enterprise entitlement error', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Teams Plan Model Access Organization', plan: 'teams' })
      .returning();
    createdOrganizationIds.push(organization.id);

    const error = await catchTrpcError(getModelAccessPolicyEditorData(organization.id));

    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe(ORGANIZATION_GROUPS_ENTERPRISE_ONLY_MESSAGE);
  });

  it('reports a deleted organization as not found', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({
        name: 'Deleted Model Access Organization',
        plan: 'enterprise',
        deleted_at: new Date().toISOString(),
      })
      .returning();
    createdOrganizationIds.push(organization.id);

    const error = await catchTrpcError(getModelAccessPolicyEditorData(organization.id));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Organization not found');
  });
});
