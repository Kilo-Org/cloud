# Kilo App

AI agents: see [AGENTS.md](AGENTS.md).

Humans: follow instructions below or talk to [@iscekic](https://github.com/iscekic)

## Getting started

Generally speaking, you only need a new dev build if making dependency/native changes.

1. obtain Expo access
2. `pnpx eas-cli login -b`
3. obtain Apple access (developer)

### Android

1. install latest dev build from [here](https://expo.dev/accounts/kilocode/projects/kilo-app/builds?profile=development&platform=ANDROID) - if needed, rebuild with `pnpm build:android`
2. `pnpm start`
3. open installed app on your phone

### iOS

1. add your device to the list of internal devices using `pnpx eas-cli device:create`
2. install the provisioning profile from step 1 on your device (it may involve a 1hr wait)
3. create a new dev build using `pnpm build:ios`
4. `pnpm start`
5. open installed app on your phone

## Quick Chat backends

Kilo remains the default backend. Custom backends use the harness SDK's remote
model plugin, while the SDK owns conversations, tools, and compaction.

- Open **Chat → Manage backends** to configure an API root, protocol, credentials, headers, and models.
- Use Chat Completions, Responses, or Messages with the endpoint's API root, such as `https://api.openai.com/v1`.
- Chat Completions uses `max_completion_tokens` by default. Select `max_tokens` when the endpoint requires the legacy field.
- Enter models manually, or discover models when the endpoint supports discovery.
- Use **Test model connection** to send a short inference request. The provider can charge for this request.
- Enable tool calls only when the selected model and endpoint support them.

Profiles and credentials remain on the device and belong to the signed-in
account. Sign-out and account changes remove them.

- Each conversation retains its backend and upstream model identity, including queued messages.
- Failed questions retain their requested backend through Retry and restoration. Retry never substitutes the previous conversation's backend.
- Editing or deleting a backend requires an explicit selection before its conversations can continue.
- Changing backends shows a warning before sending conversation context to the new backend.
- Failed or unavailable backends never select Kilo automatically. Compaction uses the conversation's selected backend.
- Custom requests exclude Kilo authentication, Kilo headers, and browser cookies. Redirects are blocked.

HTTPS is the default. Local HTTP requires approval for the configured endpoint.
The warning covers unencrypted prompts, responses, credentials, and headers.

- Android release builds require HTTPS, including local servers.
- Android development builds permit approved loopback and private local HTTP endpoints.
- iOS permits approved local HTTP endpoints through the local networking exception.
- Public HTTP endpoints are rejected. HTTPS certificate checks remain enabled.

## App Store Kilo Pass Subscriptions

App Store Kilo Pass subscriptions require an EAS development build or TestFlight
build with the in-app purchase capability enabled. Expo Go is not supported for
this feature.

Configured auto-renewable subscription product IDs:

- `kilopass.tier19.monthly.v1`
- `kilopass.tier49.monthly.v1`
- `kilopass.tier199.monthly.v1`

Use App Store Connect sandbox tester accounts for local and TestFlight sandbox
verification. Configure App Store Server Notifications V2 to post to
`/api/kilo-pass/apple/notifications`.

Backend environment variables:

- `APPLE_IAP_ENVIRONMENT`
- `APPLE_APP_APPLE_ID`
- `APPLE_ROOT_CERTIFICATES_PEM`
- `APPLE_IAP_KEY_ID`
- `APPLE_IAP_ISSUER_ID`
- `APPLE_IAP_PRIVATE_KEY`
