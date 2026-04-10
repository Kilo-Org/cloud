# AGENTS.md

## What This Is

Kilo App is an Expo (React Native) mobile application using Expo Router for file-based routing. It lives as a subpackage (`apps/mobile/`) in the `cloud` monorepo. **This app targets iOS and Android only — never web.** Do not add `Platform.select({ web: ... })` patterns or web-specific code. **We use dev builds, not Expo Go.**

## Tech Stack

- **Framework**: Expo SDK 55, React Native, React 19
- **Routing**: Expo Router (file-based, `src/app/`)
- **Language**: TypeScript (strict mode, `tsgo`)
- **Styling**: NativeWind v5 (Tailwind CSS v4) — docs: https://www.nativewind.dev/v5/llms-full.txt
- **UI Components**: [React Native Reusables](https://reactnativereusables.com/) (shadcn/ui for React Native) in `src/components/ui/`
- **Linting**: oxlint with type-aware rules, unicorn, react-native (jsPlugin), import, promise
- **Formatting**: oxfmt

## Environment Setup

Follow the official Expo guide to set up the development environment: https://docs.expo.dev/get-started/set-up-your-environment/

The dev server (`pnpm start`) is always started by the user — do not start it yourself.

## Commands

```bash
pnpm typecheck       # tsgo --noEmit
pnpm lint            # oxlint
pnpm format          # oxfmt src
pnpm format:check    # oxfmt --list-different src
pnpm check:unused    # knip (unused exports/deps)
```

## Installing Dependencies

Always use `npx expo install` to add packages — it resolves versions compatible with the current Expo SDK. Do not use `pnpm add` directly.

```bash
npx expo install <package-name>
npx expo install --dev <package-name>   # devDependencies
```

After installing or upgrading dependencies, run `pnpx expo-doctor` and fix any issues it reports (version mismatches, duplicate deps, etc.).

## Data Fetching

- When you need data from the backend, **always add a new tRPC procedure** rather than copying data or inventing client-side alternatives. The app uses tRPC with React Query — adding a procedure is cheap and keeps the source of truth on the server.
- When a component takes backend data as props, derive the prop types from the tRPC router's return types (e.g., `NonNullable<ReturnType<typeof useMyQuery>['data']>`) instead of manually copying type definitions. This keeps types in sync with the backend automatically.
- **Never use `new Date()` on any date or timestamp string from the backend.** Hermes cannot reliably parse PostgreSQL timestamps (`2026-03-13 14:30:00+00`) or date-only strings (`2026-09-26`). Always use `parseTimestamp()` from `@/lib/utils` — it handles both formats.

### Mutations

- Every mutation must include an `onError` handler that shows a toast (`toast.error(error.message)` via `sonner-native`). Silent failures are not acceptable — users must always see feedback when something goes wrong.
- Centralize `onError` in the mutation hook (e.g., `useKiloClawMutations`) rather than in individual components. Components can add their own `onSuccess` callbacks via `mutate(input, { onSuccess })` for UI-specific behavior (e.g., closing a form, clearing fields).
- **Use optimistic updates where possible** — they make the app feel instant. Use React Query's `onMutate` to optimistically update the cache, return the previous value for rollback, restore it in `onError`, and invalidate in `onSettled` to reconcile with the server. Good candidates: toggles, model selection, renaming, any mutation where the expected result is obvious from the input.
- For screens with text inputs, use `ScrollView` with `automaticallyAdjustKeyboardInsets` to keep inputs visible above the keyboard. No external keyboard library needed — the native iOS prop works smoothly.

### TextInput on iOS

- **Never use controlled `value` prop for text inputs on iOS.** The `value` + `onChangeText` + `setState` pattern causes a re-render on every keystroke, which creates a race condition with the native input — fast typing results in transposed characters and cursor jumping. Use `onChangeText` with a ref (`useRef`) to store values, and only use state for derived booleans (e.g., `canSave`) that gate UI. Read from the ref when submitting.
- Use `defaultValue` only if the input needs an initial value. Omit both `value` and `defaultValue` for empty inputs.
- Set explicit `leading-*` (line height) on TextInput to prevent height jumps when typing begins.

## Code Style

- Expo Router requires default exports in `src/app/` — this is the only place default exports are allowed.
- Prefer `type` over `interface`.
- Import `View`, `Text`, `ScrollView`, `Pressable`, `TextInput` from `react-native` — NativeWind's Metro plugin rewrites these imports to add `className` support automatically.
- Import `Image` from `@/components/ui/image` (a `styled` wrapper around `expo-image`). Lint enforces this.
- For UI components (Button, Text with variants, Card, etc.), import from `@/components/ui/<component>`. These are from react-native-reusables (shadcn/ui for RN).
- Add new UI components with `pnpm dlx @react-native-reusables/cli@latest add <component> --styling-library nativewind -y`. Then fix import ordering and any lint issues in the generated file.
- The `cn()` helper for merging Tailwind classes is in `@/lib/utils`.
- Design tokens (colors, radii) are CSS variables in `src/global.css` with `@theme inline` for Tailwind v4. The theme uses shadcn/ui neutral palette with light/dark via `prefers-color-scheme`.
- **The Tailwind `/opacity` modifier does NOT work with CSS-variable-based theme colors** (e.g., `bg-destructive/10`, `bg-foreground/20`, `border-muted-foreground/30`). Our theme defines colors as `hsl(var(--name))`, so Tailwind can't decompose them to inject an alpha channel. The result is the opacity is silently ignored. Use hardcoded Tailwind colors with dark: variants instead (e.g., `bg-neutral-200 dark:bg-neutral-700`). The `/opacity` modifier works fine with non-variable colors like `bg-black/5` or `bg-red-500/20`.
- Style components with Tailwind utility classes via `className`. No inline styles or `StyleSheet.create`.
- All lint rules are set to `error`, not `warn`. Fix violations, don't suppress them.
- `as never` is a code smell — it silences all type checking. For Expo Router dynamic paths, use `as Href` instead (import `Href` from `expo-router`). If you find yourself needing `as never`, the types are wrong and need fixing.

## UX Patterns

### Icons

- Use `lucide-react-native` for all icons. Never use emoji as UI elements.
- Lucide icons on native do NOT support `className` for color. Always use the `color` prop with resolved color strings from `useThemeColors()`: `<Icon size={18} color={colors.foreground} />`.

### Navigation Headers

- **Always use `ScreenHeader`** (`src/components/screen-header.tsx`) instead of native stack headers. Set `headerShown: false` on all Stack navigators.
- `ScreenHeader` auto-detects whether a back button is needed via `router.canGoBack()` — no manual configuration required.
- Place `ScreenHeader` as the first child inside the screen's root `View`, above any `ScrollView`. The header handles safe area insets and should not scroll with content.
- Pass optional `headerRight` for action buttons (e.g., profile avatar on tab root screens).

### Loading States

- Never show bare "Loading..." text. Use the `Skeleton` component (`src/components/ui/skeleton.tsx`) for shimmer placeholders.
- **Match skeleton dimensions exactly** to the loaded content (e.g., if a button is `h-11 rounded-md`, the skeleton should be `h-11 rounded-md`). Mismatched heights cause layout shift.
- Use `ActivityIndicator` from `react-native` for inline spinners (e.g., waiting for an API call to initiate).

### Animations & Reducing Layout Shift

- `react-native-reanimated` is available. Use `FadeIn`/`FadeOut` entering/exiting animations to smooth state transitions (e.g., login states, content loading).
- Use `LinearTransition` (not the deprecated `Layout`) on container `Animated.View` to animate height changes when children appear/disappear (e.g., skeleton → loaded content).
- Wrap each dynamically appearing item in `<Animated.View entering={FadeIn.duration(200)}>` to fade in instead of popping.
- **Skeleton → content swap pattern**: Wrap skeletons in `<Animated.View exiting={FadeOut.duration(150)}>` and loaded items in `<Animated.View entering={FadeIn.duration(200)}>`, with `LinearTransition` on the parent container. This gives a smooth crossfade with no jump.

### Empty States

- Use the `EmptyState` component (`src/components/empty-state.tsx`) for screens with no data. It takes a Lucide icon, title, and description.

### Confirmations

- Use native `Alert.alert()` for destructive confirmations (e.g., sign out). It renders the platform alert dialog — no JS-based modal needed.

### Tabs

- Set `freezeOnBlur: true` on tab `screenOptions` to prevent re-render flicker when switching tabs.
- Use `expo-haptics` (`Haptics.selectionAsync()`) on tab press and interactive buttons for tactile feedback.

### Images

- When using `expo-image` in headers or small UI elements, set `transition={0}` to disable the default fade-in which causes flicker.

## Fixing Lint Errors

Follow lint rules **in spirit, not literally**. The goal is better code, not just silencing the linter. For example, if a max-lines rule fires:

- **Good**: Refactor the file, break it into smaller files, extract components/hooks.
- **Bad**: Reformat code (we have a formatter), delete empty lines, "compress" or "compact" code, or otherwise mangle formatting to circumvent the limit. Always extract related blocks to separate files instead.
- If a file has a legitimate reason to exceed 300 lines (e.g., closely related hooks that belong together), disable the rule for that file with `/* eslint-disable max-lines */` rather than forcing an artificial split.

When resolving lint errors, try the autofix first before editing manually:

```bash
pnpm -w exec oxlint --config apps/mobile/.oxlintrc.json --fix apps/mobile/src
```

Only hand-fix errors that `--fix` cannot resolve.

## Debugging

When debugging reproducible issues, don't guess at the cause. Instead:

1. Add temporary `console.log` statements that capture the relevant state at key points (function entry, state changes, branch decisions, etc.).
2. Ask the user to reproduce the issue and paste the logs.
3. Deduce the root cause from the log output, then fix it.
4. Remove the debug logs before committing.

This is far more effective than speculating about the cause.

## Change Checklist

Before pushing, run all checks and fix any issues:

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm check:unused
```

- Do not suppress lint rules without justification.
- Keep route files in `src/app/` thin — extract logic into `src/components/` or `src/hooks/`.
- Never commit plans, specs, design docs, or other non-code markdown files to this repo.
