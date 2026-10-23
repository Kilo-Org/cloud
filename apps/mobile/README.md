# Kilo App

AI agents: see [AGENTS.md](AGENTS.md).

Humans: follow instructions below or talk to [@iscekic](https://github.com/iscekic)

## Feature availability

- Chat and PR Review always appear in signed-in navigation.
- The `mobile-chat` and `mobile-pr-review` flags no longer control these features.
- PostHog feature flag infrastructure and the version-aware registry remain available for future flags.
- KiloClaw tab visibility still depends on instance ownership.

## Profile credits

The bonus-credit subtitle includes only grants with an expiry strictly after the
current render time. Elapsed grants and non-expiring credits do not contribute to
its amount or earliest expiry, for both personal and organization accounts.
The balance continues to come from the balance query.

## Organization hub connectivity

Usage tiles retain labels and show cached totals or em dash placeholders.
Unavailable usage and low-balance settings expose Retry. The low-balance row
retries its settings read until data is available, then opens configuration.
Cached settings remain visible during offline pauses and refresh failures.

## Getting started

Generally speaking, you only need a new dev build if making dependency/native changes.

The app uses Expo SDK 58, React Native 0.88 and React 19.3. Align SDK-managed
dependencies with the selected release's `bundledNativeModules.json`, and retain
the workspace release-age policy when resolving upgrades. Existing development-tool
exemptions remain separate from the SDK's release eligibility.

Native compatibility requirements:

- Keep versioned dependency patches and their lockfile hashes together. Regenerate
  them against pristine package sources, and rebuild both development clients.
- Android builds the patched background-task, notifications and task-manager modules
  from source, together with task-manager's app loader.
- `android.uniquePackageNames=false` retains compatibility with AppsFlyer's SDK and
  purchase connector, which share a namespace. AGP 9 otherwise rejects that vendor pair.
- The supported Gesture Handler builder API remains explicitly allowed by the
  deprecation lint rule; other deprecated APIs remain checked.
- `react-native-css` forwards React Native's native component registry through its
  CommonJS facade for Router's native screen host, so the styling facade needs no
  patch of its own.
- The `llama.rn` iOS patch installs JSI bindings through React Native's TurboModule
  runtime hook and conforms to the generated native spec.
- The iOS App Actions bridge uses `@JS` for Expo's noncopyable JavaScript values.
  Its runtime-owned reference releases the dispatcher on the JavaScript thread.
- Root React types stay aligned with the root/web runtime; mobile declares its own
  SDK-matched types. Keep both explicit so cached dependency hoisting cannot mix
  the web and native JSX type identities.
- Deferred cache maintenance keeps a 500 ms timer fallback alongside idle work.
  The first delivery cancels the other so invalidation runs once during sustained JS work.

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
- Expo SDK 58 includes scene lifecycle support in its template; no scene-support opt-in is needed.
- Expo's scene delegate creates the window and forwards lifecycle events and links to the app delegate.
- After a native config change, regenerate the iOS project and rebuild the app.
- Do not edit the generated `ios/` files.
- Sign local simulator builds with an Apple Development identity and its correct team ID.
- Unsigned builds cannot restore the local account from the keychain on this simulator.
- Check both displays, all three fold poses, and each orientation after the rebuild.

#### Widget layout checks

- Home widgets keep a 16pt band on all four sides, including the updating placeholder.
- Check the medium placeholder on a 164pt-tall card: its header, bars and footer must fit within 132pt or SwiftUI centres the overflow into the padding.
- Arabic Live Activity direction comes from `homeWidgetLocale` in the shared app group, not the simulator language.
- The Live Activity direction override is native code in `patches/expo-widgets@58.0.17.patch`. Rebuild the iOS extension after changing the patch; restarting Metro alone leaves the installed extension unchanged.
- After switching the app language, reopen the development client on Metro before applying a fixture and capturing widgets.

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

## Briefing localization

Scheduled report dates use the app language and preserve the report's calendar
day across device timezones. Period windows retain the report's own timezone.
Briefing totals, agent spend, estimates, and charges use USD currency precision
and locale separators. Positive amounts below half a cent display as less than
one cent; partial-coverage lower bounds retain the separate at-least marker.
The summary prompt requests the same precision, separators, and sub-cent rule.

## One-off agent briefings

- Open **Briefings → Create briefing** and select Personal or one organization.
- Select a preset or a custom period of up to 31 days, then review the exact range and timezone.
- Review coverage, the payer, the model, and the cost limit before creating a paid summary.
- Incomplete history remains available with a coverage warning. Missing data does not mean zero activity.
- Empty periods produce a saved report without an AI request or charge.
- Reports preserve activity and session state at the selected period's end, not current live status.
- Large reports use bounded evidence samples across the selected period, with explicit partial coverage and known omission counts.
- The app discards pending results when the signed-in account changes.
- Find confirmed reports in **History** for 30 days after creation, including reports whose AI summary is still running.
- One-off reports do not replace the morning Home card or change the schedule or automatic AI preferences.
- Paid retries require another cost review. Offline paid requests do not enter a background queue.
- The Kilo Model Context Protocol (MCP) catalog excludes paid briefing confirmation.

Deploy the database migration before the backend that uses the new report metadata.

## Quick Chat backends

Kilo remains the default backend. Custom backends use the harness SDK's remote
model plugin, while the SDK owns conversations, tools, and compaction.

- Open **Chat → Manage backends** to view **Chat providers** and configure custom endpoints and models.
- Use Chat Completions, Responses, or Messages with the endpoint's API root, such as `https://api.openai.com/v1`.
- Chat Completions uses `max_completion_tokens` by default. Select `max_tokens` when the endpoint requires the legacy field.
- Enter models manually, or discover models when the endpoint supports discovery.
- Use **Test model connection** to send a short inference request. The provider can charge for this request.
- Enable tool calls only when the selected model and endpoint support them.
- Provider choices separate the selected model from its availability and default status.
- Open **Browse models** for downloadable models. Expand **Advanced** only when using a direct download link.
- Catalog cards show capabilities, download size, estimated memory, and device compatibility. Open **Details** for technical filenames and licenses.

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
- Apple's answer budget is at most half its context window. On iOS 26.4 and later, the native module also subtracts Apple's token count of the complete input (instructions, tools, history, and latest prompt) and reserves one eighth of the window for tool outputs and framing. Earlier iOS releases use a conservative UTF-8-byte input estimate. Requests with no answer space fail before generation. Very large tool outputs can still exhaust the reserve.
- A transient token-generation failure or empty response before answer text allows one recovery attempt, after all tools complete.
- Recovery includes saved tool results as data and has no callable tools. It cannot repeat an action.
- Partial answers, cancellations, guardrail refusals, and pending tool results never use recovery.
- Empty native completions produce a visible failure instead of saving a blank assistant turn.
- The harness counts the completed answer and cached input when deciding whether to compact before the next question.
- Gemini Nano is text-only: the ML Kit GenAI Prompt API has no function calling, so it never receives tool definitions.
- An unavailable or busy model fails the send with fixed copy. It never falls back to Kilo or another backend.
- Switching between Kilo, a custom backend, and an on-device model shows the context-transfer warning.
- Usage comes from the model when it reports counts, then its token counter, then an estimate of three characters per token, so compaction still runs on the small window.

### Downloaded GGUF models

**Chat providers → Downloadable models → Browse models** lists models the app
can download and run locally with `llama.rn` (llama.cpp). Model details show the
license and technical filenames. Downloads pin a Hugging Face revision, so the
bytes cannot change underneath a download. **Advanced** accepts a direct HTTPS
link to a `.gguf` file. The user starts every download. Downloads can pause,
resume, or cancel. Cancelled or failed downloads delete their partial files.
Storage is checked before download and again when the server supplies a length.

- Model files live in the app's document directory. They hold no account data, so the downloaded list survives sign-out and account changes.
- A downloaded model appears in the picker once its file has been read by llama.cpp, which is where its context window comes from. Only one model is loaded at a time; switching releases the previous one, and the app releases it in the background.
- Tools are sent only to a model whose own chat template was verified to render tool definitions and earlier tool calls; every other GGUF model is text-only.
- An answer streams as it is written, interruption stops llama.cpp, and the token counts and stop reason come from llama.cpp itself. A second question while one is running fails as busy.
- `llama.rn` ships prebuilt iOS and Android binaries fetched by its `postinstall` (allowed in `pnpm-workspace.yaml`). It needs React Native's New Architecture (this app), minSdk 24 (llama.rn requires 23), and the `llama.rn` Expo plugin in `app.config.ts`; iOS pods must be reinstalled after the dependency changes.

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
