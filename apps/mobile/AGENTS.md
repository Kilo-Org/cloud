# Kilo App Agent Guide

## Scope

Expo Router app for iOS and Android only. Use dev builds, never Expo Go, and do not add web-specific code.

For a fresh-worktree backend, simulator, login, Maestro, remote CLI, logs, and cleanup workflow, follow [e2e/AGENTS.md](e2e/AGENTS.md). Agents may start what they need there; do not ask the user to start Metro or backend services.

For substantial mobile work, follow the orchestrated implement-review-E2E loop in [.kilo/MOBILE_WORKFLOW.md](.kilo/MOBILE_WORKFLOW.md). Its mobile role agents may change backend, shared-package, infrastructure, or sibling CLI code when the accepted plan requires it; mobile describes the product workflow, not a directory boundary.

## Stack

- Expo SDK 55, React Native 0.83, React 19, strict TypeScript (`tsgo`)
- NativeWind v5 / Tailwind CSS v4; React Native Reusables in `src/components/ui/`
- Expo Router routes in `src/app/`
- oxlint and oxfmt

## Commands

Run from `apps/mobile/`:

```bash
pnpm typecheck
pnpm lint
pnpm format
pnpm format:check
pnpm check:unused
pnpm test
```

The repository dev runner owns Metro during E2E work. Do not also run `pnpm start`.

## Dependencies

Use `npx expo install <package>` (or `--dev`), never `pnpm add`. After dependency changes, run `pnpx expo-doctor` and fix every issue.

`@kilocode/kilo-chat-hooks` is injected rather than symlinked. After editing it, refresh the copy and Metro cache:

```bash
pnpm install --filter kilo-app...
rm -rf "$TMPDIR/metro-cache" "$TMPDIR"/metro-file-map-*
```

Then restart Metro and force-quit the app.

## Implementation Rules

- Prefer the smallest boring implementation. Reuse existing helpers, components, contracts, and native platform behavior.
- Keep shared contracts at their owning boundary. Derive mobile types from shared exports or tRPC results rather than copying shapes.
- Fetch backend data through tRPC. Parse genuinely untrusted HTTP input with Zod at entry; do not re-parse trusted tRPC/shared-package data in components.
- Parse backend dates with `parseTimestamp()` from `@/lib/utils`; Hermes cannot reliably parse PostgreSQL timestamps with `new Date()`.
- Every mutation hook must show `toast.error(error.message)` in `onError`. Put shared error handling in the hook, not each component.
- Use optimistic updates for obvious reversible mutations: snapshot in `onMutate`, roll back in `onError`, reconcile in `onSettled`.
- Keep route files thin. Extract screen logic to components or hooks.

## React Native Rules

- Default exports are allowed only where Expo Router requires them in `src/app/`.
- Import React Native primitives from `react-native`; NativeWind adds `className` support.
- Import `Image` from `@/components/ui/image` and other UI primitives from `@/components/ui/<component>`.
- Add reusables with `pnpm dlx @react-native-reusables/cli@latest add <component> --styling-library nativewind -y`.
- Style with Tailwind `className`, not inline styles or `StyleSheet.create`. Merge classes with `cn()` from `@/lib/utils`.
- Theme colors are CSS variables. Opacity modifiers such as `bg-destructive/10` do not work on them; use a concrete Tailwind color with a dark variant. Non-variable colors such as `bg-black/5` are fine.
- Use `Href` for dynamic Expo Router paths. Never silence route types with `as never`.
- Use Lucide icons, not emoji. Set icon colors with `color={colors.<token>}` from `useThemeColors()`; native Lucide icons do not resolve `className` colors.

### Text inputs

- On iOS, do not control text with `value` plus state. Store text in a ref via `onChangeText`, use state only for derived UI, and read the ref on submit.
- Use `defaultValue` only for initial content and set an explicit Tailwind line height.
- Put input screens in a `ScrollView` with `automaticallyAdjustKeyboardInsets`.

## UI and UX Invariants

- Use `ScreenHeader` as the first child of a screen root and set stack `headerShown: false`.
- Prefer native sheets, alerts, pickers, gestures, and keyboard behavior. Use `Alert.alert()` for destructive confirmation.
- Every pressable needs lightweight feedback unless navigation or a native control already provides it.
- Data screens must handle loading, empty, error, and happy states. Use `Skeleton` matching final dimensions, `EmptyState`, and pagination when results can grow.
- Use `ActivityIndicator` only for inline waits. Smooth dynamic swaps with existing Reanimated `FadeIn`, `FadeOut`, and `LinearTransition` patterns where layout would otherwise jump.
- Set `freezeOnBlur: true` on tabs. Use haptics for commits/outcomes, not passive interaction or duplicate feedback.
- Set `transition={0}` on small/header `expo-image` images to avoid flicker.

## Debugging

For reproducible bugs, add narrow temporary logs at the real boundaries, reproduce, inspect the relevant tmux service logs, fix the demonstrated cause, and remove the logs. Do not guess or leave debug logging committed.

## Before Pushing

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm check:unused
```

Run `git diff --check`. Fix lint rules in spirit; use autofix before hand edits and extract code instead of compressing it to evade line limits. Do not commit plans, specs, or other non-code Markdown files.
