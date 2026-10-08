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

## Kilo Pass status and legacy purchase recovery

Version 1.0.15 removes native Kilo Pass subscription sales and upgrades on both
platforms. Profile opens a read-only status screen for store and web subscriptions,
with streak, bonus credits, and paid-period end where the current backend state
provides it. The screen contains no web checkout or billing-management links.
The organization hub also shows read-only Kilo Pass state without checkout or
web subscription-management actions.
Active legacy subscriptions retain access to their platform's store-management sheet.
Native one-off credit packs, localized prices, legal links, and recovery remain enabled.

The forced-upgrade build itself completes already-paid, unfinished subscriptions:
`StorePurchaseRecoveryMount` reconnects and submits verified receipts on launch and
foreground regain, without opening a sales screen. Explicit Restore Purchases is
also available on the status screen. Account epochs fence submission and feedback;
pending payments wait for approval; the store transaction finishes only after
backend completion succeeds. Historical subscription identifiers are retained
independently of current sale availability or store product lookup.

Store recovery requires an EAS development or release build with billing enabled;
Expo Go cannot verify it. Legacy identifiers retained for reconciliation:

- Apple: `kilopass.tier19.monthly.v1`, `kilopass.tier49.monthly.v1`,
  `kilopass.tier199.monthly.v1`
- Play: `kilopass_tier19`, `kilopass_tier49`, `kilopass_tier199`

Release notes for 1.0.15: remove subscription sales while preserving paid benefits,
legacy receipt recovery, and one-off credit purchases. `CHANGELOG.md` remains
release-generated: `scripts/kilo-app-release-notes.mjs` adds this merged PR after an
actual store submission supplies its build identity. This change does not submit
a release, raise minimum versions, or retire store renewals.

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
