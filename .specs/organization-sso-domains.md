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
domain was. The set is not edited by hand: an administrator synchronizes it
from the organization's WorkOS configuration, and the organization's owners
are notified of every change.

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
5. An Effective SSO policy MUST expose its complete domain set. It MUST NOT
   expose a single domain as if it were the policy's domain. Every consumer
   that decides whether a user is a Same-domain user MUST do so by testing
   membership in the complete set, through one shared rule, so that adding a
   domain cannot leave a consumer comparing against only one of them. A
   consumer that cannot evaluate the full set MUST fail closed.
6. Interfaces that display an organization's SSO domain MUST show the
   complete set, including for SSO child organizations inheriting it.

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

1. An organization's SSO domain set MUST change only by synchronizing it with
   the organization's WorkOS organization. The system MUST NOT accept a
   free-form domain from an administrator, and MUST NOT offer a way to add or
   remove an individual domain independently of WorkOS.
2. Only authorized organization administrators and platform administrators MAY
   synchronize an organization's SSO domains, subject to the same access rules
   as the existing SSO controls.
3. Synchronization MUST be initiated by an administrator. The system MUST NOT
   synchronize automatically, including on sign-in, on any user-initiated
   request, on a schedule, or in response to WorkOS events, and MUST NOT
   change enforcement because WorkOS changed. Drift is surfaced (see
   WorkOS Synchronization) but never applied without an administrator action.
4. Synchronization MUST be rejected when the target organization is an SSO
   child organization.
5. Synchronization MUST NOT delete or alter users, memberships, or sessions.
6. Every domain added or removed MUST be audited with actor, organization, and
   domain, noting that it came from synchronization. Audit entries MUST NOT
   include tokens, cookies, credentials, or authentication headers.

### WorkOS Synchronization

1. Synchronization makes the SSO domain set equal to the set of WorkOS-verified
   domains of the organization's WorkOS organization, subject to the rules
   below. It both adds and removes domains.
2. Only WorkOS-verified domains count. Pending, failed, or unverified WorkOS
   domains MUST NOT be added, and a domain that is no longer verified in WorkOS
   MUST be removed.
3. Additions MUST apply the same ownership rules as Domain Set Ownership. A
   verified domain that another non-deleted organization owns MUST be skipped
   and reported, and MUST NOT block other domains.
4. Before applying, the system MUST show the administrator exactly which
   domains will be added and which removed, and MUST apply nothing until the
   administrator confirms.
5. The administrator confirmation MUST state that adding a domain requires
   existing users on it to use SSO, and that removing a domain releases them
   from the organization's SSO requirement.
6. A synchronization that would leave the set empty (removing SSO policy
   altogether, for example because WorkOS lists no verified domains) MUST
   require an additional explicit confirmation.
7. Applying a synchronization MUST be atomic: either every confirmed addition
   and removal takes effect, or none does. The domains to apply MUST be
   re-validated against current WorkOS and Kilo state at apply time.
8. The system MUST report, per domain, whether it was added, removed, already
   in sync, or skipped with a reason. A synchronization with no changes MUST
   NOT write audit entries or send notifications.
9. Administrators MUST be able to see Drift (a WorkOS-verified domain absent
   from the set, or an SSO domain not verified in WorkOS) without applying it.
   Showing Drift MUST NOT change enforcement.
10. When WorkOS cannot be reached, or its organization is missing or
    ambiguous, synchronization MUST fail without modifying the set.

### Notifications

1. When a synchronization adds or removes at least one domain, the system MUST
   send a notification email to every owner of the organization. This applies
   even when the change was made by a platform administrator.
2. The email MUST list the domains added and removed and state the effect on
   users (SSO now required, or no longer required, for those domains). It MUST
   NOT include tokens, credentials, or authentication links.
3. A single synchronization MUST produce at most one email per owner.
4. Notifications MUST be sent only after the change commits. A failure to
   send MUST NOT roll back the change and MUST be reported for operational
   attention.

### Policy Transitions

1. Adding a domain extends enforcement to existing users on that domain, and
   removing one releases them, so both are policy transitions under
   organization-sso.md Policy Transitions. Changes MUST take effect at
   authentication and authorization boundaries and MUST NOT eagerly
   invalidate existing sessions or API tokens.
2. Existing ordinary invitations to Same-domain users of a newly added domain
   MUST NOT remain usable, consistent with organization-sso.md Policy
   Transitions rule 3.

## Error Handling

1. When a domain to add conflicts with another organization, the system MUST
   skip it without revealing details of the other organization.
2. When a domain is claimed by more than one live organization, the system
   MUST fail closed for that domain and report it for platform-administrator
   attention.
3. When WorkOS cannot be reached during synchronization, the system MUST
   report the failure and MUST NOT modify the SSO domain set.

## Not Yet Implemented

The following reflect intended behavior that is not yet enforced in the
current codebase:

1. The whole of this spec. Today an organization owns at most one SSO domain,
   set by hand by an administrator.
