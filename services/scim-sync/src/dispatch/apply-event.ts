import type { DirectoryGroup, DirectoryUser, Event } from '@workos-inc/node';

import { callApp, type AppCallContext, type AttemptOutcome } from './app-client';
import {
  DirectoryMembershipRemovalResultSchema,
  DirectoryMembershipResultSchema,
  DirectoryMembershipRevokeAllResultSchema,
  DirectoryMembershipSchema,
  DirectoryOrganizationUpsertSchema,
  DirectorySubOrganizationUpsertSchema,
  DirectorySyncDeleteResultSchema,
  DirectorySyncUpsertResultSchema,
  DirectoryUserRevokeAllSchema,
  DirectoryUserUpsertSchema,
  type DirectoryMembership,
  type DirectoryOrganizationUpsert,
  type DirectorySubOrganizationUpsert,
  type DirectoryUserRevokeAll,
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
 *
 * Total, like `callApp`: an unexpected throw becomes an outcome for *this*
 * event rather than unwinding into the poll's catch, where it would be
 * recorded as a poll-level error with no event id, no `event_failures` row and
 * an unmoved cursor — so every later poll would refetch the same event and
 * throw again, forever, with nothing in the held-failure view naming it.
 */
export async function applyEvent(ctx: AppCallContext, event: Event): Promise<AttemptOutcome> {
  try {
    return await dispatch(ctx, event);
  } catch (error) {
    // `conflict`, deliberately, and neither of the obvious alternatives.
    //
    // Not `unavailable`: an exception here is this Worker failing to build a
    // request, which says nothing about whether the app can answer, and
    // `unavailable` never parks — one unreadable payload would hold the
    // stream indefinitely.
    //
    // Not `terminal` either: a throw is not proof the event is unapplicable.
    // The SDK passes optional fields through without defaulting them, so the
    // same shape may be a missing field this dispatcher should tolerate, a
    // transient failure, or a real bug — and the loop cannot tell which.
    //
    // `conflict` is the only class that both retries and ends: the budget from
    // the first failure gives a transient cause room to clear, and once it is
    // spent the event is parked with its id, so the loop makes progress
    // instead of spinning on one event.
    //
    // The message, not the payload: this dispatcher reads fields off `data`
    // rather than echoing them, so a throw from it carries structural text —
    // and an event's `data` is never logged.
    return {
      class: 'conflict',
      status: null,
      code: null,
      reason: `${event.event} could not be dispatched: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function dispatch(ctx: AppCallContext, event: Event): Promise<AttemptOutcome> {
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
        requestSchema: DirectoryOrganizationUpsertSchema,
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
        ? revokeAllMemberships(ctx, event.data)
        : upsertUser(ctx, event.data);

    case 'dsync.user.deleted':
      // Memberships only, never the account: `softDeleteUser` anonymizes an
      // account and refuses outright when a live subscription exists, so a
      // directory departure is not an account deletion.
      return revokeAllMemberships(ctx, event.data);

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
        requestSchema: DirectoryMembershipSchema,
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
        requestSchema: DirectoryMembershipSchema,
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
    requestSchema: DirectorySubOrganizationUpsertSchema,
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
    requestSchema: DirectoryUserUpsertSchema,
    responseSchema: DirectorySyncUpsertResultSchema,
  });
}

/**
 * The directory user is in the path and its directory is in the body, which
 * scopes the revocation: an account that also belongs to another directory's
 * organization keeps those memberships. `DirectoryUser.directoryId` carries it
 * on both branches that reach here, the hard deletion and the inactive update.
 */
function revokeAllMemberships(ctx: AppCallContext, user: DirectoryUser): Promise<AttemptOutcome> {
  const body: DirectoryUserRevokeAll = { directoryId: user.directoryId };
  return callApp(ctx, {
    method: 'DELETE',
    path: `/api/internal/scim/users/${encodeURIComponent(user.id)}/memberships`,
    body,
    requestSchema: DirectoryUserRevokeAllSchema,
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
