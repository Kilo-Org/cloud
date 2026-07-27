# Kilo App Agent Guide

## Scope

Expo Router app for iOS and Android only. Use dev builds, never Expo Go. No web-specific code.

- Backend, simulator, login, Maestro, remote CLI, logs, cleanup: follow [e2e/AGENTS.md](e2e/AGENTS.md). Start what you need yourself; never ask the user to start Metro or backend services.
- Substantial mobile work: follow [.kilo/MOBILE_WORKFLOW.md](.kilo/MOBILE_WORKFLOW.md). Plans may require edits to backend, shared packages, infrastructure, or sibling repositories; that is in scope.

## Stack

- Expo SDK 55, React Native 0.83, React 19, strict TypeScript (`tsgo`)
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
- Use `defaultValue` only for initial content. Set an explicit Tailwind line height.
- Put input screens in a `ScrollView` with `automaticallyAdjustKeyboardInsets`.

## UI and UX Rules

- `ScreenHeader` is the first child of the screen root; set stack `headerShown: false`.
- Prefer native sheets, alerts, pickers, gestures, and keyboard behavior. Confirm destructive actions with `Alert.alert()`.
- Every pressable gives lightweight feedback unless navigation or a native control already provides it.
- Every data screen handles loading, empty, error, and happy states. Use `Skeleton` matching final dimensions, `EmptyState`, and pagination when results can grow.
- Use `ActivityIndicator` only for inline waits. Where layout would jump, use the existing Reanimated `FadeIn`/`FadeOut`/`LinearTransition` patterns.
- Set `freezeOnBlur: true` on tabs. Use haptics for commits and outcomes only, never passive interaction.
- Set `transition={0}` on small or header `expo-image` images to avoid flicker.

## Debugging

Add narrow temporary logs at the real boundaries. Reproduce. Read the tmux service logs. Fix the demonstrated cause. Remove the logs. Do not guess, and do not commit debug logging.
