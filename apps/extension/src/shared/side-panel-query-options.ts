export const getAuthValidationQueryKey = (token: string): readonly string[] => [
  'side-panel',
  'auth-validation',
  token,
];

export const getGatewayModelsQueryKey = ({
  organizationId,
  token,
}: {
  readonly organizationId: string | undefined;
  readonly token: string;
}): readonly string[] => ['side-panel', 'gateway-models', token, organizationId ?? 'personal'];

export const getOrganizationsQueryKey = (token: string): readonly string[] => [
  'side-panel',
  'organizations',
  token,
];

export const getTabListQueryKey = (): readonly string[] => ['side-panel', 'tabs'];
