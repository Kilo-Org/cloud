# Kilo App

AI agents: see [AGENTS.md](AGENTS.md).

Humans: follow instructions below or talk to [@iscekic](https://github.com/iscekic)

## Getting started

Generally speaking, you only need a new dev build if making dependency/native changes.

Native permission translations live in `plugins/permission-prompt-copy.json` for all 87 supported languages.
The camera and photo library prompts explain AI agent attachments and include specific examples.
Background location descriptions remain disabled because the app does not request background location.
Apple requires a localized motion description for the location library's linked APIs, even though Kilo does not use or collect motion activity.
Development builds also localize the local-network prompt; production builds exclude that development-only translation and retain Expo's release stripping.
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
