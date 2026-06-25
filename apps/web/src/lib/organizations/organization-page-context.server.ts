import 'server-only';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Organization, User } from '@kilocode/db/schema';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import {
  getOrganizationRouteIdentifier,
  isUuidOrganizationRouteIdentifier,
} from '@/lib/organizations/organization-route-utils';
import { signInUrlWithCallbackPath } from '@/lib/user/server';

export type OrganizationRouteParams = Promise<{ id: string }>;

export type AuthorizedOrganizationRouteContext = {
  rawRouteIdentifier: string;
  routeIdentifier: string;
  canonicalRouteIdentifier: string;
  user: User & { readonly role: OrganizationRole };
  organization: Organization;
};

export async function getAuthorizedOrganizationRouteContext(
  params: OrganizationRouteParams,
  roles?: OrganizationRole[]
) {
  const { id } = await params;
  const routeIdentifier = decodeURIComponent(id);
  const result = await getAuthorizedOrgContext(routeIdentifier, roles);

  return {
    rawRouteIdentifier: id,
    routeIdentifier,
    result,
  };
}

export async function requireAuthorizedOrganizationRouteContext(
  params: OrganizationRouteParams,
  roles?: OrganizationRole[]
): Promise<AuthorizedOrganizationRouteContext> {
  const { rawRouteIdentifier, routeIdentifier, result } =
    await getAuthorizedOrganizationRouteContext(params, roles);

  if (!result.success) {
    if (result.nextResponse.status === 401) {
      redirect(await signInUrlWithCallbackPath());
    }
    redirect('/profile');
  }

  return {
    rawRouteIdentifier,
    routeIdentifier,
    canonicalRouteIdentifier: getOrganizationRouteIdentifier(result.data.organization),
    user: result.data.user,
    organization: result.data.organization,
  };
}

export async function requireCanonicalOrganizationRouteContext(
  params: OrganizationRouteParams,
  roles?: OrganizationRole[]
): Promise<AuthorizedOrganizationRouteContext> {
  const context = await requireAuthorizedOrganizationRouteContext(params, roles);
  await redirectCanonicalOrganizationRouteIfNeeded(context);
  return context;
}

export async function redirectCanonicalOrganizationRouteIfNeeded({
  rawRouteIdentifier,
  routeIdentifier,
  canonicalRouteIdentifier,
}: Pick<
  AuthorizedOrganizationRouteContext,
  'rawRouteIdentifier' | 'routeIdentifier' | 'canonicalRouteIdentifier'
>) {
  if (
    !isUuidOrganizationRouteIdentifier(routeIdentifier) ||
    canonicalRouteIdentifier === routeIdentifier
  ) {
    return;
  }

  const headersList = await headers();
  const pathname = headersList.get('x-pathname') ?? `/organizations/${rawRouteIdentifier}`;
  const search = headersList.get('x-search') ?? '';
  redirect(
    `${pathname.replace(
      `/organizations/${rawRouteIdentifier}`,
      `/organizations/${canonicalRouteIdentifier}`
    )}${search}`
  );
}
