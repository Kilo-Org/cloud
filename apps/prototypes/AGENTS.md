# AGENTS.md

## Purpose

`apps/prototypes` is an opt-in workspace app for Kilo Code full-page and product-flow UI prototypes. Keep experiments out of the production web router while reusing production web theme tokens and UI primitives.

## Commands

Run prototype checks explicitly:

```bash
pnpm --filter @kilocode/prototypes dev
pnpm --filter @kilocode/prototypes build
pnpm --filter @kilocode/prototypes typecheck
pnpm --filter @kilocode/prototypes test
pnpm --filter @kilocode/prototypes validate:routes
pnpm --filter @kilocode/prototypes validate
```

Do not wire this app into root `build`, root `validate`, or default CI unless a future task explicitly changes that policy.

## Prototype host contract

Root layout metadata, viewport, font variable composition, and production web theme ownership belong to the prototype-host module. The layout still imports `@web/app/globals.css` as the concrete theme stylesheet, matching the host contract.

The Next config sets output tracing and Turbopack roots to the monorepo root because this opt-in package imports production web source. Keep those assumptions package-local and do not add the app to root validation by default.

## Import boundaries

- `@/*` resolves to `apps/prototypes/src/*` for prototype-local code.
- `@web/*` resolves to `apps/web/src/*` for production web theme, primitives, and product UI.

Prefer prototype-local code for catalog/discovery and review-shell utilities. Prototype routes import production web UI primitives and shared visual modules through prototype-local seams such as `@/components/ui/*`, `@/components/shared/*`, or `@/components/KiloCrabIcon`; only those bridge files should import `@web/components/*` directly. Keep domain-specific prototype data and preview components colocated with the route that owns them.

## Folder conventions

- Add prototype routes as `src/app/<prototype-slug>/page.tsx`.
- Run `pnpm --filter @kilocode/prototypes validate:routes` to check route folder shape and metadata before review. Run `pnpm --filter @kilocode/prototypes validate` for the full opt-in prototype framework gate.
- Add optional route metadata beside the page when catalog copy/tags are needed.
- Keep fixtures, client wrappers, and preview components inside the route folder unless another prototype proves the abstraction reusable.
- Shared prototype-kit primitives belong in `src/` outside app route folders.

## Storybook boundary

Storybook is for individual component states. This app is for full-page prototypes, page-flow reviews, and product-context explorations.
