# KiloClaw Composio Manual Configuration

## Role of This Document

This spec defines the security and product rules for the user-provided Composio credential configured in KiloClaw Settings. Managed Composio identity provisioning and managed connection onboarding are retired and are not supported behavior. Removing retired managed persistence does not alter this manual Settings contract.

It deliberately does not prescribe implementation details such as endpoint names, column layouts, or controller helper structure.

## Status

Draft -- created for managed Composio onboarding in PR #3348 on 2026-05-20.
Updated 2026-05-27 -- reduced to manual Settings configuration after retiring managed onboarding and storage.
Updated 2026-07-22 -- switched the supported surface from Composio CLI sign-in to Composio Connect over MCP.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

## Definitions

- **Consumer key**: The `ck_`-prefixed credential a user copies from the AI Clients page of the Composio dashboard. It authenticates against Composio Connect and is not interchangeable with the CLI's user API key (`uak_`) or a project API key (`ak_`).
- **Composio Connect**: Composio's hosted MCP server, which exposes toolkit capabilities as MCP tools to any client presenting a consumer key.
- **Manual Composio configuration**: A user-provided consumer key saved through KiloClaw Settings and injected into that user's OpenClaw instance.
- **Legacy CLI credentials**: `COMPOSIO_USER_API_KEY` and `COMPOSIO_ORG` values configured before this surface existed, or created by a user running `composio login` inside their own instance.
- **OpenClaw instance**: The provider-backed KiloClaw environment where OpenClaw runs.

## Overview

KiloClaw supports Composio only as an explicitly user-provided Settings secret. A user may enter a consumer key, which is validated, encrypted, transported through the existing instance secret pipeline, and written by the controller into the instance's OpenClaw configuration as a remote MCP server definition. Composio's tools then reach the agent over HTTP; KiloClaw installs and runs nothing on the user's behalf.

Toolkit authorization (Gmail, Calendar, and so on) happens entirely in the Composio dashboard. KiloClaw MUST NOT attempt to broker, initiate, or store those connections.

Kilo MUST NOT provision managed Composio identities, create managed Connect Link onboarding flows, store managed Composio credential state, or inject operator-owned or previously managed credentials into instances.

## Rules

### Manual Configuration

1. Manual Composio configuration MUST be opt-in. An instance without a consumer key MUST continue to boot with no Composio server defined.
2. The system MUST validate the consumer key according to the secret catalog contract before saving or provisioning it.
3. Consumer key validation SHOULD stay permissive beyond the credential family prefix. Composio performs no prefix or length check of its own, so validation stricter than the documented shape risks rejecting a valid credential.
4. The consumer key MUST be treated as a user-provided secret, encrypted before reaching the KiloClaw Worker, and carried by the existing encrypted instance-secret transport pipeline.
5. The consumer key MAY be updated or removed through the normal instance secret update path.
6. Kilo MUST NOT rotate, revoke, claim, share, or otherwise manage a manually provided Composio credential unless a future supported flow explicitly requests that behavior.
7. A personal consumer key MUST NOT be reused for an organization instance unless the user explicitly configures it in that organization context.

### Removed Managed Behavior

8. Kilo MUST NOT create new managed Composio identities, managed connected-account onboarding flows, Connect Links for managed onboarding, or managed credential injection for KiloClaw.
9. Kilo MUST NOT fall back from a missing consumer key to any operator-owned, shared, historical, or managed credential.
10. New instances and Settings updates MUST NOT create retired managed-onboarding metadata for manual Composio configuration.
11. Direct Google Calendar onboarding, when offered, is independent of Composio and MUST NOT depend on retired managed Composio state.

### Instance Configuration

12. When a consumer key is present, the controller MUST define Composio Connect as a remote MCP server in the instance's OpenClaw configuration, replacing any existing definition of that server outright. It MUST NOT install software, spawn a login subprocess, or perform any network call on the user's behalf to establish the connection. Carrying fields over from a previous definition risks retaining an authentication mode that suppresses the configured credential.
13. When no consumer key is present, the controller MUST remove the server definition it manages, because instance configuration persists across redeploys and a stale definition would otherwise outlive the credential's removal from Settings.
14. Removal MUST be limited to a definition KiloClaw explicitly marked as managed when it wrote it. Ownership MUST NOT be inferred from a definition's endpoint, transport, headers, or any other value published by Composio, because a user configuring the same product by hand produces an identical definition. An unmarked Composio server MUST be left intact.
15. Configuring Composio MUST NOT prevent controller startup. An unreachable or unauthorized endpoint surfaces at tool-call time and MUST NOT be treated as a boot failure.
16. The instance MAY continue to contain the Composio CLI, and legacy CLI credentials MUST continue to reach the instance so that a sign-in a user performed themselves is not broken by an upgrade. Retiring a credential's Settings field MUST NOT downgrade how that credential is carried: a retired credential env var name MUST remain classified sensitive so its value is still encrypted in transport rather than written to the provider's plaintext environment.
17. Agent-facing documentation MUST describe the MCP surface and MUST NOT instruct the agent to sign the CLI in, because doing so cannot change which tools the configured credential reaches.

### Data Protection and Logging

18. Logs, analytics, audit records, Sentry events, command output, and user-facing errors MUST NOT contain raw Composio credentials, OAuth tokens, or generated commands containing credential material.
19. Manual Composio secrets MUST follow the normal KiloClaw secret encryption, transport, update, and deletion rules.

## Error Handling

1. If no consumer key is configured, the controller MUST continue startup with no Composio server defined.
2. If consumer key validation fails, the save or provision request MUST fail before transporting the invalid credential to the Worker.
3. If Composio Connect is unreachable or rejects the credential, the failure MUST surface to the agent at tool-call time and MUST NOT degrade the instance.

## Changelog

### 2026-07-22 -- Composio Connect over MCP

- Replaced the CLI user API key and organization fields with a single consumer key field.
- Defined Composio Connect as a remote MCP server written into instance configuration, replacing controller-run CLI sign-in as the supported path.
- Scoped managed removal to definitions KiloClaw marks as its own, so hand-configured Composio servers are not deleted.
- Kept legacy CLI credentials flowing to instances, and the CLI installed, so existing manual sign-ins survive.
- Retained the two legacy CLI env var names as always-sensitive so a value under either stays encrypted in transport even though the fields left the catalog.

### 2026-05-27 -- Retained manual configuration only

- Removed managed identity provisioning, managed Connect Link onboarding, managed persistence, and instance-source tracking from supported behavior.
- Retained explicit user-provided Composio Settings credentials through the encrypted secret pipeline.
- Preserved security requirements for validation, owner scoping, controller sign-in, and sensitive logging.

### 2026-05-20 -- Managed onboarding experiment

- Introduced managed onboarding behavior later removed from supported product behavior.
