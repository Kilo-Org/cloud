# Organization SSO Domains

## Role of This Document

This spec defines the business rules and invariants for the set of email
domains that an organization's SSO authority owns. It extends
[organization-sso.md](organization-sso.md), which remains the source of truth
for authentication, invitation, membership, and policy-inheritance rules. It
deliberately does not prescribe table layouts, resolver signatures, or
migration mechanics; those belong in the implementation PRs.

## Status

Draft -- created 2026-11-05. Proposed for review; nothing here is implemented.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Definitions

- **SSO domain**: A normalized (trimmed, lower-cased) email domain that a
  Direct SSO organization claims as part of its SSO authority.
- **SSO domain set**: The set of all SSO domains owned by one Direct SSO
  organization. It is empty when the organization has no SSO.
- **WorkOS-verified domain**: A domain that the organization's WorkOS
  organization lists with state `verified`.
- **Drift**: A difference between an organization's SSO domain set and its
  WorkOS organization's verified domains.
- **DNS subdomain**: A domain below another domain, such as `ext.example.com`
  below `example.com`. It is unrelated to a _sub-organization_ (a child
  organization in the parent/child hierarchy of organization-sso.md).

## Overview

A company can verify several email domains in WorkOS, for example a corporate
domain, a contractor subdomain, and a subsidiary's domain. Kilo previously
recorded one SSO domain per organization, so users on every other verified
domain were neither routed to SSO nor protected by SSO enforcement, and an SSO
login from those domains failed at the final authority check.

This spec lets a Direct SSO organization own a set of SSO domains. Every domain
in the set is authoritative to that organization in the same way the single
domain was. Platform administrators manage the set; the set can be reconciled
against WorkOS on demand.

## Rules

### Domain Set Ownership

1. A Direct SSO organization MAY own one or more SSO domains.
2. Each normalized SSO domain MUST belong to at most one non-deleted
   organization. This is the multi-domain form of
   organization-sso.md Policy Resolution rule 6.
3. An SSO child organization MUST NOT own any SSO domain. It inherits its
   direct parent's SSO domain set as its Effective SSO policy.
4. A soft-deleted organization MUST NOT hold a claim on any domain. Deleting an
   organization releases its domains for reuse.
5. Domain comparison MUST be exact on the normalized value. A DNS subdomain and
   its parent domain are distinct SSO domains: owning `example.com` MUST NOT
   imply ownership of `ext.example.com`, and owning `ext.example.com` MUST NOT
   imply ownership of `example.com`. Each MUST be added explicitly.
6. Adding or removing SSO domains MUST be serialized per domain so concurrent
   requests cannot produce two owners for one domain.
7. An SSO domain MUST be syntactically valid. An invalid stored domain MUST
   fail closed for authentication and human membership admission, as in
   organization-sso.md Policy Resolution rule 7.

### Effective SSO Policy

1. An organization's Effective SSO policy MUST cover its whole SSO domain set
   (or its direct parent's, for an SSO child organization).
2. Every rule in organization-sso.md that refers to a Same-domain user MUST
   treat a user as Same-domain when the normalized primary email domain equals
   any domain in the Effective SSO policy's domain set.
3. Consumers MUST NOT treat one domain of the set as representative of the
   whole set. A user on a non-primary domain MUST receive the same enforcement
   as a user on the first-added domain, for authentication, magic links,
   invitations, seat and membership protection, and administrative restore.
4. If any domain in an organization's set is claimed by another non-deleted
   organization, resolution for that domain MUST fail closed as ambiguous.
   It MUST NOT change the resolution of the organization's other domains.

### Authentication

1. Discovery, sign-in eligibility, magic-link rejection, and the final
   authentication callback MUST resolve the SSO authority from the user's own
   email domain. A user on any SSO domain in the set MUST be routed to the
   organization's WorkOS organization.
2. A WorkOS login from a domain MUST succeed only when the domain's SSO
   authority is the same organization as the WorkOS organization's linked local
   organization.
3. A domain that WorkOS lists on the organization but that is not in the SSO
   domain set MUST NOT be enforced and MUST NOT authorize an SSO login. This
   keeps the Kilo SSO domain set the sole authority for enforcement.
4. An SSO domain whose WorkOS organization cannot be found, or is ambiguous,
   MUST fail closed with the existing SSO error; it MUST NOT fall back to
   ordinary sign-up.

### Domain Management

1. Only authorized organization administrators and platform administrators MAY
   add or remove SSO domains, subject to the same access rules as the existing
   SSO domain controls.
2. Adding a domain MUST be rejected when the target organization is an SSO
   child organization, when the domain is invalid, or when the domain belongs
   to another non-deleted organization.
3. Removing a domain MUST NOT delete or alter users, memberships, or sessions.
   After removal, users on that domain are no longer subject to the
   organization's SSO policy.
4. Removing the last domain MUST leave the organization without SSO policy.
   It MUST be an explicit action and MUST be audited like removing SSO today.
5. Every add and remove MUST be audited with actor, organization, and domain.
   Audit entries MUST NOT include tokens, cookies, credentials, or
   authentication headers.

### WorkOS Reconciliation

1. An authorized administrator MAY request a reconciliation of an
   organization's SSO domain set from its WorkOS organization.
2. Reconciliation MUST consider only WorkOS-verified domains. Pending,
   failed, or unverified WorkOS domains MUST NOT be added.
3. Reconciliation MUST apply the same ownership rules as a manual add. A
   verified domain that another organization owns MUST be skipped and
   reported, and MUST NOT block other domains.
4. Reconciliation MUST only add domains. It MUST NOT remove a domain from the
   set, including a domain that WorkOS no longer lists.
5. Reconciliation MUST report, per domain, whether it was added, already
   present, or skipped with a reason. A reconciliation with no changes MUST NOT
   write audit entries.
6. Each added domain MUST be audited as an add, with the audit message noting
   that it came from reconciliation.
7. Administrators MUST be able to see Drift: a WorkOS-verified domain absent
   from the set, or an SSO domain absent from WorkOS's verified list. Showing
   Drift MUST NOT change enforcement.
8. Reconciliation MUST NOT run automatically as a side effect of sign-in or
   any user-initiated request.

### Policy Transitions

1. Adding a domain extends enforcement to existing users on that domain, so it
   is a policy transition under organization-sso.md Policy Transitions.
   Enforcement MUST take effect at authentication and authorization boundaries
   and MUST NOT eagerly invalidate existing sessions or API tokens.
2. The administrative interface SHOULD tell the administrator, before an add
   commits, that existing users on the domain will be required to use SSO.
3. Existing ordinary invitations to Same-domain users of a newly added domain
   MUST NOT remain usable, consistent with organization-sso.md Policy
   Transitions rule 3.

## Error Handling

1. When a domain add conflicts with another organization, the system MUST
   reject it without revealing details of the other organization.
2. When a domain is claimed by more than one live organization, the system
   MUST fail closed for that domain and report it for platform-administrator
   attention.
3. When WorkOS cannot be reached during reconciliation, the system MUST report
   the failure and MUST NOT modify the SSO domain set.

## Not Yet Implemented

The following reflect intended behavior that is not yet enforced in the
current codebase:

1. The whole of this spec. Today an organization owns at most one SSO domain.
2. Automatic notification of organization owners when a domain is added.

## Open Questions

1. **Automatic drift handling.** Should additions from WorkOS ever apply
   without an administrator action (for example by polling the WorkOS Events
   API for `organization_domain.*` events, as scim-sync already does for
   directory events)? This spec requires manual, add-only reconciliation plus
   visible Drift. Automatic apply would make a WorkOS-side change silently
   enforce SSO on existing Kilo users, and automatic removal would silently
   release enforcement.
2. **Domain verification at add time.** Should a manual add require that the
   domain is already WorkOS-verified? Requiring it removes the case where a
   domain is enforced in Kilo but cannot authenticate in WorkOS (an SSO error
   for every user on that domain). Not requiring it lets Kilo claim a domain
   before DNS verification finishes.
3. **Notification on add.** Whether owners of the organization, or only the
   acting administrator, are told that SSO now applies to a new domain.
