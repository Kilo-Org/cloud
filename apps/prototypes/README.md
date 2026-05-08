# Kilo Code Prototypes

`apps/prototypes` is an opt-in Next.js app for full-page and product-flow UI explorations. It lets design-review prototypes live outside the production web router while reusing the production web theme and UI primitives.

Storybook remains the home for individual component states. Use this app when a prototype needs page chrome, multiple sections, route-level behavior, navigation experiments, or a product-flow review surface.

## Commands

Run commands explicitly; the root `build`, `validate`, and default CI flows do not include this app.

```bash
pnpm --filter @kilocode/prototypes dev
pnpm --filter @kilocode/prototypes build
pnpm --filter @kilocode/prototypes typecheck
pnpm --filter @kilocode/prototypes test
pnpm --filter @kilocode/prototypes validate:routes
pnpm --filter @kilocode/prototypes validate
```

## Prototype host contract

The root layout uses a prototype-host module for metadata, viewport, font variable composition, and the production web theme contract. The theme source is the production web globals stylesheet (`@web/app/globals.css`) so prototypes stay visually faithful to production UI without redefining tokens.

The Next config sets output tracing and Turbopack roots to the monorepo root because the app intentionally imports production web source. Keep that setup local to this opt-in package; do not enroll prototypes in root build, root validate, or default CI unless a future task explicitly changes the policy.

## Import aliases

- `@/*` points to prototype-local source in `apps/prototypes/src/*`.
- `@web/*` points to production web source in `apps/web/src/*`.

Use `@/*` for prototype host code, discovery, catalog, shared prototype-kit utilities, and production web component bridges. Prototype routes should import UI primitives and shared visual modules through prototype-local seams such as `@/components/ui/*`, `@/components/shared/*`, or `@/components/KiloCrabIcon`; the bridge files own direct `@web/components/*` imports. Use direct `@web/*` imports only for non-component production web contracts such as the shared theme stylesheet.

## Folder conventions

- Prototype routes live under `src/app/<prototype-slug>/`.
- Run `pnpm --filter @kilocode/prototypes validate:routes` to check route folder shape and metadata before review. Run `pnpm --filter @kilocode/prototypes validate` for the full opt-in prototype framework gate.
- Keep prototype-specific fixtures, role logic, preview components, and metadata colocated with that route.
- Shared prototype-host utilities live under `src/` outside route folders.
- Do not introduce a central manifest until multiple durable prototypes prove the need.

## Storybook boundary

Use Storybook for isolated component variants and visual states. Use `apps/prototypes` for app-like flows, full pages, route sequences, and design reviews that need surrounding product context.
