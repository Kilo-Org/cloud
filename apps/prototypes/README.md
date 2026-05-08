# Kilo Code Prototypes

`apps/prototypes` is an opt-in Next.js app for full-page and product-flow UI explorations. It lets design-review prototypes live outside the production web router while reusing the production web theme and UI primitives.

Storybook remains the home for individual component states. Use this app when a prototype needs page chrome, multiple sections, route-level behavior, navigation experiments, or a product-flow review surface.

## Commands

Run commands explicitly; the root `build`, `validate`, and default CI flows do not include this app.

```bash
pnpm --filter @kilocode/prototypes dev
pnpm --filter @kilocode/prototypes build
pnpm --filter @kilocode/prototypes typecheck
```

## Import aliases

- `@/*` points to prototype-local source in `apps/prototypes/src/*`.
- `@web/*` points to production web source in `apps/web/src/*`.

Use `@/*` for prototype host code, discovery, catalog, and shared prototype-kit utilities. Use `@web/*` only when importing production web theme, primitives, or existing product UI needed to keep a prototype faithful.

## Folder conventions

- Prototype routes live under `src/app/<prototype-slug>/`.
- Keep prototype-specific fixtures, role logic, preview components, and metadata colocated with that route.
- Shared prototype-host utilities live under `src/` outside route folders.
- Do not introduce a central manifest until multiple durable prototypes prove the need.

## Storybook boundary

Use Storybook for isolated component variants and visual states. Use `apps/prototypes` for app-like flows, full pages, route sequences, and design reviews that need surrounding product context.
