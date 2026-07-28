# mobile: deep-linking an app route via the exp+kilo-app dev-client URL fails; use the kiloapp scheme

Symptom: `xcrun simctl openurl <udid> "exp+kilo-app://expo-development-client/?url=http%3A%2F%2F<ip>%3A<metro-port>%2Fpr-review"` lands on the dev client error screen "There was a problem loading the project. Failed to load app from http://<ip>:<port>/pr-review".

Cause: the dev client treats the entire `url` param as the Metro packager root; a route path appended to it makes the manifest fetch 404. The dev client does not parse app routes out of the packager URL (Expo SDK 54 dev client, iOS).

Fix: two-step navigation: (1) connect with the BARE Metro URL (`...?url=http%3A%2F%2F<ip>%3A<port>`), wait for `iOS Bundled`; (2) `xcrun simctl openurl <udid> "kiloapp://<route>"` (app scheme `kiloapp`, no SpringBoard confirmation). In a Maestro flow use `openLink: kiloapp://<route>` — but only after the app has finished cold-booting (gate on a restored-route element first; an openLink fired during boot is dropped).
