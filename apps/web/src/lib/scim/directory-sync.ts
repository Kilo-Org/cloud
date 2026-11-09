import {
  kilocode_users,
  organization_membership_removals,
  organization_memberships,
  organizations,
  user_auth_provider,
} from '@kilocode/db/schema';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import { getLowerDomainFromEmail, normalizeEmail } from '@kilocode/web-shared/lib/email-address';
import { randomUUID } from 'node:crypto';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import {
  resolveEffectiveOrganizationSsoPolicy,
  resolveSsoAuthorityForDomain,
} from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import {
  addUserToOrganization,
  createOrganization,
  markOrganizationAsDeleted,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { and, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';

import { createChildOrganization } from '@/lib/organizations/organization-hierarchy';
import { removeUserFromOrganization } from '@/lib/organizations/organization-member-removal';
import { extractEmailDomain } from '@/lib/email-domain';
import { createOrUpdateUser, findUserByNormalizedEmail } from '@/lib/user';

import type {
  DirectoryMembership,
  DirectoryMembershipRemovalResult,
  DirectoryMembershipResult,
  DirectoryOrganizationUpsert,
  DirectorySubOrganizationUpsert,
  DirectorySyncDeleteResult,
  DirectorySyncUpsertResult,
  DirectoryUserUpsert,
} from './directory-sync-contracts';

/**
 * Directory-sync mutations, invoked by the `scim-sync` Worker.
 *
 * Every function here is idempotent on a WorkOS identifier and delegates the
 * actual write to the same primitive the product uses, so the advisory locks,
 * depth validation, soft-delete side effects, Stripe customer creation, and
 * removal tombstone all behave identically to a human performing the action.
 */

/** Rows are matched among live organizations only. The directory and external
 * id unique indexes are partial on `deleted_at IS NULL`, so a soft-deleted
 * organization can hold the same binding as a live one. */
const liveOrganization = isNull(organizations.deleted_at);

/**
 * The organization a directory belongs to is the unparented row carrying its
 * `directory_id`. The filter is load-bearing: a sub-organization inherits its
 * parent's `directory_id` as well, so once a group exists the directory matches
 * two live rows, and an unordered `limit(1)` would resolve to whichever the
 * planner returned — PostgreSQL gives no row order without `ORDER BY`, and an
 * update rewriting the parent's tuple is enough to move it behind the child.
 */
function directoryOwner(directoryId: string): SQL | undefined {
  return and(
    eq(organizations.directory_id, directoryId),
    isNull(organizations.parent_organization_id),
    liveOrganization
  );
}

export class DirectorySyncConflictError extends Error {}

/**
 * Bind a WorkOS directory to a parent organization.
 *
 * Matches an existing organization by `external_org_id`, which is how a
 * customer-created organization is adopted by directory sync, and otherwise
 * creates one. Creating with no `userId` means no owner membership is written:
 * a directory has no Kilo actor to credit, and members arrive through
 * `dsync.group.user_added`.
 *
 * The event's captured domains are applied on every path, so an organization
 * that gains a domain later picks it up on the next `dsync.activated` rather
 * than only at creation.
 */
export async function upsertDirectoryOrganization(
  directoryId: string,
  input: DirectoryOrganizationUpsert
): Promise<DirectorySyncUpsertResult> {
  const alreadyBound = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(directoryOwner(directoryId))
    .limit(1);

  const bound = alreadyBound.at(0);
  if (bound) {
    await captureDirectoryDomain(bound.id, input.capturedDomains);
    return { id: bound.id, created: false };
  }

  const byExternalId = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.external_org_id, input.workOSOrganizationId), liveOrganization))
    .limit(1);

  const existing = byExternalId.at(0);
  if (existing) {
    await db
      .update(organizations)
      .set({ directory_id: directoryId })
      .where(eq(organizations.id, existing.id));
    await captureDirectoryDomain(existing.id, input.capturedDomains);
    return { id: existing.id, created: false };
  }

  // `createOrganization` owns its own transaction and takes no outer one, so
  // create and bind cannot be atomic. `external_org_id` is written first and
  // alone: it is unique among live rows, so a crash before `directory_id` lands
  // leaves a row the lookup above finds on replay and adopts, rather than an
  // invisible orphan that would be duplicated. `directory_id` is not unique and
  // could not provide that guarantee.
  const created = await createOrganization(input.name, null, false);
  await db
    .update(organizations)
    .set({ external_org_id: input.workOSOrganizationId })
    .where(eq(organizations.id, created.id));
  await db
    .update(organizations)
    .set({ directory_id: directoryId })
    .where(eq(organizations.id, created.id));
  await captureDirectoryDomain(created.id, input.capturedDomains);

  return { id: created.id, created: true };
}

/**
 * Records a WorkOS-captured domain as the organization's `sso_domain`, when it
 * has none.
 *
 * The domain is trusted: our administrators gate directory intake, so a domain
 * on the event has already passed a human. What is not trusted is that it is
 * free — Policy Resolution rule 6 forbids two authorities claiming one domain,
 * and `resolveSsoAuthorityForDomain` fails closed on an ambiguous one, which
 * would break authentication for both organizations. So this takes the first
 * candidate no other live organization holds, under the same advisory lock
 * `updateSsoDomain` uses, and leaves `sso_domain` unset when every candidate is
 * taken.
 *
 * It only ever fills an empty `sso_domain`. Moving an existing one would change
 * who must authenticate through SSO and which addresses a takeover may claim,
 * and `data.domains[]` promises no order, so a reordered or extended list would
 * otherwise shift authority between activations.
 *
 * An absent or empty list says nothing about domains rather than clearing one:
 * `dsync.deleted` omits `domains` entirely, and releasing an SSO domain is a
 * deliberate administrative action (`clearSsoDomain`), not a sync side effect.
 *
 * Nothing is written when the row already carries a domain, so a replayed event
 * is a no-op and does not re-audit.
 */
async function captureDirectoryDomain(
  organizationId: string,
  capturedDomains: readonly string[] | undefined
): Promise<void> {
  if (!capturedDomains || capturedDomains.length === 0) return;

  const candidates = capturedDomains
    .map(candidate => candidate.trim().toLowerCase())
    .filter(candidate => candidate !== '');
  if (candidates.length === 0) return;

  await db.transaction(async tx => {
    const [organization] = await tx
      .select({ ssoDomain: organizations.sso_domain })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('update');
    if (!organization) return;

    // An organization that already has a domain keeps it, whether or not the
    // event still lists it. `sso_domain` decides who must sign in through SSO
    // and which addresses a takeover may claim, and the event's order carries
    // no promise — a reordered or extended `data.domains[]` would otherwise
    // move authority between activations. Replacing a domain stays a
    // deliberate administrative action.
    if (organization.ssoDomain !== null) return;

    for (const domain of candidates) {
      // Same lock `updateSsoDomain` takes, so a concurrent human capture of the
      // same domain cannot interleave with this one.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('sso-domain:' || ${domain}, 0))`
      );
      const authority = await resolveSsoAuthorityForDomain(domain, tx);
      if (authority.status === 'required' && authority.sourceOrganizationId !== organizationId) {
        continue;
      }
      if (authority.status === 'misconfigured') continue;

      await tx
        .update(organizations)
        .set({ sso_domain: domain })
        .where(eq(organizations.id, organizationId));

      // The same action a human capture writes, with a null actor, which is how
      // this repo records a system-initiated organization change.
      await createAuditLog({
        action: 'organization.sso.set_domain',
        actor_email: null,
        actor_id: null,
        actor_name: null,
        message: `Set SSO domain to ${domain} from WorkOS directory sync`,
        organization_id: organizationId,
        tx,
      });
      return;
    }
  });
}

/**
 * Bind a WorkOS directory group to a sub-organization under the directory's
 * organization.
 *
 * A directory group maps to a sub-organization, not to Kilo's
 * `organization_groups` table — that holds model-access policies and is
 * unrelated to directory sync.
 */
export async function upsertDirectorySubOrganization(
  directoryGroupId: string,
  input: DirectorySubOrganizationUpsert
): Promise<DirectorySyncUpsertResult> {
  const parentRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(directoryOwner(input.directoryId))
    .limit(1);

  const parent = parentRows.at(0);
  if (!parent) {
    // The hierarchy is one level deep, so a group cannot nest under a group.
    // A directory whose only live row is parented is that case, and it reads
    // differently from a directory with no organization at all, so the Worker
    // gets told which one it hit.
    const parentedRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.directory_id, input.directoryId), liveOrganization))
      .limit(1);
    const parented = parentedRows.at(0);
    throw new DirectorySyncConflictError(
      parented
        ? `Organization ${parented.id} is itself a sub-organization and cannot take children`
        : `No live organization is bound to directory ${input.directoryId}`
    );
  }

  const existingRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.directory_group_id, directoryGroupId), liveOrganization))
    .limit(1);

  const existing = existingRows.at(0);
  if (existing) {
    // Groups get renamed and reconnected, so name and IdP id are refreshed.
    await db
      .update(organizations)
      .set({
        name: input.name,
        directory_id: input.directoryId,
        directory_idp_id: input.directoryIdpId,
        parent_organization_id: parent.id,
      })
      .where(eq(organizations.id, existing.id));
    return { id: existing.id, created: false };
  }

  // Created already bound, in one statement. `createChildOrganization` commits
  // its own transaction and then provisions a Stripe customer outside it, so a
  // binding written afterwards would leave a live sub-organization carrying no
  // `directory_group_id` whenever that provisioning failed — invisible to the
  // lookup above, and duplicated by every retry. Passing the binding into the
  // insert means the row is either absent or fully bound, so a retry either
  // finds it above or creates it cleanly.
  const child = await createChildOrganization(input.name, parent.id, undefined, {
    directory_id: input.directoryId,
    directory_group_id: directoryGroupId,
    directory_idp_id: input.directoryIdpId,
  });

  return { id: child.id, created: true };
}

/**
 * Bind a WorkOS directory user to a Kilo user.
 *
 * Whether the address matches a pre-existing account (which is then taken over)
 * or binds to a freshly created one, it is accepted only when its domain equals
 * the Effective SSO policy domain of the directory's organization. Domain
 * capture is what establishes the enterprise's claim to the address, and the
 * identity provider has asserted that this person holds it, so a takeover is
 * converted to the SSO authority's WorkOS identity rather than refused or
 * duplicated. A non-matching domain is refused: an unverified domain is not the
 * enterprise's to claim. Every SCIM account is expected to be
 * domain-captured, so a refusal means the directory is pushing an address its
 * organization never proved it owns.
 *
 * Both paths go through `createOrUpdateUser` with `provider: 'workos'` and
 * `autoLinkToExistingUser`, which owns the whole settlement: for an existing
 * address it replaces the account's auth providers with the `workos` row and
 * rotates `web_session_pepper` in one transaction, so the prior holder keeps
 * neither a non-SSO login nor a live browser session (Authentication rules 1,
 * 2, and 7); for a new address it owns the Stripe customer, the
 * normalized-email dedup, the soft-delete fence, and the compensating Stripe
 * delete when any of those reject.
 *
 * See `.specs/organization-sso.md`, Directory Sync rule 13.
 */
export async function upsertDirectoryUser(
  externalId: string,
  input: DirectoryUserUpsert
): Promise<DirectorySyncUpsertResult> {
  const byExternalId = await db
    .select({
      id: kilocode_users.id,
      email: kilocode_users.google_user_email,
      name: kilocode_users.google_user_name,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.external_id, externalId))
    .limit(1);

  const bound = byExternalId.at(0);
  if (bound) {
    await applyDirectoryUserChanges(bound, externalId, input);
    return { id: bound.id, created: false };
  }

  // `findUserByNormalizedEmail` matches case variants, `+` aliases, and legacy
  // rows whose `normalized_email` is null, so it resolves the mailbox rather
  // than one spelling of it.
  const existing = await findUserByNormalizedEmail(input.email);

  // Domain capture establishes the enterprise's claim to the address, so the
  // gate runs before any binding: refusing it on the takeover path alone would
  // let the same uncaptured address mint a new account instead. An address
  // change cannot reach this point with an unbound account — it went through
  // `applyDirectoryUserChanges` or this gate on its first bind.
  //
  // It runs first among the address rules, before the rebind refusal below, as
  // it already did: the domain assertion is the requirement every address must
  // meet, so it answers before any rule that is scoped to one address.
  await assertDirectoryOwnsEmailDomain(input.directoryId, input.email);

  if (existing) {
    // One account, one directory user. Overwriting would silently drop the
    // first binding, and events for that identifier would then resolve to no
    // user — which the removal routes now report as converged, so it would fail
    // silently rather than conflict.
    if (existing.external_id !== null && existing.external_id !== externalId) {
      throw new DirectorySyncConflictError(
        `A Kilo account for this address is already bound to directory user ${existing.external_id}`
      );
    }
  }

  const displayName = [input.firstName, input.lastName].filter(Boolean).join(' ').trim();

  // The address is the one the gate resolved, in the spelling the row stores.
  // `createOrUpdateUser` links an existing account only on an exact
  // `google_user_email` match, so passing the event's spelling of a case
  // variant or alias would miss the row, fall through to the insert, and either
  // be rejected by the normalized-email dedup or create a second account for
  // the same mailbox.
  const settlementEmail = existing?.google_user_email ?? input.email;

  const result = await createOrUpdateUser(
    {
      google_user_email: settlementEmail,
      google_user_name: displayName === '' ? settlementEmail : displayName,
      google_user_image_url: '',
      hosted_domain: null,
      // Keyed on the WorkOS directory user id, never on `idp_id`.
      //
      // `createOrUpdateUser` resolves an account by `(provider,
      // provider_account_id)` before it looks at the address, so the key has to
      // be unique per person. `idp_id` is assigned by the customer's identity
      // provider and is short and numeric in WorkOS's own examples, so two
      // directories can deliver the same one: keying on it made a second
      // directory user resolve to the first person's account and silently take
      // their `external_id`, before the domain gate or the rebind refusal could
      // run. The directory user id is WorkOS-scoped and is the identifier this
      // route is already keyed on.
      //
      // It is not the id interactive SSO stores either — that is the WorkOS
      // profile id (`prof_…`) from `account.providerAccountId`. Neither is, so
      // this row cannot be the one a sign-in matches. It does not need to be:
      // a verified SSO callback passes `autoLinkToExistingUser`, matches the
      // account by address, and replaces this row with the `prof_…` one
      // (`user/index.ts:571-574`, "WorkOS profile IDs can change when an
      // organization's SSO connection is recreated").
      provider: 'workos',
      provider_account_id: externalId,
    },
    undefined,
    // The directory asserted this identity, which is the proof that authorizes
    // linking the address to its WorkOS account.
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // No end user and no client IP: Bouncer admission cannot run here and does
    // not apply. The caller is authenticated with `INTERNAL_API_SECRET` and the
    // directory was connected by an administrator.
    { skipSignupAdmission: true }
  );

  if (!result.success) {
    throw new DirectorySyncConflictError(`Could not provision directory user: ${result.error}`);
  }

  await db
    .update(kilocode_users)
    .set({ external_id: externalId })
    .where(eq(kilocode_users.id, result.user.id));

  return { id: result.user.id, created: result.isNew };
}

/**
 * Applies a `dsync.user.updated` to an already-bound account.
 *
 * Without this the route is a no-op that reports success: a renamed or
 * re-addressed directory user keeps the attributes it was provisioned with,
 * and a stale address desynchronizes the address-based matching that SSO
 * sign-in and the takeover gate both rely on.
 *
 * An address change is a takeover in its own right — it moves the account onto
 * a new mailbox — so it carries the same protections as a first bind:
 *
 * - the organization must have captured the new domain, and no other account
 *   may already hold the address;
 * - `web_session_pepper` is rotated, because the sessions issued before the
 *   move were issued to the previous holder of that mailbox. An identity
 *   provider that recycles an address to a different person would otherwise
 *   leave the previous holder authenticated against the moved account
 *   (`isWebSessionCurrent` compares exactly this column);
 * - `user_auth_provider.email` is moved too. It is a separate source for
 *   address lookups — `getEmailAccountCandidates` matches on it — so leaving it
 *   behind keeps the old address resolving to this account.
 *
 * `normalized_email` is written because `findUserByNormalizedEmail` and the
 * signup dedup read it rather than `google_user_email`, and `email_domain`
 * through `extractEmailDomain`, which is the registrable domain the insert path
 * stores — the full host would skew the abuse grouping that reads the column.
 */
async function applyDirectoryUserChanges(
  bound: { id: string; email: string; name: string | null },
  externalId: string,
  input: DirectoryUserUpsert
): Promise<void> {
  const displayName = [input.firstName, input.lastName].filter(Boolean).join(' ').trim();
  const changes: Partial<typeof kilocode_users.$inferInsert> = {};
  let movedMailbox = false;

  if (displayName !== '' && displayName !== bound.name) {
    changes.google_user_name = displayName;
  }

  // Case-insensitive: the stored spelling is authoritative, so a change that
  // only differs in case is not a move to a different mailbox.
  if (input.email.toLowerCase() !== bound.email.toLowerCase()) {
    await assertDirectoryOwnsEmailDomain(input.directoryId, input.email);

    const holder = await findUserByNormalizedEmail(input.email);
    if (holder && holder.id !== bound.id) {
      throw new DirectorySyncConflictError(
        `Cannot move directory user ${externalId} to an address another Kilo account already holds`
      );
    }

    movedMailbox = true;
    changes.google_user_email = input.email;
    changes.normalized_email = normalizeEmail(input.email);
    changes.email_domain = extractEmailDomain(input.email);
    changes.web_session_pepper = randomUUID();
  }

  if (Object.keys(changes).length === 0) return;

  await db.transaction(async tx => {
    await tx.update(kilocode_users).set(changes).where(eq(kilocode_users.id, bound.id));

    if (movedMailbox) {
      await tx
        .update(user_auth_provider)
        .set({ email: input.email })
        .where(
          and(
            eq(user_auth_provider.kilo_user_id, bound.id),
            eq(user_auth_provider.provider, 'workos')
          )
        );
    }
  });
}

/**
 * Refuses unless the directory's organization has captured the address's
 * domain. Domain capture is what authorizes binding the address at all: the
 * gate runs whether the address matches a pre-existing account or would create
 * a new one, so a directory can neither take over nor mint an account at a
 * domain it does not own. The refusal names that domain, never the address.
 *
 * The policy is read from the directory's organization rather than the
 * address: resolving an authority from the domain alone would let any
 * organization that captured a domain take over addresses belonging to a
 * different organization's directory. A misconfigured policy — ambiguous
 * domain, or a child carrying its own — fails closed, under Policy Resolution
 * rule 7.
 */
async function assertDirectoryOwnsEmailDomain(directoryId: string, email: string): Promise<void> {
  const refuse = (reason: string): never => {
    // The refused bind is the auditable event: it names a directory pushing an
    // address its organization never proved it owns.
    console.warn('[scim] Refused a directory address bind', {
      directoryId,
      emailDomain: getLowerDomainFromEmail(email),
      reason,
    });
    // The domain, not the address: this message is returned in the 409 body and
    // logged again by `directorySyncErrorResponse`, and the directory id plus
    // the reason are what an operator acts on.
    throw new DirectorySyncConflictError(
      `Directory ${directoryId} has not captured the domain ${getLowerDomainFromEmail(email)}: ${reason}`
    );
  };

  const ownerRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(directoryOwner(directoryId))
    .limit(1);

  const owner = ownerRows.at(0);
  if (!owner) {
    return refuse(`no live organization is bound to directory ${directoryId}`);
  }

  const policy = await resolveEffectiveOrganizationSsoPolicy(owner.id);
  if (policy.status !== 'required') {
    return refuse(
      policy.status === 'misconfigured'
        ? `the organization's SSO policy is misconfigured (${policy.reason})`
        : 'the organization has no SSO domain, so it has captured nothing'
    );
  }

  const emailDomain = getLowerDomainFromEmail(email);
  if (emailDomain !== policy.domain) {
    return refuse(`the organization's captured domain is ${policy.domain}`);
  }
}

/**
 * Add a directory user to the sub-organization its group maps to, and to that
 * sub-organization's parent.
 *
 * Membership in the parent is what grants access to the directory's
 * organization at all; the sub-organization membership is the group itself.
 *
 * A removal tombstone is cleared rather than respected. For a
 * directory-managed organization the identity provider is authoritative, so an
 * earlier Kilo-side removal does not outlive the directory's view. The result
 * reports when this happened, because it reverses a deliberate action.
 */
export async function addDirectoryMembership(
  input: DirectoryMembership
): Promise<DirectoryMembershipResult> {
  const groupRows = await db
    .select({ id: organizations.id, parent: organizations.parent_organization_id })
    .from(organizations)
    .where(and(eq(organizations.directory_group_id, input.directoryGroupId), liveOrganization))
    .limit(1);

  const group = groupRows.at(0);
  if (!group) {
    throw new DirectorySyncConflictError(
      `No live sub-organization is bound to directory group ${input.directoryGroupId}`
    );
  }

  const userRows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.external_id, input.externalId))
    .limit(1);

  const user = userRows.at(0);
  if (!user) {
    throw new DirectorySyncConflictError(`No user is bound to directory user ${input.externalId}`);
  }

  const targets = group.parent === null ? [group.id] : [group.parent, group.id];

  const cleared = await db
    .delete(organization_membership_removals)
    .where(
      and(
        inArray(organization_membership_removals.organization_id, targets),
        eq(organization_membership_removals.kilo_user_id, user.id)
      )
    );

  let created = false;
  for (const organizationId of targets) {
    const added = await addUserToOrganization(organizationId, user.id, 'member');
    created = created || added;
  }

  return {
    organizationId: group.id,
    parentOrganizationId: group.parent,
    kiloUserId: user.id,
    created,
    clearedRemovalTombstone: (cleared.rowCount ?? 0) > 0,
  };
}

/**
 * Remove a directory user from the sub-organization its group maps to, and from
 * its parent once no directory group under that parent remains.
 *
 * Leaving one of several groups keeps the parent membership: the user may
 * belong to sibling groups, and the parent is what grants access to the
 * enterprise at all. Leaving the *last* one does not. Group membership is the
 * identity provider's statement that the user belongs to the enterprise, so
 * once the identity provider makes no such statement the enterprise membership
 * goes too — otherwise a user removed from every group, or deleted from the
 * directory entirely, keeps access to the organization's seats and data.
 *
 * The parent revocation applies only to a directory-provisioned account, one
 * carrying an `external_id`. A membership an administrator created, or one
 * ordinary SSO sign-in provisioned, is not the directory's to revoke.
 *
 * Converges rather than conflicting. An unknown group or user means there is no
 * membership to revoke, which is the state the event asks for, so it reports
 * `removed: false` instead of throwing. The alternative would be provisioning
 * the group and user first — which creates a Kilo account for a user who is
 * leaving the directory — or holding the Worker's cursor on a 409 waiting for
 * an add that may never arrive.
 *
 * `removeUserFromOrganization` hard-deletes the membership and writes the
 * tombstone, which is the repo's removal protocol, and also cascades away the
 * user's model-access group assignments in that organization.
 */
export async function removeDirectoryMembership(
  input: DirectoryMembership
): Promise<DirectoryMembershipRemovalResult> {
  const groupRows = await db
    .select({ id: organizations.id, parent: organizations.parent_organization_id })
    .from(organizations)
    .where(and(eq(organizations.directory_group_id, input.directoryGroupId), liveOrganization))
    .limit(1);

  const group = groupRows.at(0);
  if (!group) {
    return {
      organizationId: null,
      parentOrganizationId: null,
      kiloUserId: null,
      removed: false,
      revokedParentMembership: false,
    };
  }

  const userRows = await db
    .select({ id: kilocode_users.id, externalId: kilocode_users.external_id })
    .from(kilocode_users)
    .where(eq(kilocode_users.external_id, input.externalId))
    .limit(1);

  const user = userRows.at(0);
  if (!user) {
    return {
      organizationId: group.id,
      parentOrganizationId: group.parent,
      kiloUserId: null,
      removed: false,
      revokedParentMembership: false,
    };
  }

  // `removedBy` is left undefined: the actor is the identity provider, and the
  // column holds a Kilo user id, so there is no honest value. The helper falls
  // back to the removed user's own id for the group-policy revision bump, and
  // the tombstone records `removed_by` as null — which is what "not removed by
  // a Kilo user" should look like.
  const { rowCount } = await removeUserFromOrganization(group.id, user.id);

  const revokedParentMembership =
    group.parent === null ? false : await revokeParentWhenLastGroupLeft(group.parent, user.id);

  return {
    organizationId: group.id,
    parentOrganizationId: group.parent,
    kiloUserId: user.id,
    // A replayed removal finds no membership and reports no change, which is
    // what makes the route idempotent.
    removed: (rowCount ?? 0) > 0,
    revokedParentMembership,
  };
}

/**
 * Removes the parent membership when the user holds no remaining directory
 * group under it.
 *
 * Only directory groups count. A sub-organization the customer created under
 * the same parent is not the identity provider's statement about enterprise
 * membership, so a membership there does not keep the parent access alive.
 *
 * Idempotent: with the membership already gone `removeUserFromOrganization`
 * reports no rows and this answers false.
 */
async function revokeParentWhenLastGroupLeft(
  parentOrganizationId: string,
  kiloUserId: string
): Promise<boolean> {
  const remaining = await db
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .where(
      and(
        eq(organizations.parent_organization_id, parentOrganizationId),
        isNotNull(organizations.directory_group_id),
        liveOrganization,
        eq(organization_memberships.kilo_user_id, kiloUserId)
      )
    )
    .limit(1);

  if (remaining.length > 0) return false;

  const { rowCount } = await removeUserFromOrganization(parentOrganizationId, kiloUserId);
  return (rowCount ?? 0) > 0;
}

/**
 * Soft-delete the organization bound to a directory, and the directory group
 * organizations under it.
 *
 * The match is restricted to the unparented row, through `directoryOwner`: a
 * sub-organization carries its parent's `directory_id` too, so matching on that
 * column alone could soft-delete a group while leaving the organization live.
 *
 * Only children carrying a `directory_group_id` go with it. A sub-organization
 * a customer created under the same parent is not a directory group and is left
 * intact: `markOrganizationAsDeleted` hard-deletes that organization's
 * `cloud_agent_environments` and `provider_oauth_attempts` rows, so including
 * one here would destroy data no reconnect could restore.
 *
 * Such a child stays parented to the soft-deleted organization, which resolves
 * `misconfigured` with reason `deleted_parent` and therefore fails closed for
 * authentication and membership admission (Policy Resolution rule 7). Detaching
 * it would be worse: the parent's `sso_domain` is the only thing forcing its
 * members through SSO, so a standalone child would silently accept magic-link
 * sign-ins. It is logged instead, because nothing else would tell an operator
 * the disconnect stranded it.
 *
 * Parent and groups are stamped in one transaction, so a failure part-way
 * leaves the organization live and the whole event retryable. Committing the
 * parent first would make the retry find no live unparented row, return
 * `deleted: false`, and never reach the remaining groups — whose `directory_id`
 * keeps matching group events.
 */
export async function deleteDirectoryOrganization(
  directoryId: string
): Promise<DirectorySyncDeleteResult> {
  return db.transaction(async tx => {
    const ownerRows = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(directoryOwner(directoryId), liveOrganization))
      .limit(1);

    const owner = ownerRows.at(0);
    // No live row is the idempotent repeat: a replayed deletion is a no-op.
    if (!owner) {
      return { id: '', deleted: false };
    }

    const children = await tx
      .select({
        id: organizations.id,
        directoryGroupId: organizations.directory_group_id,
      })
      .from(organizations)
      .where(and(eq(organizations.parent_organization_id, owner.id), liveOrganization));

    const groups = children.filter(child => child.directoryGroupId !== null);
    const stranded = children.filter(child => child.directoryGroupId === null);

    for (const group of groups) {
      await markOrganizationAsDeleted(group.id, tx);
    }
    await markOrganizationAsDeleted(owner.id, tx);

    if (stranded.length > 0) {
      // Left live on purpose, and invisible otherwise.
      console.warn('[scim] Directory disconnect stranded customer-created sub-organizations', {
        directoryId,
        organizationId: owner.id,
        strandedOrganizationIds: stranded.map(child => child.id),
        effect: 'they resolve deleted_parent and fail closed until an administrator reparents them',
      });
    }

    return { id: owner.id, deleted: true };
  });
}

/** Soft-delete the sub-organization bound to a directory group. */
export async function deleteDirectorySubOrganization(
  directoryGroupId: string
): Promise<DirectorySyncDeleteResult> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.directory_group_id, directoryGroupId), liveOrganization))
    .limit(1);

  const target = rows.at(0);
  // No live row is the idempotent repeat: a replayed deletion is a no-op.
  if (!target) {
    return { id: '', deleted: false };
  }

  await markOrganizationAsDeleted(target.id);
  return { id: target.id, deleted: true };
}
