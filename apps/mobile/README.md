# Kilo App

AI agents: see [AGENTS.md](AGENTS.md).

Humans: follow instructions below or talk to [@iscekic](https://github.com/iscekic)

## Getting started

Generally speaking, you only need a new dev build if making dependency/native changes.

Native permission translations live in `plugins/permission-prompt-copy.json` for all 87 supported languages.
The camera and photo library prompts explain AI agent attachments and include specific examples.
Background location and motion descriptions are disabled because the app does not request those permissions.
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
