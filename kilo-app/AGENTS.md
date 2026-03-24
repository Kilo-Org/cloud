# AGENTS.md

## What This Is

Kilo App is an Expo (React Native) mobile application using Expo Router for file-based routing. It lives as a subpackage (`kilo-app/`) in the `cloud` monorepo.

## Tech Stack

- **Framework**: Expo SDK 55, React Native, React 19
- **Routing**: Expo Router (file-based, `src/app/`)
- **Language**: TypeScript (strict mode, `tsgo`)
- **Styling**: NativeWind v5 (Tailwind CSS v4) — docs: https://www.nativewind.dev/v5/llms-full.txt
- **UI Components**: [React Native Reusables](https://reactnativereusables.com/) (shadcn/ui for React Native) in `src/components/ui/`
- **Linting**: ESLint 9 flat config with strict type-checked rules, unicorn, sonarjs, import-x, promise, react-native
- **Formatting**: oxfmt

## Environment Setup

Follow the official Expo guide to set up the development environment: https://docs.expo.dev/get-started/set-up-your-environment/

The dev server (`pnpm start`) is always started by the user — do not start it yourself.

## Commands

```bash
pnpm typecheck       # tsgo --noEmit
pnpm lint            # expo lint (eslint)
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

## Code Style

- Expo Router requires default exports in `src/app/` — this is the only place default exports are allowed.
- Prefer `type` over `interface`.
- Import `View`, `Text`, `ScrollView`, `Pressable`, `TextInput` from `react-native` — NativeWind's Metro plugin rewrites these imports to add `className` support automatically.
- Import `Image` from `@/components/ui/image` (a `styled` wrapper around `expo-image`). Lint enforces this.
- For UI components (Button, Text with variants, Card, etc.), import from `@/components/ui/<component>`. These are from react-native-reusables (shadcn/ui for RN).
- Add new UI components with `pnpm dlx @react-native-reusables/cli@latest add <component> --styling-library nativewind -y`. Then fix import ordering and any lint issues in the generated file.
- The `cn()` helper for merging Tailwind classes is in `@/lib/utils`.
- Design tokens (colors, radii) are CSS variables in `src/global.css` with `@theme inline` for Tailwind v4. The theme uses shadcn/ui neutral palette with light/dark via `prefers-color-scheme`.
- Style components with Tailwind utility classes via `className`. No inline styles or `StyleSheet.create`.
- All lint rules are set to `error`, not `warn`. Fix violations, don't suppress them.

## Fixing Lint Errors

When resolving lint errors, always try the autofix first before editing manually:

```bash
npx eslint --fix <file-or-directory>
```

Only hand-fix errors that `--fix` cannot resolve.

## Change Checklist

Before pushing, run all checks and fix any issues:

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm check:unused
```

- Do not suppress lint rules without justification.
- Keep route files in `src/app/` thin — extract logic into `src/components/` or `src/hooks/`.
