# mobile: app startup/consent unusable on tablet simulators (iPad + tablet AVD) — blocks tablet E2E login

Symptom (observed 2026-07-29, pr-review-d957, both surfaces on the same day):
- iPad Pro 11-inch (iOS 26.5): app boots to "Welcome to Kilo Code" but the consent body
  and `Accept and continue` button never enter the a11y tree (logo + title only, "1 page"
  scroll bars). `login.sh` and its cold-relaunch retry both fail — never reaches the email
  field.
- kilo_pixel_tablet_api35 (Android): after the dev-client deep link, the resumed
  MainActivity exposes NO app content (a11y tree = status bar only; screenshot pixels are
  mostly black + page-bg). Metro serves the Android bundle fine. force-stop + deep-link
  relaunch (the one supported recovery) does not recover.

The phone surfaces (iPhone 17 Pro iOS 26.5, kilo_pixel9_api35) work the same day, so this
is tablet-form-factor specific. The welcome/consent screen and startup are outside any
PR-review change area. Impact: tablet side-by-side regression checks (PR-review flow 9)
are environment-limited until app startup on tablets is fixed; do not classify PR-area
failures from tablet evidence until login works there.
