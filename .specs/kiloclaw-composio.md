# KiloClaw Composio Integration

## Role of This Document

This spec defines the business rules and invariants for user-provided Composio CLI credentials in KiloClaw settings and the retirement of the removed managed Composio onboarding experiment. It is the source of truth for what the system must guarantee about credential ownership, encrypted instance injection, cleanup of managed credentials previously created by Kilo, and logging boundaries.

It deliberately does not prescribe implementation details such as endpoint names, column layouts, cleanup command names, or controller helper structure.

## Status

Draft -- created for managed Composio onboarding in PR #3348 on 2026-05-20.
Updated 2026-05-27 -- retired managed onboarding; retained user-provided Settings configuration only.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

## Definitions

- **Composio CLI credentials**: The Composio user API key and organization identifier required to sign the `composio` CLI into a Composio account or organization.
- **Manual Composio configuration**: User-provided Composio CLI credentials saved through KiloClaw Settings and injected into an OpenClaw instance.
- **Retired managed Composio identity**: A Kilo-created Composio identity or connected-account record created during the removed managed onboarding experiment.
- **OpenClaw instance**: The provider-backed KiloClaw environment where OpenClaw and the `composio` CLI run.

## Overview

KiloClaw supports Composio only as an explicitly user-configured Settings secret. A user can enter their Composio CLI credentials, which are validated, encrypted, delivered through the existing instance secret pipeline, and used by the controller to make Composio available inside their instance.

Kilo previously shipped a managed Composio onboarding experiment that created Kilo-owned identities and Connect Links. That behavior is retired. Kilo must not create or inject new managed Composio credentials. After new creation is disabled, Kilo must verify whether any active instance retains managed credentials, clear any confirmed runtime residue, and remove obsolete stored managed identity state.

## Rules

### Manual Configuration

1. Manual Composio configuration MUST be opt-in. An OpenClaw instance without both required Composio fields MUST continue to boot without Composio CLI sign-in.
2. Manual Composio credentials MUST be treated as user-provided secrets. The user API key and organization value MUST be encrypted before reaching the KiloClaw Worker and MUST be delivered through the existing encrypted environment variable pipeline.
3. Manual Composio fields MUST remain configurable from Settings through the secret catalog unless a future spec explicitly removes Composio support.
4. The system MUST validate manually entered Composio credential fields according to the catalog validation contract before saving or provisioning them.
5. When a user clears manual Composio settings, subsequent instance configuration MUST remove the corresponding injected secret values through the normal secret update path.
6. Kilo MUST NOT rotate, revoke, claim, or otherwise manage manually entered Composio credentials unless the user explicitly requests that action through a future supported flow.

### Instance CLI Sign-In

7. The OpenClaw instance MAY contain the Composio CLI even when no Composio credentials are configured.
8. When valid manual Composio credentials are present, the controller SHOULD sign the CLI in during bootstrap so `composio` commands work without interactive browser login.
9. Composio CLI sign-in MUST be best-effort and MUST NOT prevent the controller from starting OpenClaw unless a future product contract makes Composio a required dependency.
10. If sign-in uses a subprocess, the implementation MUST invoke a direct executable rather than a shell and MUST suppress logs containing credentials.
11. Any Composio CLI state files written by the controller MUST use owner-only permissions and remain inside the instance user's Composio configuration directory.
12. Credentials used only for CLI sign-in MUST NOT remain unnecessarily available to unrelated child processes.

### Removed Managed Onboarding

13. Kilo MUST NOT create new managed Composio identities, Connect Links, connected-account onboarding flows, or managed credential injection for KiloClaw onboarding.
14. Direct Google Calendar onboarding, when offered, is independent of Composio and MUST NOT depend on retired managed Composio state.
15. Retired managed Composio identities MUST NOT be reused for new instances or configuration updates.
16. After managed creation paths are disabled, the system MUST verify whether any existing live instance retains managed Composio credentials before obsolete stored managed identity state is deleted.
17. Any confirmed managed credential material in an existing live instance MUST be cleared before obsolete stored managed identity state is deleted. Verification and clearing MUST NOT remove manually configured Composio credentials.
18. If no live managed runtime credential remains, obsolete managed identity rows, encrypted credential residue, connected-account identifiers, and destroyed-instance tracking markers MAY be removed by dropping the retired managed-state schema.
19. Obsolete managed-state database structures MUST NOT be dropped until managed creation is disabled and live runtime residue has been ruled out or cleared.

### Credential Boundary and Data Protection

20. Kilo central or retired managed Composio credentials MUST NOT be injected into a user or organization OpenClaw instance.
21. Logs, analytics, audit records, Sentry events, command output, and user-facing errors MUST NOT include raw Composio credentials, OAuth tokens, Connect Links containing secret material, or decrypted stored identity data.
22. User-provided Composio secrets MUST continue to follow the normal KiloClaw secret encryption, transport, and deletion rules.
23. Retired managed rows containing encrypted credentials or user-linked provider identifiers MUST be deleted after the required live-runtime verification or otherwise scrubbed in accordance with account-deletion requirements.

## Error Handling

1. If manual Composio credentials are missing or incomplete, the controller MUST skip Composio CLI sign-in and continue startup.
2. If manual Composio credential validation fails, the save or provision request MUST fail before transporting invalid credentials to the Worker.
3. If Composio CLI sign-in fails, the controller MUST log a sanitized failure and SHOULD continue startup in a usable state.
4. If clearing confirmed managed runtime credentials from an active instance fails, obsolete managed stored state MUST be retained until that cleanup can be retried successfully.

## Changelog

### 2026-05-27 -- Retired managed Composio onboarding

- Removed managed identity provisioning, managed Connect Link onboarding, and managed callback injection from supported product behavior.
- Retained explicit user-provided Composio credentials through Settings and the encrypted secret pipeline.
- Added post-deploy live-runtime verification and subsequent stored-state removal requirements for managed credentials created or injected while the experiment was shipped.

### 2026-05-20 -- Managed onboarding experiment

- Introduced the managed Composio onboarding behavior later retired by the 2026-05-27 revision.
