# AGENTS.md

## Purpose

`apps/prototypes` is an opt-in workspace app for Kilo Code full-page and product-flow UI prototypes. Keep experiments out of the production web router while reusing production web theme tokens and UI primitives.

## Commands

Run prototype checks explicitly:

```bash
pnpm --filter @kilocode/prototypes dev
pnpm --filter @kilocode/prototypes build
pnpm --filter @kilocode/prototypes typecheck
```

Do not wire this app into root `build`, root `validate`, or default CI unless a future task explicitly changes that policy.

## Import boundaries

- `@/*` resolves to `apps/prototypes/src/*` for prototype-local code.
- `@web/*` resolves to `apps/web/src/*` for production web theme, primitives, and product UI.

Prefer prototype-local code for catalog/discovery and review-shell utilities. Keep domain-specific prototype data and preview components colocated with the route that owns them.

## Folder conventions

- Add prototype routes as `src/app/<prototype-slug>/page.tsx`.
- Add optional route metadata beside the page when catalog copy/tags are needed.
- Keep fixtures, client wrappers, and preview components inside the route folder unless another prototype proves the abstraction reusable.
- Shared prototype-kit primitives belong in `src/` outside app route folders.

## Storybook boundary

Storybook is for individual component states. This app is for full-page prototypes, page-flow reviews, and product-context explorations.
