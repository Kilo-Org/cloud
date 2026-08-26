# Verified Domains and Automatic Organization Membership

## Role of This Document

This product requirements document defines the user-facing behavior and business
rules for verified organization domains and automatic organization membership.
It is the source of truth for what the system guarantees when an organization
proves ownership of an email domain.

This document deliberately does not prescribe implementation details such as
database tables, verification providers, background jobs, or endpoint names.

## Status

Draft -- revised 2026-08-21.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174]
when, and only when, they appear in all capitals.

## Problem

Organizations want people using company-owned email addresses to join the
company organization without requiring invitations or SSO. Today this behavior
is tied to SSO configuration, so organizations that use ordinary authentication
cannot establish the same automatic onboarding rule.

## Product Principle

A verified domain grants an organization the right to automatically add matching
users as members. It does not grant ownership of those users' identities,
personal resources, billing, or memberships in other organizations.

## Goals

1. Allow an organization to prove ownership of a company email domain independently of SSO.
2. Automatically add matching human users to the organization when they authenticate.
3. Make the organization the default destination for users added through its verified domain.
4. Apply the same automatic-membership behavior whether users authenticate through SSO, social login, or email authentication.
5. Make domain ownership and automatic membership auditable.

## Non-Goals

1. This project does not define SSO setup, identity-provider configuration, or SSO protocol behavior.
2. Domain verification does not transfer ownership or control of a user's identity to an organization.
3. Domain verification does not disable personal workspaces or prevent users from creating or participating in other organizations.
4. Domain verification does not transfer, freeze, or otherwise modify personal data, balances, subscriptions, integrations, credentials, or resources.
5. Domain verification does not transfer, merge, close, or otherwise modify organizations a matching user already owns or controls.
6. This project does not provide managed accounts, enterprise identity takeover, or legacy-account conversion.
7. This project does not automatically add users to parent, child, or sibling organizations.

## Definitions

- **Domain claim**: An organization's request to prove ownership of an email domain.
- **Verified domain**: A normalized domain for which the system has trusted proof that an organization controls the domain.
- **Matching user**: A human user whose normalized primary email domain exactly matches a verified domain.
- **Automatic membership**: Ordinary organization membership created from a verified-domain match rather than an invitation.
- **Removal tombstone**: A durable record showing that a user was explicitly removed from an organization and MUST NOT be automatically re-added.

## Primary User Experience

### Organization Administrator

1. An authorized organization administrator enters a company domain.
2. The system provides a supported verification process.
3. The administrator proves control of the domain.
4. The system displays the domain as verified and explains that matching users will automatically join the organization.
5. The administrator may remove the verified domain to stop future automatic memberships.

### Matching User

1. The user authenticates through an otherwise-supported authentication method.
2. If Organization SSO Enforcement requires SSO for the user, the user must satisfy that policy.
3. The system ensures that the user is an ordinary member of the organization that owns the matching verified domain.
4. The user lands in that organization by default.
5. The user's personal account, resources, billing, and other organization memberships remain unchanged.

## Requirements

### Eligibility and Administration

1. An eligible organization MUST be able to submit a domain claim regardless of whether it uses SSO.
2. Only an authorized organization administrator MUST be able to create, verify, retry, or remove a domain claim.
3. A domain claim MUST NOT affect users until verification succeeds.
4. The administrator experience MUST distinguish pending claims from verified domains.
5. Verification errors SHOULD be presented as actionable operation errors and need not be durable domain lifecycle states.

### Domain Verification and Ownership

1. The system MUST require trusted proof of domain control before creating automatic memberships.
2. Merely entering a syntactically valid domain MUST NOT establish ownership or affect matching users.
3. One normalized domain MUST NOT be actively verified by more than one independent organization at the same time.
4. Domain matching MUST be case-insensitive and based on a canonical normalized representation.
5. A verified domain MUST match only email addresses using that exact domain.
6. A subdomain MUST be verified separately.
7. Public consumer email domains and domains that cannot reasonably establish organization ownership MUST NOT be eligible.
8. If domain ownership becomes ambiguous or can no longer be trusted, the system MUST stop creating new automatic memberships.

### Automatic Membership

1. When a matching human user successfully authenticates, the system MUST ensure that the user is a member of the organization that owns the verified domain.
2. A new automatic membership MUST use the organization's default non-administrative member role.
3. Automatic membership MUST NOT grant owner, administrator, billing, or other elevated privileges.
4. Automatic membership MUST be idempotent and MUST NOT create duplicate memberships.
5. A pending invitation MUST NOT prevent or duplicate automatic membership.
6. An explicit removal tombstone MUST take precedence over automatic membership.
7. A removed user MUST NOT be automatically restored by signing in again.
8. Bot users and service accounts MUST NOT receive automatic membership based solely on an email-domain match.
9. Automatic membership MUST add the user only to the organization that owns the matching domain.

### Existing Users

1. Existing matching users MUST receive automatic membership the next time they successfully authenticate.
2. The system MAY create memberships earlier as an optimization, but product correctness MUST NOT depend on an eager reconciliation job.
3. Domain verification MUST NOT expose a matching user's private account, billing, resource, or organization details to the verifying organization.
4. Existing personal resources, subscriptions, credentials, and organization memberships MUST remain unchanged.

### Authentication and SSO Independence

1. Domain verification and automatic membership MUST be independent of the organization's authentication method.
2. If no SSO policy applies, matching users MUST be allowed to use otherwise-supported ordinary authentication methods.
3. If Organization SSO Enforcement requires SSO for a matching user, the user MUST satisfy that requirement before automatic membership is evaluated.
4. A missing SSO connection MUST NOT block ordinary authentication merely because a verified domain exists.
5. Changing an organization's SSO configuration MUST NOT remove or weaken its verified-domain ownership or automatic-membership behavior.

### Default Destination

1. A user newly added through automatic membership MUST land in the verified-domain organization after authentication.
2. An explicit permitted organization destination in the authentication request MAY take precedence.
3. Automatic membership MUST NOT restrict access to the user's personal context or other organizations.

### Domain Removal and Ownership Changes

1. Removing or losing verification MUST stop new automatic memberships for the domain.
2. Removing a verified domain MUST NOT remove existing organization memberships.
3. Removing a verified domain MUST NOT modify any user's identity, personal context, resources, billing, or other memberships.
4. A domain claimed by another organization MUST be verified again before automatic membership begins for that organization.
5. Ambiguous ownership MUST fail safely without revealing sensitive information about another organization.

### Auditability

1. Domain claim creation, verification, verification loss, and removal MUST be audited.
2. Automatic membership creation and explicit membership removal MUST be auditable.
3. Audit records MUST NOT contain authentication credentials, tokens, cookies, or other secrets.

### Reliability and Security

1. Verified-domain ownership MUST be resolved from authoritative current state at authentication and membership-admission boundaries.
2. Automatic-membership decisions MUST fail safely when domain ownership is ambiguous.
3. Temporary verification-provider failures MUST NOT cause a verified domain to be treated as unowned without an explicit state transition.
4. Concurrent sign-ins and verification callbacks MUST converge on one user identity and at most one organization membership.
5. The system MUST NOT leak the existence, membership, billing, or resources of users based on an unauthenticated domain lookup.

## Error Handling

1. If domain verification fails, the claim MUST remain inactive and MUST NOT affect matching users.
2. If a domain is already verified by another organization, verification MUST fail without revealing sensitive details about that organization.
3. If automatic membership cannot be completed, the authentication result MUST NOT falsely represent the user as an active member of the organization.
4. Failure to create automatic membership MUST NOT modify or disable the user's personal account.
5. A non-critical notification or audit-delivery failure MUST NOT duplicate or roll back a successfully created membership.

## Success Metrics

1. Percentage of successful matching-domain authentications that result in an active organization membership.
2. Domain verification completion rate and median time to verification.
3. Automatic-membership failure rate.
4. Number of duplicate memberships created, with a target of zero.
5. Authentication failure rate for verified-domain users, segmented by ordinary authentication and SSO-required organizations.

## Launch Acceptance Criteria

1. An organization without SSO can verify a domain and automatically receive a newly authenticated matching user.
2. The same flow works for an organization with SSO while preserving its separate SSO authentication requirement.
3. An existing matching user joins the organization on their next successful authentication.
4. Automatic membership grants only the default non-administrative role.
5. An explicit removal prevents automatic restoration.
6. Removing a verified domain stops new automatic memberships without removing existing memberships.
7. Duplicate or ambiguous domain ownership fails safely.
8. Personal accounts, resources, billing, credentials, and unrelated organization memberships remain unchanged.
9. Domain and automatic-membership events are auditable.

## Open Product Decisions

1. Which organization plans are eligible to verify domains?
2. How many active verified domains may one organization own?
3. Which verification methods and providers are supported at launch?
4. Which public or non-organizational domains are ineligible?

## Future Product: Managed Accounts

Organizations that need to disable personal contexts, prevent independent
organization creation, or control pre-existing user assets require a separate
Managed Accounts product. That product may use verified domains as an eligibility
or discovery mechanism, but it MUST define explicit activation, consent and
notice, legacy-resource treatment, billing treatment, release, and cross-tenant
authorization rules independently of automatic membership.

## Changelog

### 2026-08-21 -- Simplified to automatic membership

- Reframed verified domains as automatic organization membership rather than account capture.
- Removed personal-account takeover, resource remediation, organization-conflict, release, and transfer workflows.
- Made existing-user handling lazy at the next successful authentication.
- Reused existing SSO enforcement and membership removal semantics.
- Separated managed accounts into a possible future product.

### 2026-08-20 -- Initial draft

- Defined verified-domain account capture independently of SSO.
- Defined automatic membership and organization-only account behavior.
- Added requirements for existing-user reconciliation, conflicts, suspension, revocation, auditability, and launch acceptance.
