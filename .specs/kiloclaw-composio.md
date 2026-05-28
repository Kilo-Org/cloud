# KiloClaw Composio Manual Configuration

## Role of This Document

This spec defines the security and product rules for user-provided Composio CLI credentials configured in KiloClaw Settings. Managed Composio identity provisioning and managed connection onboarding are retired and are not supported behavior. Removing retired managed persistence does not alter this manual Settings contract.

It deliberately does not prescribe implementation details such as endpoint names, column layouts, or controller helper structure.

## Status

Draft -- created for managed Composio onboarding in PR #3348 on 2026-05-20.
Updated 2026-05-27 -- reduced to manual Settings configuration after retiring managed onboarding and storage.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

## Definitions

- **Composio CLI credentials**: The user API key and organization identifier required to sign the `composio` CLI into a user's Composio account or organization.
- **Manual Composio configuration**: User-provided Composio CLI credentials saved through KiloClaw Settings and injected into that user's OpenClaw instance.
- **OpenClaw instance**: The provider-backed KiloClaw environment where OpenClaw and the `composio` CLI run.

## Overview

KiloClaw supports Composio only as explicitly user-provided Settings secrets. A user may enter Composio CLI credentials, which are validated, encrypted, transported through the existing instance secret pipeline, and used by the controller to make the Composio CLI available inside that user's instance.

Kilo MUST NOT provision managed Composio identities, create managed Connect Link onboarding flows, store managed Composio credential state, or inject operator-owned or previously managed credentials into instances.

## Rules

### Manual Configuration

1. Manual Composio configuration MUST be opt-in. An instance without both required Composio fields MUST continue to boot without Composio CLI sign-in.
2. The system MUST validate manual Composio fields according to the secret catalog contract before saving or provisioning them. If either required Composio field is supplied during provision, both MUST be supplied together.
3. Manual Composio credentials MUST be treated as user-provided secrets. Both the user API key and organization value MUST be encrypted before reaching the KiloClaw Worker and MUST use the existing encrypted instance-secret transport pipeline.
4. Manual Composio fields MAY remain configurable through Settings and MAY be updated or removed through the normal instance secret update path.
5. Kilo MUST NOT rotate, revoke, claim, share, or otherwise manage manually provided Composio credentials unless a future supported flow explicitly requests that behavior.
6. Manual personal Composio credentials MUST NOT be reused for an organization instance unless the user explicitly configures them in that organization context.

### Removed Managed Behavior

7. Kilo MUST NOT create new managed Composio identities, managed connected-account onboarding flows, Connect Links for managed onboarding, or managed credential injection for KiloClaw.
8. Kilo MUST NOT fall back from missing manual Composio credentials to any operator-owned, shared, historical, or managed credential.
9. New instances and Settings updates MUST NOT create retired managed-onboarding metadata for manual Composio configuration.
10. Direct Google Calendar onboarding, when offered, is independent of Composio and MUST NOT depend on retired managed Composio state.

### Instance CLI Sign-In

11. The OpenClaw instance MAY contain the Composio CLI when no Composio credentials are configured.
12. When valid manual Composio credentials are present, the controller SHOULD sign the CLI in during bootstrap so `composio` commands work without interactive browser login.
13. Composio CLI sign-in MUST be best-effort and MUST NOT prevent controller startup unless a future product contract makes it required.
14. If sign-in uses a subprocess, the implementation MUST invoke a direct executable rather than a shell and MUST suppress logs containing credentials.
15. Any Composio CLI state files written by the controller MUST use owner-only permissions and remain inside the instance user's Composio configuration directory.
16. Credentials used only for CLI sign-in MUST NOT remain unnecessarily available to unrelated child processes.

### Data Protection and Logging

17. Logs, analytics, audit records, Sentry events, command output, and user-facing errors MUST NOT contain raw Composio credentials, OAuth tokens, or generated login commands containing credential material.
18. Manual Composio secrets MUST follow the normal KiloClaw secret encryption, transport, update, and deletion rules.

## Error Handling

1. If manual Composio credentials are missing or incomplete, the controller MUST skip Composio CLI sign-in and continue startup.
2. If manual Composio credential validation fails, the save or provision request MUST fail before transporting invalid credentials to the Worker.
3. If Composio CLI sign-in fails, the controller MUST log a sanitized failure and SHOULD continue startup in a usable state.

## Changelog

### 2026-05-27 -- Retained manual configuration only

- Removed managed identity provisioning, managed Connect Link onboarding, managed persistence, and instance-source tracking from supported behavior.
- Retained explicit user-provided Composio Settings credentials through the encrypted secret pipeline.
- Preserved security requirements for validation, owner scoping, controller sign-in, and sensitive logging.

### 2026-05-20 -- Managed onboarding experiment

- Introduced managed onboarding behavior later removed from supported product behavior.
