# Organization SSO Enforcement

## Role of This Document

This spec defines the security and membership rules for organization SSO, including direct parent-to-child policy inheritance. It is the source of truth for required authentication, invitation behavior, membership admission, and removal semantics.

## Status

Active.

- Added 2026-06-23 for parent organization SSO enforcement.
- Updated for explicitly authorized, WorkOS-required invitations to join or restore membership.
- Amended 2026-11-04 for WorkOS Directory Sync (SCIM) provisioning.

## Definitions

- **SSO authority**: The organization whose active SSO domain and WorkOS configuration authenticate users.
- **Direct SSO organization**: An organization that owns an SSO authority through its own `sso_domain`.
- **SSO child organization**: An organization whose direct parent is a Direct SSO organization and which therefore inherits the parent's SSO policy.
- **Effective SSO policy**: The SSO requirement that applies to an organization, sourced either from itself or its direct parent.
- **Same-domain user**: A human user whose normalized primary email domain equals the Effective SSO policy domain.
- **External user**: A human user whose normalized primary email domain does not equal the Effective SSO policy domain.
- **Bot user**: A system or service account with `is_bot = true`.
- **Removal tombstone**: A durable `organization_membership_removals` record showing that a user was explicitly removed from an organization.
- **Directory-managed organization**: An organization bound to a WorkOS directory through `organizations.directory_id`.
- **Directory group organization**: An SSO child organization bound to a WorkOS directory group through `organizations.directory_group_id`.
- **Directory user**: A human user bound to a WorkOS directory user through `kilocode_users.external_id`.
- **Directory sync**: The `scim-sync` Worker's replay of the WorkOS Events API into Kilo state. It is a distinct mechanism from Ordinary SSO JIT provisioning, which happens during an interactive sign-in.

## Rules

### Policy Resolution

1. A Direct SSO organization's Effective SSO policy MUST be its own active SSO authority.
2. An SSO child organization's Effective SSO policy MUST be its direct parent's own active SSO authority.
3. SSO inheritance MUST NOT be transitive. An organization whose parent is itself parented is misconfigured.
4. An SSO child organization MUST NOT own a separate SSO domain.
5. A soft-deleted or missing parent MUST NOT provide an Effective SSO policy.
6. Multiple independent SSO authorities MUST NOT claim the same normalized domain.
7. Invalid, conflicting, deleted, nested, or ambiguous SSO configuration MUST fail closed for authentication and human membership admission.
8. Effective SSO policy resolution MUST use current database state at the authorization boundary and MUST NOT rely on mutable process-local caches.

### Authentication

1. A Same-domain user MUST authenticate through the SSO authority's WorkOS organization.
2. A Same-domain user MUST NOT establish a new session through magic link or a non-WorkOS OAuth provider.
3. Magic-link requests for Same-domain users MUST be rejected before a token is persisted or an email is sent.
4. The final authentication callback MUST independently enforce SSO even when discovery or UI routing was bypassed.
5. Authentication discovery errors and disagreement between local policy and WorkOS MUST NOT fall back to ordinary signup.
6. Development fake login MAY bypass SSO only when the existing non-production fake-login feature is enabled.
7. Converting an existing user to WorkOS MUST invalidate their existing browser sessions and MUST NOT eagerly invalidate their API tokens solely through credential-pepper rotation.

### Invitations

1. An External user MAY receive and accept an ordinary organization invitation.
2. A Same-domain user MUST NOT receive or accept an ordinary invitation to a Direct SSO organization or SSO child organization.
3. An authorized organization owner or other actor with permission to invite members MAY explicitly invite a Same-domain user to join or restore membership in the target Direct SSO organization or SSO child organization. This invitation MUST require WorkOS authentication and be bound to the Effective SSO policy's authority; it is not an ordinary invitation.
4. Invitation creation and acceptance MUST resolve the current Effective SSO policy on the server. Acceptance of a WorkOS-required invitation MUST require a matching invitee email and authentication through the currently effective WorkOS authority. If the policy is no longer required, its authority has changed, or its domain no longer matches, acceptance MUST fail closed.
5. A policy change after invitation creation MUST be enforced during acceptance. A legacy ordinary invitation MUST NOT bypass newly active SSO.
6. A child organization invitation MUST require the invitee to be a current human member of its live parent both when the invitation is created and when it is accepted. A pending parent invitation is not parent membership.
7. An invitation MUST NOT restore membership if it was created at or before the target organization's latest Removal tombstone. A newer, explicitly authorized invitation MAY restore membership only upon valid acceptance; creating or sending it MUST NOT clear the tombstone or grant membership. Successful restoration MUST clear the target organization's tombstone without changing tombstones or membership in other organizations.
8. Successful WorkOS-required invitation creation and membership admission, including restoration, MUST be audited as explicit actions identifying the actor, target organization, and invitee, without recording tokens, cookies, credentials, or authentication headers.
9. Client-side invitation checks are advisory and MUST NOT replace server enforcement.

### Membership Admission

1. Successful SSO authentication MUST NOT automatically grant membership in every SSO child organization.
2. Parent membership MUST NOT grant child membership, and child membership MUST NOT grant parent or sibling membership.
3. Ordinary SSO JIT provisioning MAY add a user only to the SSO authority organization.
4. Ordinary SSO JIT provisioning MUST NOT restore a membership when a Removal tombstone exists. Directory sync is the sole exception, under Directory Sync rule 5.
5. A platform administrator MAY restore or add a Same-domain user through an explicit audited action after verifying a matching WorkOS identity. An authorized invitation MAY instead add or restore that user under the WorkOS-required invitation rules above.
6. Bot users are exempt from human SSO requirements and MUST be admitted only through explicit bot/service-account paths.

### Directory Sync

1. Directory sync MUST apply only to a Directory-managed organization, and MUST resolve that organization from the event's directory rather than from the authenticated caller.
2. A Directory group organization MUST be a direct child of the Directory-managed organization that owns its directory. A group whose directory resolves to an organization that is itself parented MUST be rejected, because SSO inheritance is not transitive.
3. Directory sync MUST add a Directory user to both the Directory group organization and that organization's direct parent. Group membership is the identity provider's statement that the user belongs to the enterprise, which the parent represents.
4. Removing a Directory user from a directory group MUST remove the Directory group organization membership, and MUST also remove the parent membership once the user holds no other Directory group organization under that parent. A user may belong to sibling groups, so leaving one group while others remain MUST NOT revoke the parent membership; leaving the last one MUST, because group membership is the identity provider's statement that the user belongs to the enterprise and the enterprise membership MUST NOT outlive it. Otherwise a user removed from every group, or deleted from the directory, retains access to the organization. Only Directory group organizations count toward that test: a membership in a sub-organization with no directory group binding is not the identity provider's statement. The parent removal MUST apply only to a Directory user, because a membership an administrator or Ordinary SSO JIT provisioning created is not directory sync's to revoke.
5. Directory sync MUST clear a Removal tombstone when the identity provider asserts the membership. For a Directory-managed organization the identity provider is authoritative, so a Kilo-side removal MUST NOT outlive the directory's view. This is a deliberate exception to Membership Admission rule 4, which continues to bind Ordinary SSO JIT provisioning: a tombstone still blocks an interactive sign-in from silently restoring a membership.
6. Directory sync MUST be idempotent per event. Every write MUST be keyed on a WorkOS identifier so that a replayed event is a no-op, because the Worker commits its cursor per event and a crash mid-page replays the last one.
7. Directory sync MUST NOT advance its cursor past an event it could not apply. An event whose dependency is missing MUST be retried rather than dropped.
8. Directory sync MUST authenticate to the application with the shared internal API secret, and its endpoints MUST NOT be reachable without it.
9. Directory provisioning of a Directory user MAY bypass signup admission, which exists to rate-limit self-service signup abuse and cannot apply to a machine-initiated request that has no end user or client IP. Every other account-creation protection — email deduplication, the deletion fence, and billing-customer provisioning with its compensating delete — MUST still apply, and each bypass MUST be audited.
10. Directory sync MUST NOT delete a Kilo user account. A Directory user leaving a directory MUST remove memberships only; account deletion is a separate, explicitly requested operation.
11. A directory disconnect MUST soft-delete the Directory-managed organization and the Directory group organizations under it, in one atomic operation, and MUST release their directory bindings so a later reconnect binds cleanly rather than colliding. It MUST NOT soft-delete a sub-organization that carries no directory group binding: such an organization belongs to the customer, not to the directory, and soft-deleting one irreversibly destroys associated records that releasing the binding cannot restore. Such an organization MUST be left intact and parented, where it resolves as misconfigured and fails closed under Policy Resolution rule 7; detaching it would leave it with no Effective SSO policy and silently admit non-SSO sign-ins for its Same-domain members. Stranding one MUST be surfaced, because no other signal distinguishes it from a healthy organization.
12. Directory sync MUST NOT create a Kilo user or organization in order to apply a removal. A removal whose Directory group organization or Directory user does not exist has no membership to revoke, which is the state the event asserts, so it MUST converge and report that nothing was removed rather than count as a missing dependency under rule 7. Provisioning a departing user's account, or holding the cursor for an addition that may never arrive, are both worse than the single consequence this accepts: with no membership there is no Removal tombstone, so a removal that overtakes its own addition lets the late addition win. Addition before removal is the normal order and the event stream is consumed serially, so that reordering is rare.
13. Directory sync MAY take over a pre-existing Kilo account holding a Directory user's address only when that address's normalized domain equals the Effective SSO policy domain of the Directory-managed organization that owns the event's directory. Domain capture is what establishes the enterprise's claim to the address, and the identity provider has asserted that this person holds it. Taking over MUST convert the account to the SSO authority's WorkOS identity, MUST leave no non-WorkOS authentication provider on it, and MUST invalidate its existing browser sessions under Authentication rule 7, so the prior holder retains neither a login that bypasses SSO nor a live session. It MUST NOT create a second account for the same address, and MUST NOT transfer anything the prior holder owned beyond the account itself. Addresses MUST be resolved by the same match throughout: an account identified for takeover MUST be the account converted, so a difference in letter case or an address alias can neither refuse a legitimate takeover nor produce a second account for one mailbox. Every other address MUST be refused rather than taken over or silently absorbed, including when the organization has captured no domain or its policy is misconfigured, which fails closed under Policy Resolution rule 7. Provisioning a new account carries the same requirement: an address whose normalized domain is not the Effective SSO policy domain MUST be refused rather than bound, so the directory cannot mint accounts outside the domain it proved it owns. A refusal MUST be audited and MUST NOT disclose the address, which is reportable by domain alone.
14. Directory sync MAY record a domain carried by a directory activation event as the Directory-managed organization's SSO domain, and only when that organization has none. Directory intake is administratively gated, so a domain on the event has already passed a human reviewer, which is the same authority a manual capture carries. It MUST NOT claim a domain another live organization already holds, because two authorities claiming one domain fails closed for both under Policy Resolution rule 6; such a domain MUST be left unclaimed rather than overwritten. It MUST NOT replace a domain the organization already holds: the SSO domain decides who must authenticate through SSO and which addresses a takeover may claim, the event's domain list carries no ordering guarantee, and replacing one is a deliberate administrative action. An event that carries no domain MUST leave an existing SSO domain intact — releasing one is likewise deliberate. Recording a domain MUST be audited under the same action a manual capture writes, with no actor, because no human performed this particular write.
15. A Kilo account MUST be bound to at most one Directory user. Directory sync MUST refuse to rebind an account that already carries a different directory user identifier rather than overwrite it, because the dropped identifier's later events would resolve to no account and, under rule 12, report as converged rather than failing.
16. Directory sync MUST NOT key a Kilo authentication provider record on an identifier the identity provider assigns, such as a directory user's `idp_id`. Account resolution matches an authentication provider record before it compares addresses, and such an identifier is not unique across directories, so keying on one lets a Directory user resolve to a different person's account and bypass both the domain check in rule 13 and the single-binding requirement in rule 15. The record MUST be keyed on a WorkOS-scoped identifier. That record is not the one an interactive SSO sign-in matches, which is the WorkOS profile identifier; a verified sign-in replaces it by address, so directory sync MUST NOT depend on it for authentication.
17. Directory sync MUST apply a Directory user's changed attributes to the account already bound to it. Reporting success without applying them leaves state the identity provider has superseded, and a stale address desynchronizes the address matching that SSO sign-in and rule 13 both depend on. An address change MUST satisfy the same requirements as a first bind: the organization MUST have captured the new address's domain, no other account may already hold it, and the account's existing browser sessions MUST be invalidated under Authentication rule 7 — those sessions were issued to the mailbox's previous holder, and an identity provider may reassign an address to a different person. Every stored projection of the address MUST move with it, including any authentication provider record, so the former address stops resolving to the account.
18. Creating a Directory group organization MUST be safe to retry. The organization row and its directory binding MUST be written atomically, so a failed attempt leaves no unbound organization for a later attempt to miss and duplicate. Where any later step of creation can fail independently, that step MUST NOT be what establishes the binding.

### Isolation

1. Parent and child organizations MUST retain independent owners, roles, and data.
2. A child owner MUST NOT gain access to the parent's WorkOS configuration or administrative controls.
3. The API MAY expose a read-only Effective SSO policy to child members for user-interface behavior.

### Policy Transitions

1. Enabling SSO or attaching a child to an SSO authority MUST NOT eagerly invalidate affected Same-domain users' existing browser sessions or API tokens solely through credential-pepper rotation; SSO requirements MUST instead be enforced at authentication and authorization boundaries.
2. Pending authentication artifacts that could mint credentials after the transition SHOULD be expired.
3. Existing Same-domain ordinary invitations MUST NOT remain usable after the transition.
4. Policy transitions, configuration failures, denied membership admissions, and administrative overrides MUST be audited without recording tokens, cookies, credentials, or authentication headers.
