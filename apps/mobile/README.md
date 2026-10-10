# Kilo App

AI agents: see [AGENTS.md](AGENTS.md).

Humans: follow instructions below or talk to [@iscekic](https://github.com/iscekic)

## Getting started

Generally speaking, you only need a new dev build if making dependency/native changes.

Native permission translations live in `plugins/permission-prompt-copy.json` for all 87 supported languages.
The camera and photo library prompts explain AI agent attachments and include specific examples.
Background location descriptions remain disabled because the app does not request background location.
Apple requires a localized motion description for the location library's linked APIs, even though Kilo does not use or collect motion activity.
Every build localizes the local-network prompt, because Chat can connect to a local model server.
Changes require a new iOS build; an over-the-air update cannot change the native permission prompt.

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

#### iPhone Duo and iOS 27

- Use Xcode 27.1 or later to test native iPhone Duo layouts.
- Keep `expo-build-properties.ios.enableSceneSupport` enabled in `app.config.ts` while the app uses Expo SDK 57.
- Expo's scene delegate creates the window and forwards lifecycle events and links to the app delegate.
- After a native config change, regenerate the iOS project and rebuild the app.
- Do not edit the generated `ios/` files.
- Sign local simulator builds with an Apple Development identity and its correct team ID.
- Unsigned builds cannot restore the local account from the keychain on this simulator.
- Check both displays, all three fold poses, and each orientation after the rebuild.
- When the app moves to Expo SDK 58, remove the scene support option; its template includes scene support.

#### Responsive layout checks

- Shared tab and detail scroll views reserve the reported left and right safe areas.
- Shared headers add corner clearance when a side status area leaves no top inset.
- For a custom screen body, apply `useSideInsetStyle` outside its gutter container.
- Do not reserve the same side inset in both the shared scroll view and its parent.
- Keep the simulator font size and font scaling at their defaults on both Duo displays.
- Compare hardware-masked screenshots; ordinary app screenshots omit the Duo curvature and camera cutout.
- Run `xcrun simctl io <UDID> screenshot --display=<display-ID> --mask=black <path.png>` for each active display.
- Use `--display=1` for the outer display and `--display=3` for the inner display.
- An inactive display produces a black screenshot.
- Type a draft, change the appearance in both directions, and verify the draft stays readable.

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

- **Manage backends** shows its status and why it is unavailable: Apple Intelligence off, device not eligible, model not ready, or iOS older than 26.
- On-device models are text-only. They never receive tool definitions.
- An unavailable or busy model fails the send with fixed copy. It never falls back to Kilo or another backend.
- Switching between Kilo, a custom backend, and an on-device model shows the context-transfer warning.
- Usage comes from the model when it reports counts, then its token counter, then an estimate of three characters per token, so compaction still runs on the small window.

## Mobile Purchases

Credit packs retain their native App Store and Google Play purchase flow.
They require a development or production build with in-app purchases enabled;
Expo Go is not supported.

Kilo Pass has no native purchase, restore, or store-management flow in the app.
The Profile card and `/kilo-pass` route render the backend
`kiloPass.getPurchasePresentation` result:

- `unavailable` shows the unavailable presentation without purchase controls.
- `web_management` shows Manage, which opens the returned `webUrl`.

Kilo Pass store verification, provider notifications, and expiry reconciliation
remain on the backend for existing store subscriptions.
