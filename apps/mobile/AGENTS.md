# Kilo App Agent Guide

## Scope

Expo Router app for iOS and Android only. Use dev builds, never Expo Go. No web-specific code.

- Start the backend and Metro yourself; never ask the user to start them.
- Substantial mobile work may require edits to backend, shared packages, infrastructure, or sibling repositories; that is in scope.

## Stack

- Expo SDK 57, React Native 0.86, React 19, strict TypeScript (`tsgo`)
- NativeWind v5 / Tailwind CSS v4; React Native Reusables in `src/components/ui/`
- Expo Router routes in `src/app/`
- oxlint and oxfmt

## Commands

Run from `apps/mobile/`: `pnpm typecheck`, `pnpm lint`, `pnpm format` (or `format:check`), `pnpm check:unused`, `pnpm test`.

Before pushing:

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm check:unused
git diff --check
```

- Fix lint rules in spirit: autofix first, then extract code. Never compress code to dodge line limits.
- Do not commit plans, specs, or other non-code Markdown files.
- The repository dev runner owns Metro. Never run `pnpm start`.

## Dependencies

- Install with `npx expo install <package>` (or `--dev`), never `pnpm add`.
- After dependency changes, run `pnpx expo-doctor` and fix every issue.
- `@kilocode/kilo-chat-hooks` is copied, not symlinked. After editing it:

  ```bash
  pnpm install --filter kilo-app...
  rm -rf "$TMPDIR/metro-cache" "$TMPDIR"/metro-file-map-*
  ```

  Then restart Metro and force-quit the app.

## Library First

Before you build a UI element, find the library that already does it.

1. Check the element map below. If the concern has an entry, use that element.
2. Check `@expo/ui` (`node_modules/@expo/ui/build/`), which ships native modules for `57.x`: universal
   `BottomSheet`, `Picker`, `Switch`, `TextInput`, `List`, `Host`, plus
   `community/{segmented-control, picker, datetime-picker, masked-view, menu, pager-view, slider}`.
3. Check the Expo SDK 57 docs for the concern.
4. Check npm for a maintained package. A release in the last six months is the bar.

A hand-built element is correct only when steps 1–4 fail. Record the decision in the PR body: the library
and version you chose, or which candidates you rejected and why. "It was easier to write it" is not a
reason.

## Unified Elements

One element per concern. `no-restricted-imports` in `.oxlintrc.json` enforces the "Use instead" column.

| Concern | Element | Use instead of |
|---|---|---|
| Bottom sheet, imperative / non-route | `Sheet` from `@/components/ui/sheet` | `Modal` from `react-native`, `@gorhom/bottom-sheet`, `react-native-modal`, `react-native-modalize` |
| Bottom sheet, route | expo-router `formSheet` via `useFormSheetScreenOptions()` | a JS bottom-sheet library |
| Confirm that needs the red affordance | `useConfirmDialog()` from `@/components/ui/dialog` (a native sheet) | `Alert.alert` for a destructive confirm; a direct `@rn-primitives/dialog` import |
| Dialog form (a field, a form) | `DialogCard` from `@/components/ui/dialog` | a direct `@rn-primitives/dialog` import |
| System confirm, non-destructive | `Alert.alert` | — |
| Keyboard avoidance | `react-native-keyboard-controller` | `KeyboardAvoidingView` from `react-native` |
| Lists | `@shopify/flash-list` | `FlatList`, `VirtualizedList`, `SectionList`, `@legendapp/list` |
| Image viewer | `@/components/ui/image-viewer` | `react-native-image-viewing`, `react-native-awesome-gallery` |
| Video | `expo-video` | `react-native-video`, `expo-av` |
| Toast | `sonner-native` | `react-native-toast-message`, `burnt` |
| Images | `@/components/ui/image` | `Image` from `react-native`, `expo-image` |
| Icons | `@/components/ui/icons` | `lucide-react-native` |
| Markdown | `@/components/markdown/markdown-text` | `react-native-markdown-display` |

No file imports `Modal` from `react-native`, `@expo/ui/community/bottom-sheet` or `@rn-primitives/dialog`
outside `@/components/ui/sheet` and `@/components/ui/dialog`. A sheet or a confirm must be able to stack
above another native sheet, and a dialog rendered through `@rn-primitives/portal` lives in the app's React
tree, so it cannot: `useConfirmDialog` therefore presents a native sheet, not a portal card. A `DialogCard`
is a portal card and stays behind a presented sheet — never open one from sheet content. When a surface
needs to stack and a form must host it, make it a `formSheet` route or a `Sheet`.

`ImageViewer` measures its viewport and gives the zoom child concrete dimensions.
Do not use percentage dimensions inside `ResumableZoom`'s unconstrained child container.
Use explicit pixel sizes for minimum touch targets; native rem is 14 points.
Use `TabScreenScrollView` for scrolling screens under the absolute tab bar.
Use a concrete height and `flex: 0` for an inline `FlashList`; `maxHeight` alone does not create a viewport.

Keyboard avoidance is `react-native-keyboard-controller`, wrapped in one `KeyboardProvider` at the app root.
`KeyboardAvoidingView` clears the IME on the session, history, quick-chat, session-detail, new-session,
conversation, manual-review and PR-discussion surfaces; `useKeyboardState` is the app's one keyboard-height read.
The conversation list follows the newest message when its viewport shrinks; it must not add a second keyboard inset.
A surface whose content
pads the platform's bottom inset itself passes `keyboardVerticalOffset={keyboardInsetOffset(bottom)}`
(`@/lib/keyboard-inset-offset`) — the provider's Android height spans the translucent navigation bar, so
without the reduction the content floats a navigation-bar height above the keyboard.

Nothing else may read the keyboard: no surface adds a listener beside the provider.

## Implementation Rules

- Write the smallest boring implementation. Reuse existing helpers, components, and contracts.
- Derive mobile types from shared exports or tRPC results. Do not copy shapes.
- Fetch backend data through tRPC. Zod-parse only genuinely untrusted HTTP input at entry; do not re-parse trusted tRPC or shared-package data in components.
- Parse backend dates with `parseTimestamp()` from `@/lib/utils`; `new Date()` breaks on PostgreSQL timestamps in Hermes.
- Every mutation hook shows `toast.error(error.message)` in `onError`. Put shared error handling in the hook, not in each component.
- Use optimistic updates for obvious reversible mutations: snapshot in `onMutate`, roll back in `onError`, reconcile in `onSettled`.
- Keep route files thin. Put screen logic in components or hooks.

## React Native Rules

- Default exports only where Expo Router requires them, in `src/app/`.
- Import React Native primitives from `react-native`; NativeWind adds `className`.
- Import `Image` from `@/components/ui/image` and other UI primitives from `@/components/ui/<component>`.
- Add reusables with `pnpm dlx @react-native-reusables/cli@latest add <component> --styling-library nativewind -y`.
- Style with Tailwind `className`. No inline styles, no `StyleSheet.create`. Merge classes with `cn()` from `@/lib/utils`.
- Opacity modifiers do not work on theme colors (CSS variables): `bg-destructive/10` fails. Use a concrete Tailwind color with a dark variant. Non-variable colors like `bg-black/5` are fine.
- Type dynamic Expo Router paths as `Href`. Never silence route types with `as never`.
- Use Lucide icons, never emoji. Color icons with `color={colors.<token>}` from `useThemeColors()`; `className` colors do not work on them.

### Text inputs

- iOS: never control text with `value` plus state. Store text in a ref via `onChangeText`, use state only for derived UI, read the ref on submit.
- Use `defaultValue` only for initial content.
- Single-line inputs: use `leading-[normal]`. A `lineHeight` above the font's natural one (which `text-sm`/`text-base` set on their own) makes iOS draw the placeholder lower than the typed text and clip it. Multi-line inputs keep an explicit `leading-*`.
- Single-line inputs: set the height with `min-h-*`, not `py-*`. iOS insets the already-centered text rect by the padding, so vertical padding draws the text and the placeholder low.
- Use the shared `Input` for every single-line field.
- `Input` removes vertical padding, centers Android text, and defaults iOS line breaks to `clip`.
- A single-line caller can change horizontal padding, text size, and minimum height.
- A multiline caller keeps its alignment and line breaks; its padding classes override the shared physical inset.
- Multiline defaults use `pl-3 pr-3 pt-2.5 pb-2.5`; Android `TextInput` does not apply logical `paddingInline`.
- Put input screens in a `ScrollView` with `automaticallyAdjustKeyboardInsets`.

## UI and UX Rules

- `ScreenHeader` is the first child of the screen root; set stack `headerShown: false`.
- Prefer native sheets, alerts, pickers, gestures, and keyboard behavior. Confirm a non-destructive action with `Alert.alert()`. Confirm a destructive action with `@/components/ui/dialog`, because Android's native `AlertDialog` drops the `style: 'destructive'` affordance.
- Every pressable gives lightweight feedback unless navigation or a native control already provides it.
- Every data screen handles loading, empty, error, and happy states. Use `Skeleton` matching final dimensions, `EmptyState`, and pagination when results can grow.
- Use `ActivityIndicator` only for inline waits. Where layout would jump, use the existing Reanimated `FadeIn`/`FadeOut`/`LinearTransition` patterns.
- Set `freezeOnBlur: true` on tabs. Use haptics for commits and outcomes only, never passive interaction.
- Set `transition={0}` on small or header `expo-image` images to avoid flicker.

## Translations

Copy lives in `src/i18n/locales/en.json`. The other 86 catalogs are reviewed
against the screens their keys render on, so a key's name and its context are
what a translator has to work from.

- Add and edit copy in `en.json` only. Never hand-edit another catalog.
- Search `en.json` for the string before you add a key. If the copy already
  exists, reuse that key. `pnpm check:i18n` fails when two keys hold the same copy.
- Put copy used by more than one section under `common.`.
- Name a label with `$t(other.key)`; never spell an English label inside another
  message, or every catalog quotes a button the reader never sees.
- Keep the `{{placeholder}}` set identical to English. Word order around a
  placeholder is the translator's to change, so never assume English order.
- Case follows the English copy, and only in a language that has case. Georgian
  Mkhedruli has none, and Greek keeps the tonos on a capital initial and drops
  it only in full capitals.
- Name a key for what the string is, not for the one screen that shows it first.
- If one English word truly needs two senses, add it to `TWO_SENSE_COPY` in
  `tools/i18n/check-catalogs.mjs` and record both senses there.
- Run `pnpm check:i18n` after you touch copy.

## Design

The app follows https://github.com/Kilo-Org/kilo-design/ in general, except where this file states otherwise.

## Debugging

Add narrow temporary logs at the real boundaries. Reproduce. Read the tmux service logs. Fix the demonstrated cause. Remove the logs. Do not guess, and do not commit debug logging.
