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

### On-device models

On iOS 26 or later with Apple Intelligence on, the model picker offers
**Apple Intelligence (on device)**. The `kilo-apple-model` local module runs
Apple's Foundation Models system model for inference only; the SDK still owns
the conversation. Building the module requires Xcode with the iOS 26.4 SDK or
newer. The minimum iOS version does not change.

On Android devices whose AICore system app supports Gemini Nano, the picker
offers **Gemini Nano (on device)**. The `kilo-android-model` local module uses
the ML Kit GenAI Prompt API (`genai-prompt` 1.0.0-beta2, the newest release the
app's Kotlin 2.1 compiler can read). The library declares minSdk 26; the module
overrides that in its manifest and returns `unsupported_os` below API 26, so the
app's minSdk does not change.

- When the system reports the model as downloadable, **Manage backends** shows **Download on-device model**. Only that button starts the system download; the row shows progress and failures, then checks the status again.
- Gemini Nano runs only while Kilo is in the foreground. Leaving the app stops the reply with fixed copy; **Retry** works after returning.

- **Manage backends** shows its status and why it is unavailable: Apple Intelligence off, device not eligible, model not ready, or iOS older than 26.
- Apple's model receives the chat's tools through Foundation Models tool calling. When the model calls a tool, the generation waits, JavaScript runs the tool through the harness, and the next request resumes the same generation with the results. A tool whose arguments schema Foundation Models cannot express (a union, a reference, a map with free keys) is left out and logged; an optional argument of that kind is left out of its tool.
- Gemini Nano is text-only: the ML Kit GenAI Prompt API has no function calling, so it never receives tool definitions.
- An unavailable or busy model fails the send with fixed copy. It never falls back to Kilo or another backend.
- Switching between Kilo, a custom backend, and an on-device model shows the context-transfer warning.
- Usage comes from the model when it reports counts, then its token counter, then an estimate of three characters per token, so compaction still runs on the small window.

### Downloaded GGUF models

**Manage backends → Downloadable models** lists small instruct models the app
can download and run locally with `llama.rn` (llama.cpp). Each entry states its
size and license and pins one Hugging Face revision, so the bytes cannot change
underneath a download. A direct HTTPS link to a `.gguf` file works too. The user
starts every download; it can be paused, resumed, or cancelled, and a cancelled
or failed download deletes its partial file. Storage is checked before a
download and again as soon as the server states a length.

- Model files live in the app's document directory. They hold no account data, so the downloaded list survives sign-out and account changes.
- A downloaded model appears in the picker once its file has been read by llama.cpp, which is where its context window comes from. Only one model is loaded at a time; switching releases the previous one, and the app releases it in the background.
- Tools are sent only to a model whose own chat template was verified to render tool definitions and earlier tool calls; every other GGUF model is text-only.
- An answer streams as it is written, interruption stops llama.cpp, and the token counts and stop reason come from llama.cpp itself. A second question while one is running fails as busy.
- `llama.rn` ships prebuilt iOS and Android binaries fetched by its `postinstall` (allowed in `pnpm-workspace.yaml`). It needs React Native's New Architecture (this app), minSdk 24 (llama.rn requires 23), and the `llama.rn` Expo plugin in `app.config.ts`; iOS pods must be reinstalled after the dependency changes.

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
