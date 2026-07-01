# Organization SSO Enforcement

## Role of This Document

This spec defines the security and membership rules for organization SSO, including direct parent-to-child policy inheritance. It is the source of truth for required authentication, invitation behavior, membership admission, and removal semantics.

## Status

Active.

- Added 2026-06-23 for parent organization SSO enforcement.

## Definitions

- **SSO authority**: The organization whose active SSO domain and WorkOS configuration authenticate users.
- **Direct SSO organization**: An organization that owns an SSO authority through its own `sso_domain`.
- **SSO child organization**: An organization whose direct parent is a Direct SSO organization and which therefore inherits the parent's SSO policy.
- **Effective SSO policy**: The SSO requirement that applies to an organization, sourced either from itself or its direct parent.
- **Same-domain user**: A human user whose normalized primary email domain equals the Effective SSO policy domain.
- **External user**: A human user whose normalized primary email domain does not equal the Effective SSO policy domain.
- **Bot user**: A system or service account with `is_bot = true`.
- **Removal tombstone**: A durable `organization_membership_removals` record showing that a user was explicitly removed from an organization.

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
4. Ordinary SSO JIT provisioning MUST NOT restore a membership when a Removal tombstone exists.
5. A platform administrator MAY restore or add a Same-domain user only through an explicit audited action after verifying a matching WorkOS identity.
6. Bot users are exempt from human SSO requirements and MUST be admitted only through explicit bot/service-account paths.

### Isolation

1. Parent and child organizations MUST retain independent owners, roles, and data.
2. A child owner MUST NOT gain access to the parent's WorkOS configuration or administrative controls.
3. The API MAY expose a read-only Effective SSO policy to child members for user-interface behavior.

### Policy Transitions

1. Enabling SSO or attaching a child to an SSO authority MUST NOT eagerly invalidate affected Same-domain users' existing browser sessions or API tokens solely through credential-pepper rotation; SSO requirements MUST instead be enforced at authentication and authorization boundaries.
2. Pending authentication artifacts that could mint credentials after the transition SHOULD be expired.
3. Existing Same-domain ordinary invitations MUST NOT remain usable after the transition.
4. Policy transitions, configuration failures, denied membership admissions, and administrative overrides MUST be audited without recording tokens, cookies, credentials, or authentication headers.
