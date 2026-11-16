import {
  canManageOrganizationBilling,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';
import { type Href } from 'expo-router';

/**
 * Whose provider keys a screen shows: the caller's own, or one organization's.
 *
 * The byok router takes the same two shapes — no `organizationId` means the
 * caller's own keys, one means that organization's — so this scope is the one
 * value that selects both the query and the mutation input.
 */
export type ProviderKeyScope =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly organizationId: string };

const PROVIDER_KEYS_PATH = '/(app)/(tabs)/(3_profile)/provider-keys';
const PROVIDER_KEY_ADD_PATH = '/(app)/(tabs)/(3_profile)/provider-key-add';
const PROVIDER_KEY_NEW_PATH = '/(app)/(tabs)/(3_profile)/provider-key-new';

/** The scope a route's `org` parameter selects. No id means the caller's own keys. */
export function providerKeyScope(organizationId: string | undefined): ProviderKeyScope {
  return organizationId ? { kind: 'organization', organizationId } : { kind: 'personal' };
}

/** The byok procedures' input for this scope. */
export function providerKeyScopeInput(scope: ProviderKeyScope): { organizationId?: string } {
  return scope.kind === 'organization' ? { organizationId: scope.organizationId } : {};
}

export type ProviderKeyPermissions = Readonly<{
  /** Any member may read an organization's keys; a personal account is its own owner. */
  canView: boolean;
  /**
   * Adding, replacing, toggling, testing and deleting an organization key all
   * take `ORGANIZATION_BILLING_ROLES` on the server; a personal key is always
   * the caller's own.
   */
  canEdit: boolean;
}>;

/**
 * What this role may do with the scope's keys, mirroring the byok router: the
 * list takes membership, every write takes a billing role.
 */
export function providerKeyPermissions(
  scope: ProviderKeyScope,
  role: OrganizationRole | undefined
): ProviderKeyPermissions {
  if (scope.kind === 'personal') {
    return { canView: true, canEdit: true };
  }
  return { canView: role !== undefined, canEdit: canManageOrganizationBilling(role) };
}

/** The rows-and-definitions screen for this scope. */
export function providerKeysHref(scope: ProviderKeyScope): Href {
  return scope.kind === 'organization'
    ? { pathname: PROVIDER_KEYS_PATH, params: { org: scope.organizationId } }
    : PROVIDER_KEYS_PATH;
}

/** The provider picker for a new key in this scope. */
export function providerKeyAddHref(scope: ProviderKeyScope): Href {
  return scope.kind === 'organization'
    ? { pathname: PROVIDER_KEY_ADD_PATH, params: { org: scope.organizationId } }
    : PROVIDER_KEY_ADD_PATH;
}

/**
 * The value form for one provider. `keyId` opens the form to replace an
 * existing key's credential, which the server never returns, so the form starts
 * empty and the reader enters a new value.
 */
export function providerKeyNewHref(
  scope: ProviderKeyScope,
  providerId: string,
  keyId?: string
): Href {
  const params = {
    provider: providerId,
    ...(keyId === undefined ? {} : { id: keyId }),
    ...(scope.kind === 'organization' ? { org: scope.organizationId } : {}),
  };
  return { pathname: PROVIDER_KEY_NEW_PATH, params };
}
