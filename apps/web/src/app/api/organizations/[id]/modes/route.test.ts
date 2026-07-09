import { describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { GET } from './route';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { getAllOrganizationModes } from '@/lib/organizations/organization-modes';

jest.mock('@/lib/organizations/organization-auth');
jest.mock('@/lib/organizations/organization-modes');

const mockedGetAuthorizedOrgContext = jest.mocked(getAuthorizedOrgContext);
const mockedGetAllOrganizationModes = jest.mocked(getAllOrganizationModes);

describe('GET /api/organizations/[id]/modes', () => {
  test('returns the direct mode payload without Organization Auto route projection', async () => {
    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        organization: { id: 'org-1' },
      },
    } as never);
    mockedGetAllOrganizationModes.mockResolvedValue([
      {
        id: 'mode-1',
        organization_id: 'org-1',
        name: 'Code',
        slug: 'code',
        created_by: 'user-1',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        config: {
          roleDefinition: 'You are a coding assistant',
          groups: ['read'],
        },
      },
    ]);

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    expect(response).toBeInstanceOf(NextResponse);
    await expect(response.json()).resolves.toEqual({
      modes: [
        {
          id: 'mode-1',
          organization_id: 'org-1',
          name: 'Code',
          slug: 'code',
          created_by: 'user-1',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          config: {
            roleDefinition: 'You are a coding assistant',
            groups: ['read'],
          },
        },
      ],
    });
    expect(mockedGetAllOrganizationModes).toHaveBeenCalledWith('org-1');
  });
});
