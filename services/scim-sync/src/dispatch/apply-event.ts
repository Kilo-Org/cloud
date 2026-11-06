import type { DirectoryGroup, DirectoryUser, Event } from '@workos-inc/node';

import { callApp, type AppCallContext, type AttemptOutcome } from './app-client';
import {
  DirectoryMembershipRemovalResultSchema,
  DirectoryMembershipResultSchema,
  DirectoryMembershipRevokeAllResultSchema,
  DirectorySyncDeleteResultSchema,
  DirectorySyncUpsertResultSchema,
  type DirectoryMembership,
  type DirectoryOrganizationUpsert,
  type DirectorySubOrganizationUpsert,
  type DirectoryUserUpsert,
} from '@kilocode/scim-contracts';

/**
 * Maps one WorkOS directory event onto the app's internal endpoints and
 * applies it.
 *
 * The calls an event maps to run in order and stop at the first that is not
 * `applied`: a membership add whose group upsert conflicted has nothing to add
 * the user to. The caller commits the cursor only when every call applied, so
 * a partial event replays in full — which is safe, because every route is an
 * idempotent upsert keyed on a WorkOS identifier.
 */
export async function applyEvent(ctx: AppCallContext, event: Event): Promise<AttemptOutcome> {
  switch (event.event) {
    case 'dsync.activated': {
      // Without an organization there is nothing to bind the directory to, and
      // no request body can express its absence. Terminal without a call: the
      // field is assigned when the directory is created, so it does not
      // appear later.
      const { organizationId } = event.data;
      if (organizationId === undefined || organizationId === '') {
        return terminalPayload(
          'dsync.activated carries no organizationId, so no organization can be bound'
        );
      }

      const body: DirectoryOrganizationUpsert = {
        workOSOrganizationId: organizationId,
        name: event.data.name,
        capturedDomains: event.data.domains.map(d => d.domain),
      };
      return callApp(ctx, {
        method: 'PUT',
        path: `/api/internal/scim/organizations/${encodeURIComponent(event.data.id)}`,
        body,
        responseSchema: DirectorySyncUpsertResultSchema,
      });
    }

    case 'dsync.deleted':
      return callApp(ctx, {
        method: 'DELETE',
        path: `/api/internal/scim/organizations/${encodeURIComponent(event.data.id)}`,
        responseSchema: DirectorySyncDeleteResultSchema,
      });

    case 'dsync.group.created':
    case 'dsync.group.updated':
      return upsertGroup(ctx, event.data);

    case 'dsync.group.deleted':
      return callApp(ctx, {
        method: 'DELETE',
        path: `/api/internal/scim/sub-organizations/${encodeURIComponent(event.data.id)}`,
        responseSchema: DirectorySyncDeleteResultSchema,
      });

    case 'dsync.user.created':
      return upsertUser(ctx, event.data);

    case 'dsync.user.updated':
      // `inactive` is the identity provider deprovisioning the person without
      // removing them, so it revokes access rather than applying attributes.
      return event.data.state === 'inactive'
        ? revokeAllMemberships(ctx, event.data.id)
        : upsertUser(ctx, event.data);

    case 'dsync.user.deleted':
      // Memberships only, never the account: `softDeleteUser` anonymizes an
      // account and refuses outright when a live subscription exists, so a
      // directory departure is not an account deletion.
      return revokeAllMemberships(ctx, event.data.id);

    case 'dsync.group.user_added': {
      // The payload carries the whole group and the whole user, which is every
      // field their upserts need, so both run first and the event no longer
      // depends on its `group.created` and `user.created` having been seen.
      // Both are no-ops in the normal case.
      const group = await upsertGroup(ctx, event.data.group);
      if (group.class !== 'applied') return group;

      const user = await upsertUser(ctx, event.data.user);
      if (user.class !== 'applied') return user;

      const body: DirectoryMembership = {
        directoryGroupId: event.data.group.id,
        externalId: event.data.user.id,
      };
      return callApp(ctx, {
        method: 'PUT',
        path: '/api/internal/scim/memberships',
        body,
        responseSchema: DirectoryMembershipResultSchema,
      });
    }

    case 'dsync.group.user_removed': {
      // No prerequisite upserts. An unknown group or user means there is no
      // membership to revoke, which is what the event asserts, and the route
      // converges on that; provisioning them would create an account for a
      // user who is leaving the directory.
      const body: DirectoryMembership = {
        directoryGroupId: event.data.group.id,
        externalId: event.data.user.id,
      };
      return callApp(ctx, {
        method: 'DELETE',
        path: '/api/internal/scim/memberships',
        body,
        responseSchema: DirectoryMembershipRemovalResultSchema,
      });
    }

    default:
      // Unreachable through the Events API: `DSYNC_EVENTS` is an allowlist, so
      // nothing else is ever returned. Terminal rather than thrown, so that a
      // filter and a dispatcher that disagree after a deploy park one event
      // instead of stalling the whole stream.
      return terminalPayload(`unhandled event type ${event.event}`);
  }
}

function upsertGroup(ctx: AppCallContext, group: DirectoryGroup): Promise<AttemptOutcome> {
  const body: DirectorySubOrganizationUpsert = {
    directoryId: group.directoryId,
    directoryIdpId: group.idpId,
    name: group.name,
  };
  return callApp(ctx, {
    method: 'PUT',
    path: `/api/internal/scim/sub-organizations/${encodeURIComponent(group.id)}`,
    body,
    responseSchema: DirectorySyncUpsertResultSchema,
  });
}

function upsertUser(ctx: AppCallContext, user: DirectoryUser): Promise<AttemptOutcome> {
  // The SDK types `email` nullable and the endpoint requires it, because a
  // Kilo account cannot exist without an address. A directory user without
  // one is terminal without a call: no request body can express it, and no
  // later event re-sends this one.
  if (user.email === null || user.email === '') {
    return Promise.resolve(
      terminalPayload('directory user carries no email, which the user upsert requires')
    );
  }

  const body: DirectoryUserUpsert = {
    directoryId: user.directoryId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
  };
  return callApp(ctx, {
    method: 'PUT',
    path: `/api/internal/scim/users/${encodeURIComponent(user.id)}`,
    body,
    responseSchema: DirectorySyncUpsertResultSchema,
  });
}

function revokeAllMemberships(ctx: AppCallContext, externalId: string): Promise<AttemptOutcome> {
  return callApp(ctx, {
    method: 'DELETE',
    path: `/api/internal/scim/users/${encodeURIComponent(externalId)}/memberships`,
    responseSchema: DirectoryMembershipRevokeAllResultSchema,
  });
}

/**
 * A payload this dispatcher cannot turn into a request at all. Terminal with
 * no HTTP call and no status, because there is nothing to ask the app.
 */
function terminalPayload(reason: string): AttemptOutcome {
  return { class: 'terminal', status: null, code: null, reason };
}
