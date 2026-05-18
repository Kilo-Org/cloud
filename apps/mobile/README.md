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
