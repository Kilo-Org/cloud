# mobile: RN BackHandler ignores the event-name string — any registered handler fires on hardware back

Symptom: static analysis concludes an Android component's hardware-back handling is broken because it registers `BackHandler.addEventListener('<some-custom-name>', handler)` instead of the documented `'hardwareBackPress'` name.

Cause: on RN 0.86 (`apps/mobile/node_modules/react-native/Libraries/Utilities/BackHandler.android.js:86-101`), `addEventListener` ignores the event-name argument entirely — every registered handler is pushed into one `_backPressSubscriptions` array, and the native `hardwareBackPress` event invokes ALL of them in reverse registration order (lines 23-37), first `true` return wins. The name string is inert. Example verified in this repo: `@expo/react-native-action-sheet@4.1.1`'s default (non-Modal) sheet registers `'actionSheetHardwareBackPress'` and DOES dismiss on hardware back.

Fix: never judge Android back-button wiring by the registered name string; a handler registered under any name fires. Verify behavior on device (E2E), not by reading the call site. (The type-level name `'backPress' | 'hardwareBackPress'` is only documentation.)
