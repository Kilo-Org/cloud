# Account Linking

## Role of This Document

This spec defines the business rules and invariants for account linking.
It is the source of truth for _what_ the system must guarantee —
valid states, ownership boundaries, correctness properties, and
user-facing behavior. It deliberately does not prescribe _how_ to
implement those guarantees: handler names, column layouts,
conflict-resolution strategies, and other implementation choices
belong in plan documents and code, not here.

## Status

Draft -- created 2026-11-09.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Definitions

- **Pending link**: A short-lived, single-use record of a provider identity
  that is not yet attached to the account it names.
- **Existing-account link**: A pending link created when a sign-in email
  belongs to an account that the sign-in did not settle.
- **Explicit link**: A pending link created from an authenticated
  connected-accounts action.
- **Verified primary address**: The account holds a sign-in method that
  verified its primary address, or the account has no provider rows.

## Overview

A person who signs in with a new provider for an email that an account
already uses can attach that provider after proving ownership of the
account. Proof is a code sent to the account address, or a sign-in with
a method the account already has. Every provider can be linked this
way, including Apple from connected accounts.

## Rules

### Pending links

1. On a different-provider sign-in refusal, the system MUST store the new
   provider identity as a pending link when the account does not already
   have that provider type.
2. A pending link MUST expire after 15 minutes.
3. A pending link MUST be usable at most once.
4. A pending link MUST stay bound to the browser or app that started it.
5. Email confirmation MUST use a code typed into the starting browser or
   app.
6. Email confirmation MUST NOT use a one-click approval link.
7. The system MUST NOT create a pending link when the account already has
   the same provider type with a different account identifier.
8. Under HTTPS, the browser binding MUST use a host-only cookie, so a
   sibling subdomain cannot plant a pending link secret.
9. Attaching MUST follow an explicit confirmation by the signed-in account
   holder that names the provider and identity. A navigation alone MUST NOT
   attach.

### Email code eligibility

1. The system MUST offer the email code only when the existing account has
   a verified primary address.
2. For an account without a verified primary address, the system MUST
   offer only sign-in with an existing method.
3. Eligibility MUST be decided when the pending link is created.
4. A code MUST be accepted only for the link-code request made for that
   pending link. A generic sign-in code MUST NOT complete a pending link.
5. One pending link MUST allow at most 3 code sends.

### Provider verification flags

1. A verified provider email MUST count as proof of email ownership for
   the incoming sign-in.
2. For GitHub, proof MUST come from the verified flag of the address the
   sign-in uses, read from the provider email list.
3. For Discord, proof MUST come from the profile verified flag.
4. This rule MUST NOT make an existing GitHub or Discord row count as a
   verified account address.
5. GitLab uses the generic rule: its OIDC provider emits the standard
   `email_verified` claim for the address the application may see.

### Apple explicit linking

1. Apple MUST be linkable from connected accounts.
2. When the Apple callback cannot carry the linking session, the system
   MUST store an explicit pending link for the session user.
3. Completion MUST run on a same-site request that carries the session.
4. Completion MUST require that the session user equals the link target.
5. The system MUST NOT create an explicit Apple link when the account
   already has Apple, or when the Apple identity belongs to another account.

### Attach rule

1. An unknown, consumed, or expired pending link MUST fail as expired.
   Expired is non-retryable.
2. A resolved user other than the link target MUST fail as a wrong
   account.
3. A wrong-account failure MUST NOT consume the pending link.
4. On success, the system MUST attach the identity and consume the
   pending link exactly once.
5. Consumption MUST be atomic under concurrent completion attempts.
6. Offered methods MUST be the account provider types, plus passkey when
   the account has passkeys.
7. Offered methods MUST exclude enterprise SSO, the pending provider, and
   the test login outside supported environments.

### Security notice

1. After every successful new link, the system MUST send a new sign-in
   method notice to the account primary address.
2. The system MUST NOT send the notice for a no-op re-link of the same
   identity.
3. The system MUST NOT send the notice for the test login.
4. A notice send failure MUST NOT fail the link.
5. The notice MUST name the provider and the linked identity, and MUST
   tell the reader to remove the method if they did not add it.

### Mobile contract

1. A native sign-in request MAY carry a pending link token.
2. An eligible different-provider refusal MUST return the pending link
   token, provider, email, methods, email-code eligibility, and expiry.
3. A successful sign-in that carried a token MUST report the link result.
4. A failed link MUST NOT fail the sign-in itself.
5. A device authorization request MAY carry a live pending link token. A
   token that is not live MUST be refused when the request is created.
6. The approval page MUST name the pending link, and the approver MUST
   choose whether to add it. Approving without adding MUST attach nothing.
7. The link MUST be evaluated against the approving user only after the
   device credentials are issued.

### Accounts from providers without an email

1. A provider sign-in that shares no email address MUST be refused with a
   specific reason that names the missing address, not a generic failure.
2. The refusal MUST NOT create an account or a pending link.

### Sign-in gates

1. Pending-link flows MUST keep every existing sign-in gate: blocked
   users, blacklisted domains, SSO authority, the deletion fence,
   Turnstile for OAuth sign-ins, and new-account admission.
2. The system MUST NOT log or report link secrets, codes, cookies, or
   email addresses beyond what existing sign-in code already records.
3. Unknown input at a pending-link boundary MUST be validated before use.

## Error Handling

1. When a pending link is expired, the system MUST show a start-again
   state and MUST NOT offer a retry of the same token.
2. When a code is wrong, the system MUST report a retryable error with the
   attempts left when known.
3. When the attempt budget is spent, the system MUST refuse further
   guesses for that code.
4. When a completion resolves a different user, the system MUST report a
   wrong-account state with a sign-out-and-retry action.

## Not Yet Implemented

None.

## Changelog

### 2026-11-09 -- Initial spec

- Created for pending account linking.
- Added confirmation before attach, host-only cookie, link-code binding,
  send cap, and device approval consent.
