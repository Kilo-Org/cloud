# KiloClaw Composio Integration

## Role of This Document

This spec defines the business rules and invariants for integrating
Composio with KiloClaw. It is the source of truth for what the system
must guarantee about Composio credential ownership, sandbox injection,
manual configuration, managed provisioning, organization sharing, and
connection onboarding.

It deliberately does not prescribe how to implement those guarantees:
column layouts, endpoint names, controller helper names, and UI component
structure belong in plan documents and code, not here.

## Status

Draft -- created 2026-05-15.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Definitions

- **Composio CLI credentials**: The Composio user API key and
  organization identifier required to sign the `composio` CLI into a
  Composio account or organization.
- **Manual Composio configuration**: User-provided Composio CLI
  credentials entered through KiloClaw settings and injected into a
  KiloClaw sandbox.
- **Managed Composio identity**: A Composio identity provisioned by Kilo
  on behalf of a Kilo user or organization, with credentials stored by
  Kilo and reused across KiloClaw instance lifecycles.
- **Owner scope**: The Kilo ownership boundary for a Composio identity.
  The supported scopes are a personal Kilo user and a Kilo organization.
- **Connected account**: A Composio record representing a user's or
  organization's authorization to an external toolkit such as Google
  Calendar, Gmail, GitHub, or Slack.
- **Connect Link**: A Composio-hosted authentication URL used to connect
  an external toolkit account to a Composio user/context.
- **Sandbox**: The Fly Machine-backed KiloClaw environment where
  OpenClaw and the `composio` CLI run.
- **Kilo central Composio credential**: Any Composio credential owned by
  Kilo as an operator/developer rather than by a specific Kilo user or
  Kilo organization owner scope.

## Overview

KiloClaw can expose Composio to sandbox agents in two phases. First,
users may manually provide Composio CLI credentials in KiloClaw settings;
KiloClaw injects those credentials into the sandbox and signs the local
`composio` CLI in during controller bootstrap. This makes Composio
available without Kilo provisioning or owning a Composio identity.

Later, Kilo may provision managed Composio identities during onboarding.
Managed personal identities are reused across a user's KiloClaw instance
recreates. Managed organization identities are shared across eligible
users in a Kilo organization according to Kilo organization access rules.
Kilo may create Connect Links during onboarding so external toolkit
connections can be completed before the sandbox is fully provisioned.

## Rules

### Manual Configuration

1. Manual Composio configuration MUST be opt-in. A sandbox without both
   a Composio user API key and Composio organization value MUST continue
   to boot without Composio CLI sign-in.
2. Manual Composio credentials MUST be treated as user-provided secrets.
   The Composio user API key MUST be encrypted at rest before it reaches
   the KiloClaw worker and MUST be delivered to the machine through the
   existing encrypted environment variable pipeline.
3. The Composio organization value MAY be less sensitive than the user
   API key, but when collected with the Composio integration it SHOULD be
   stored and transported through the same secret path to avoid exposing
   account metadata unnecessarily.
4. The controller MUST NOT log Composio user API keys, generated login
   commands containing those keys, Connect Links containing secret
   material, OAuth tokens, or raw Composio credentials.
5. When manual Composio credentials are removed from KiloClaw settings,
   the next sandbox bootstrap SHOULD leave the CLI unsigned-in or clean
   up prior Composio CLI auth state so stale credentials are not reused.
6. Kilo MUST NOT rotate, revoke, claim, or otherwise manage manually
   entered Composio credentials unless the user explicitly requests that
   action through a supported product flow.

### Sandbox CLI Sign-In

7. The sandbox MAY contain the Composio CLI even when no Composio
   credentials are configured.
8. When valid Composio CLI credentials are available, the controller
   SHOULD sign the CLI in during bootstrap so `composio` commands work
   without an interactive browser login.
9. Composio CLI sign-in MUST be best-effort and MUST NOT prevent the
   controller from starting OpenClaw unless the user or product has
   explicitly configured Composio as a required startup dependency.
10. If sign-in uses a subprocess invocation, the implementation MUST use
    a direct executable call rather than a shell and MUST suppress logs
    that would include credentials.
11. If sign-in writes Composio CLI state files directly, those files MUST
    be written with owner-only permissions and MUST be placed in the
    sandbox user's Composio config directory.
12. Composio credentials injected for CLI sign-in MUST NOT be left in the
    gateway child process environment when they are no longer needed by
    the running gateway.
13. Configuring Composio through KiloClaw settings or managed
    provisioning is an explicit request for Kilo to manage the sandbox's
    Composio CLI sign-in. When valid Kilo-provided Composio credentials
    are available, the controller MAY overwrite existing on-disk
    Composio CLI configuration during bootstrap.
14. If a user signs into Composio manually inside the sandbox after
    configuring Composio through KiloClaw, a later controller bootstrap
    MAY overwrite that manual sign-in with the Kilo-provided
    credentials. This is accepted behavior; users who want to preserve a
    fully custom Composio CLI configuration SHOULD not configure
    Composio through KiloClaw for that sandbox.
15. When Composio credentials are removed from Kilo settings or managed
    provisioning, the controller MAY leave any existing on-disk Composio
    CLI configuration untouched. Kilo is not required to determine
    whether that configuration was written by Kilo or by a user.

### Credential Boundary

16. Kilo central Composio credentials MUST NOT be injected into a user or
    organization sandbox.
17. A sandbox MUST receive only credentials for its own owner scope: the
    user's manual credentials, the user's managed personal Composio
    identity, or the Kilo organization's managed Composio identity.
18. The system MUST NOT fall back from a missing owner-scoped Composio
    identity to any shared global Composio identity.
19. Manual personal Composio credentials MUST NOT be reused for an
    organization sandbox unless the user explicitly configures those
    credentials in that organization context.
20. Managed personal Composio credentials MUST NOT be reused for a Kilo
    organization context. Managed organization credentials MUST NOT be
    reused for an unrelated organization or personal context.

### Managed Identity Ownership

21. A managed personal Composio identity MUST be scoped to exactly one
    Kilo user.
22. A managed organization Composio identity MUST be scoped to exactly
    one Kilo organization.
23. Managed Composio identities MUST survive KiloClaw instance destroy
    and reprovision operations unless the owner explicitly revokes the
    identity or account deletion/org deletion policy requires revocation
    or anonymization.
24. Kilo SHOULD store managed Composio identities in owner-scoped
    persistent storage rather than instance-scoped Durable Object state.
25. Managed Composio identity credentials MUST be encrypted at rest.
26. The KiloClaw worker MUST NOT be the primary creator of persistent
    managed Composio identity records. Persistent identity writes SHOULD
    be owned by the Next.js web app or another explicitly designated
    control-plane service.
27. At most one active managed Composio identity SHOULD exist per owner
    scope unless a future spec explicitly supports multiple active
    identities.

### Organization Sharing

28. In a Kilo organization context, eligible organization users MAY share
    the organization's managed Composio identity.
29. Sharing a managed organization Composio identity means connected
    accounts associated with that identity MAY be usable by multiple
    organization users who have access to the relevant organization
    KiloClaw sandbox.
30. The system MUST define and enforce which organization roles or
    permissions can configure, connect, revoke, or use organization-level
    Composio credentials before enabling managed organization
    provisioning in production.
31. When a user loses access to a Kilo organization, the system MUST
    prevent that user from receiving the organization's managed Composio
    credentials in any future sandbox config.
32. Organization member removal SHOULD NOT delete the organization's
    managed Composio identity or connected accounts unless the removed
    member was the sole authorized external-account owner and the
    organization explicitly requests cleanup.
33. Organization deletion MUST define whether the managed Composio
    identity is revoked, claimed by an administrator, anonymized, or
    retained for audit/compliance before deletion support ships.

### Connect Link Onboarding

34. Kilo MAY create Composio Connect Links during onboarding before the
    sandbox machine exists.
35. A Connect Link created by Kilo MUST be scoped to the correct managed
    owner identity and to the intended Composio user/context for that
    owner.
36. Connect Link callback handling MUST verify the authenticated Kilo
    user still has access to the owner scope before recording a
    connection as active or surfacing it in UI.
37. Kilo MUST NOT receive or persist raw OAuth access tokens from external
    toolkits connected through Composio unless a separate spec explicitly
    permits that behavior.
38. Connection status displayed in Kilo SHOULD be derived from Composio
    connected-account state or from a Kilo cache that is refreshed from
    Composio. Kilo MUST NOT treat creation of a Connect Link as proof
    that the external account is connected.
39. For organization-scoped onboarding, Kilo MUST make clear that the
    connection is for the organization context, not just the individual
    member completing OAuth.

### Data Protection and Logging

40. Composio user API keys, project API keys, agent keys, OAuth tokens,
    and any equivalent credential material MUST be treated as secrets.
41. Logs, analytics, audit records, Sentry events, and user-facing errors
    MUST NOT include raw Composio credentials or OAuth tokens.
42. Generated Composio emails or identifiers that can be linked to a Kilo
    user SHOULD be treated as user-linked data for GDPR/anonymization
    purposes.
43. When Kilo stores user-linked managed Composio data in Postgres, the
    GDPR soft-delete flow MUST anonymize, revoke, or detach that data in
    a way that complies with the product's account deletion policy.

## Error Handling

1. If manual Composio credentials are missing or incomplete, the
   controller MUST skip Composio CLI sign-in and continue startup.
2. If Composio CLI sign-in fails, the controller MUST log a sanitized
   failure and SHOULD continue startup in a usable state.
3. If managed Composio identity provisioning fails during onboarding,
   the onboarding flow MUST surface a retryable error and MUST NOT store
   a partially usable identity as active.
4. If a Connect Link callback reports failure or the connected account is
   not active, Kilo MUST keep the connection status non-active and allow
   the user to retry.
5. If an organization user is no longer authorized for an organization
   before a Connect Link callback completes, Kilo MUST reject the
   callback result for that user's session.

## Not Yet Implemented

The following rules use SHOULD and reflect intended behavior that is not
necessarily enforced in the current codebase:

1. The system SHOULD support manual Composio CLI configuration through
   KiloClaw settings. (Currently not implemented.)
2. The controller SHOULD sign the Composio CLI in when manual or managed
   credentials are present. (Currently not implemented.)
3. Kilo SHOULD provision managed personal Composio identities during
   onboarding. (Currently not implemented.)
4. Kilo SHOULD provision or reuse managed organization Composio
   identities for organization KiloClaw contexts. (Currently not
   implemented.)
5. Kilo SHOULD support pre-provision Connect Link onboarding for selected
   toolkits such as Google Calendar. (Currently not implemented.)
