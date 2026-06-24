import {
  BitbucketIntegrationMetadataSchema,
  BitbucketWorkspaceAccessTokenMetadataSchema,
} from './metadata';

describe('BitbucketWorkspaceAccessTokenMetadataSchema', () => {
  it('retains only the workspace display name', () => {
    expect(
      BitbucketWorkspaceAccessTokenMetadataSchema.parse({ displayName: 'Kilo Workspace' })
    ).toEqual({ displayName: 'Kilo Workspace' });
    expect(
      BitbucketWorkspaceAccessTokenMetadataSchema.safeParse({
        displayName: 'Kilo Workspace',
        workspaceUuid: '{workspace-uuid}',
      }).success
    ).toBe(false);
    expect(
      BitbucketWorkspaceAccessTokenMetadataSchema.safeParse({
        displayName: 'Kilo Workspace',
        accessToken: 'must-not-be-stored',
      }).success
    ).toBe(false);
  });
});

describe('BitbucketIntegrationMetadataSchema', () => {
  it('accepts pending metadata with available workspaces', () => {
    const metadata = {
      state: 'workspace_selection_required',
      availableWorkspaces: [
        {
          uuid: '{workspace-uuid}',
          slug: 'kilo-workspace',
          name: 'Kilo Workspace',
        },
      ],
    };

    expect(BitbucketIntegrationMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  it('accepts active metadata with one selected workspace', () => {
    const metadata = {
      state: 'active',
      workspace: {
        uuid: '{workspace-uuid}',
        slug: 'kilo-workspace',
        name: 'Kilo Workspace',
      },
    };

    expect(BitbucketIntegrationMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  it('rejects pending metadata without an available workspace', () => {
    expect(
      BitbucketIntegrationMetadataSchema.safeParse({
        state: 'workspace_selection_required',
        availableWorkspaces: [],
      }).success
    ).toBe(false);
  });

  it('rejects pending metadata above the workspace item limit', () => {
    expect(
      BitbucketIntegrationMetadataSchema.safeParse({
        state: 'workspace_selection_required',
        availableWorkspaces: Array.from({ length: 501 }, (_, index) => ({
          uuid: `{workspace-${index}}`,
          slug: `workspace-${index}`,
          name: `Workspace ${index}`,
        })),
      }).success
    ).toBe(false);
  });

  it.each(['uuid', 'slug', 'name'])('rejects blank workspace %s values', field => {
    expect(
      BitbucketIntegrationMetadataSchema.safeParse({
        state: 'active',
        workspace: {
          uuid: '{workspace-uuid}',
          slug: 'kilo-workspace',
          name: 'Kilo Workspace',
          [field]: '   ',
        },
      }).success
    ).toBe(false);
  });

  it.each([
    ['uuid', ' {workspace-uuid}'],
    ['slug', 'kilo-workspace '],
    ['name', ' Kilo Workspace'],
  ])('rejects whitespace-padded workspace %s values', (field, value) => {
    expect(
      BitbucketIntegrationMetadataSchema.safeParse({
        state: 'active',
        workspace: {
          uuid: '{workspace-uuid}',
          slug: 'kilo-workspace',
          name: 'Kilo Workspace',
          [field]: value,
        },
      }).success
    ).toBe(false);
  });

  it.each([
    {
      state: 'workspace_selection_required',
      availableWorkspaces: [
        {
          uuid: '{workspace-uuid}',
          slug: 'kilo-workspace',
          name: 'Kilo Workspace',
        },
      ],
      access_token: 'must-not-be-stored',
    },
    {
      state: 'active',
      workspace: {
        uuid: '{workspace-uuid}',
        slug: 'kilo-workspace',
        name: 'Kilo Workspace',
        links: { self: { href: 'https://api.bitbucket.org/2.0/workspaces/kilo-workspace' } },
      },
    },
  ])('rejects secret-shaped and provider payload fields instead of stripping them', metadata => {
    expect(BitbucketIntegrationMetadataSchema.safeParse(metadata).success).toBe(false);
  });
});
