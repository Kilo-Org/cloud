# Organization SSO Enforcement

## Role of This Document

This spec defines the security and membership rules for organization SSO, including direct parent-to-child policy inheritance. It is the source of truth for required authentication, invitation behavior, membership admission, and removal semantics.

## Status

Active.

- Added 2026-06-23 for parent organization SSO enforcement.
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
3. Invitation creation and acceptance MUST resolve the current Effective SSO policy on the server.
4. A policy change after invitation creation MUST be enforced during acceptance. A legacy ordinary invitation MUST NOT bypass newly active SSO.
5. Client-side invitation checks are advisory and MUST NOT replace server enforcement.

### Membership Admission

1. Successful SSO authentication MUST NOT automatically grant membership in every SSO child organization.
2. Parent membership MUST NOT grant child membership, and child membership MUST NOT grant parent or sibling membership.
3. Ordinary SSO JIT provisioning MAY add a user only to the SSO authority organization.
4. Ordinary SSO JIT provisioning MUST NOT restore a membership when a Removal tombstone exists. Directory sync is the sole exception, under Directory Sync rule 5.
5. A platform administrator MAY restore or add a Same-domain user only through an explicit audited action after verifying a matching WorkOS identity.
6. Bot users are exempt from human SSO requirements and MUST be admitted only through explicit bot/service-account paths.

### Directory Sync

1. Directory sync MUST apply only to a Directory-managed organization, and MUST resolve that organization from the event's directory rather than from the authenticated caller.
2. A Directory group organization MUST be a direct child of the Directory-managed organization that owns its directory. A group whose directory resolves to an organization that is itself parented MUST be rejected, because SSO inheritance is not transitive.
3. Directory sync MUST add a Directory user to both the Directory group organization and that organization's direct parent. Group membership is the identity provider's statement that the user belongs to the enterprise, which the parent represents.
4. Removing a Directory user from a directory group MUST remove only the Directory group organization membership. A user may belong to sibling groups under the same parent, so leaving one group MUST NOT revoke the parent membership.
5. Directory sync MUST clear a Removal tombstone when the identity provider asserts the membership. For a Directory-managed organization the identity provider is authoritative, so a Kilo-side removal MUST NOT outlive the directory's view. This is a deliberate exception to Membership Admission rule 4, which continues to bind Ordinary SSO JIT provisioning: a tombstone still blocks an interactive sign-in from silently restoring a membership.
6. Directory sync MUST be idempotent per event. Every write MUST be keyed on a WorkOS identifier so that a replayed event is a no-op, because the Worker commits its cursor per event and a crash mid-page replays the last one.
7. Directory sync MUST NOT advance its cursor past an event it could not apply. An event whose dependency is missing MUST be retried rather than dropped.
8. Directory sync MUST authenticate to the application with the shared internal API secret, and its endpoints MUST NOT be reachable without it.
9. Directory provisioning of a Directory user MAY bypass signup admission, which exists to rate-limit self-service signup abuse and cannot apply to a machine-initiated request that has no end user or client IP. Every other account-creation protection — email deduplication, the deletion fence, and billing-customer provisioning with its compensating delete — MUST still apply, and each bypass MUST be audited.
10. Directory sync MUST NOT delete a Kilo user account. A Directory user leaving a directory MUST remove memberships only; account deletion is a separate, explicitly requested operation.
11. A directory disconnect MUST soft-delete the affected Directory group organizations and MUST release their directory bindings, so a later reconnect binds cleanly rather than colliding.
12. Directory sync MUST NOT create a Kilo user or organization in order to apply a removal. A removal whose Directory group organization or Directory user does not exist has no membership to revoke, which is the state the event asserts, so it MUST converge and report that nothing was removed rather than count as a missing dependency under rule 7. Provisioning a departing user's account, or holding the cursor for an addition that may never arrive, are both worse than the single consequence this accepts: with no membership there is no Removal tombstone, so a removal that overtakes its own addition lets the late addition win. Addition before removal is the normal order and the event stream is consumed serially, so that reordering is rare.
13. Directory sync MAY take over a pre-existing Kilo account holding a Directory user's address only when that address's normalized domain equals the Effective SSO policy domain of the Directory-managed organization that owns the event's directory. Domain capture is what establishes the enterprise's claim to the address, and the identity provider has asserted that this person holds it. Taking over MUST convert the account to the SSO authority's WorkOS identity, MUST leave no non-WorkOS authentication provider on it, and MUST invalidate its existing browser sessions under Authentication rule 7, so the prior holder retains neither a login that bypasses SSO nor a live session. It MUST NOT create a second account for the same address, and MUST NOT transfer anything the prior holder owned beyond the account itself. Every other address MUST be refused rather than taken over or silently absorbed, including when the organization has captured no domain or its policy is misconfigured, which fails closed under Policy Resolution rule 7. A refusal MUST be audited, because it means a directory asserted an address its organization never proved it owns.
14. Directory sync MAY record a domain carried by a directory activation event as the Directory-managed organization's SSO domain. Directory intake is administratively gated, so a domain on the event has already passed a human reviewer, which is the same authority a manual capture carries. It MUST NOT claim a domain another live organization already holds, because two authorities claiming one domain fails closed for both under Policy Resolution rule 6; such a domain MUST be left unclaimed rather than overwritten. An event that carries no domain MUST leave an existing SSO domain intact — releasing one stays a deliberate administrative action. Recording a domain MUST be audited under the same action a manual capture writes, with no actor, because no human performed this particular write.

### Isolation

1. Parent and child organizations MUST retain independent owners, roles, and data.
2. A child owner MUST NOT gain access to the parent's WorkOS configuration or administrative controls.
3. The API MAY expose a read-only Effective SSO policy to child members for user-interface behavior.

### Policy Transitions

1. Enabling SSO or attaching a child to an SSO authority MUST NOT eagerly invalidate affected Same-domain users' existing browser sessions or API tokens solely through credential-pepper rotation; SSO requirements MUST instead be enforced at authentication and authorization boundaries.
2. Pending authentication artifacts that could mint credentials after the transition SHOULD be expired.
3. Existing Same-domain ordinary invitations MUST NOT remain usable after the transition.
4. Policy transitions, configuration failures, denied membership admissions, and administrative overrides MUST be audited without recording tokens, cookies, credentials, or authentication headers.
