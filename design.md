# Kilo Cloud — Design Recommendations

## 1. Primary CTAs should be brand yellow, not blue

The main call-to-action on any surface is the Kilo brand yellow-green (`#EDFF00`) with near-black text (`#1F1F1F`). Use it exactly once per surface for the primary action.

Blue is **not** a button background. Blue is a legacy inline-link role only. The current `ui/button` `primary` variant is hardcoded to blue (`#2B6AD2`) and should be migrated to yellow.

## 2. Monospace font should be Roboto Mono, not Geist Mono

Geist Mono is **not** loaded anywhere in this project. The app loads Roboto Mono via `next/font` and exposes it as `--font-mono`. All mono styling should resolve to Roboto Mono.

Any spec, reference, or documentation that says Geist Mono is wrong. Do not introduce Geist Mono without first wiring it through `next/font` in `apps/web/src/app/layout.tsx`.
