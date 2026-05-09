# KiloClaw subscribe flow — prototype notes

Single-file HTML prototype: `prototype.html`. Open it in any browser. No build step.

## What's in scope

A two-step subscribe modal that activates a KiloClaw hosted instance:

1. **Step 1 · Plan and size.** Pick Commit or Standard. Pick Good / Better / Best. Prices recompute live in both pickers.
2. **Step 2 · Payment.** Pick Kilo Credits or Card via Stripe. Real money math on the credits ledger; plain-language Stripe summary that names the hybrid-credit-ledger behavior from `kiloclaw-billing.md`.

Per-instance subscriptions per `Plans rule 5`. Instance name surfaces in the step 1 subtitle (`claw-prod-08`).

## What's intentionally out of scope

- Kilo Pass promotion in this flow (dropped per design discussion 2026-05-06).
- Trial UI. Trials are auto-bootstrapped at provisioning per spec; nothing to choose here.
- Real Stripe redirect.
- Real auth, real instance lookup.

## Pricing model encoded

| Size   | Specs                        | Standard | Commit  |
| ------ | ---------------------------- | -------- | ------- |
| Good   | 1 perf core · 3 GB · 10 GB   | $9/mo    | $8/mo   |
| Better | 4 perf cores · 8 GB · 20 GB  | $86/mo   | $76/mo  |
| Best   | 4 perf cores · 16 GB · 40 GB | $172/mo  | $152/mo |

- Standard first month = $4 (per `Subscription Checkout rule 5`, `Credit Enrollment rule 3`). Same value for both payment methods.
- Commit pays 6 months upfront (e.g. Best = $912 first period). No first-month discount on Commit per spec.
- "Save" line on Commit card is the dynamic per-month gap vs. Standard at the selected size. Bigger sizes save more.

## Demo controls (top-left)

| Toggle         | What it does                                                          |
| -------------- | --------------------------------------------------------------------- |
| Credit balance | $200 (covers any plan), $42 (covers Standard, not Commit), $0 (empty) |
| Re-open dialog | Resets to step 1 if you closed via X / Esc / overlay click            |

States to inspect:

- Sufficient credits → credits card primary, "Subscribe with credits" CTA.
- Insufficient credits for the selected plan → credits card disabled with reason and Top-up link, Stripe auto-selected, CTA flips to "Subscribe via card".
- Standard at $42 is sufficient (only $4 due first period); Commit Best at $42 is blocked ($912 due).

## Design decisions worth flagging

- **Color strategy: Restrained.** Yellow-green only on the active step pip, the selected card outline + soft fill, and the single primary CTA per step. No second yellow on screen.
- **Recap on step 2** is a tinted strip with mono pill values, not a "summary card". Less chrome.
- **Mono earns its place** on prices, specs, dates, balance ledger, and instance name. Inter elsewhere.
- **Step indicator** is two pips with a hairline divider; active is yellow, completed shows a tick. No progress bar.
- **Footer order** on desktop: ghost Cancel left, secondary Back (step 2 only), primary CTA right. Wraps to two rows on mobile so the primary stays full-width-tappable.
- **No em dashes.** Middle dot, period, or comma throughout, per impeccable shared bans.

## Implementation notes for the eventual production build

- Pricing matrix lives in JS at the top of the file (`PRICING` const) — wire that to whatever `BillingConfig` we expose to the web app.
- The Standard first-month logic is plan-level, not size-level (matches spec). When the spec changes, change `STANDARD_FIRST_MONTH` plus the `periodCost()` logic.
- The renewal date in the credits card is computed from `new Date()` plus the cadence. In production this should come from the server's `current_period_end` / credit renewal timestamp.
- Credit balance is shown in dollars in this prototype; production shows `Kilo Credits` denomination but the math maps 1:1 ($1 = 1,000,000 microdollars).
- Insufficient-credits copy references the Top-up flow per `Auto Top-Up Integration with Credit Renewal` (linkable later).
- Radios are real `<input type=radio>` inside `<label>`, focusable via keyboard. `:has(input:focus-visible)` paints the yellow-green ring on the card. Tab between groups, arrows within a group.
- `prefers-reduced-motion` short-circuits the step crossfade.
- The faux dashboard behind the modal is decorative, just to set the surface; replace with the real Kilo Cloud chrome at integration time.

## Browser pass

Inspected at:

- 1280 × 900 (desktop)
- 820 × 1180 (tablet)
- 390 × 844 (mobile, iPhone-class)

Issues found and fixed during the initial pass:

1. Close button overlapped the "2 Payment" step label → added 36 px right padding to the stepper.
2. The insufficient-credits warning rendered even when balance was sufficient because `[hidden]` was overridden by `display: flex` on `.warn` → added a global `[hidden] { display: none !important; }` rule.
3. Demo toggle's `$42` option didn't actually exercise an insufficient state on the default selection (Standard first month is only $4) → added a `$0` option and rephrased the others.
4. Mobile dialog overflowed the viewport with content cut off above scroll → switched the overlay to flex with `align-items: flex-start` and `margin: auto` on the dialog, so it centers when content fits and scrolls when it doesn't.
5. Mobile demo chrome wrapped to multiple lines and covered the modal's step indicator → made it a single horizontally-scrollable row on narrow widths and reserved 60 px top padding on the overlay below it.

## Critique pass changes (2026-05-06)

The critique scored the v1 prototype 32/40 on Nielsen's heuristics. The user requested the full action set: `clarify`, `layout`, `typeset`, `harden`, `polish`. Applied as one merged edit batch and verified with three viewports plus a fresh detector run.

- **clarify** — added a one-line group help under the Size picker ("Performance cores are dedicated CPU threads, not shared with other tenants."). Added a credits-source line on the Credits payment card ("From your personal credits balance."). Tightened the Credits and Stripe body copy to two parallel sentences. Removed the user-facing "credit ledger" jargon since the symmetric Stripe ledger already shows the credits-impact concretely.
- **layout** — gave the Stripe payment card the same three-row ledger structure as the Credits card. Both cards now share head + body + ledger + renewal-date badge. Credits ledger reads `Balance / Charge today / After`; Stripe ledger reads `Charge today / Then / Credits used`. Symmetric scannability between the two payment methods.
- **typeset** — consolidated the small-chrome font sizes per the detector flag. Removed the `10 px` and `10.5 px` outliers (page-bg sidebar group title and step indicator pip), routing them through DESIGN.md's `eyebrow` token at 11 px. The user-facing prose lines (`group-help`, `card-source`) sit at 12 px (DESIGN.md `label`) so they pass the tiny-text bar without bloating the modal.
- **harden** — keyboard accelerators: `Enter` advances step 1 → step 2 when valid, and submits on step 2; `⌘+Enter` / `Ctrl+Enter` submits from anywhere in step 2. Visible footer hint with platform-aware modifier glyph (⌘ on Mac, `Ctrl` elsewhere). Last-used plan and size persist in `localStorage` so repeat operators don't re-pick every time. The faux dashboard backdrop becomes `inert` while the dialog is open. Production should also migrate to a native `<dialog>` element for a real focus-trap; the prototype keeps the div-based modal so the demo chrome stays interactive.
- **polish** — the Subscribe and Continue primary buttons have a locked `min-width` so the spinner state never reflows the footer. Mobile recap pill drops separator dots so values don't orphan onto a second line. The keyboard hint sits adjacent to its referent (between Back and Subscribe) instead of floating in the footer middle.

### Final polish pass (2026-05-06)

After the optimize pass, a deliberate final review surfaced two real defects worth fixing before any "ship" call.

1. **The submit loading state hid its own spinner.** The button's `:disabled` rule swapped it to muted gray, so the spinner (which uses `currentColor`) became near-invisible inside `Submitting…`. Fix: a `.is-loading` class with higher specificity than `:disabled` keeps the primary yellow background, near-black text, and `cursor: progress` while in flight. Spinner now reads on yellow. Added `aria-busy="true"` for screen readers.
2. **Keyboard hints repeated the button label.** The footer read `[↵] Continue   [ Continue ]` and `[⌘][↵] Subscribe   [ Subscribe with credits ]`, which spelled the action twice. Fix: dropped the trailing word; the keystroke pill now sits alone next to its primary button (the GitHub / Stripe pattern). The pills carry an `aria-label` so screen readers announce "Press Enter to continue" / "Press Command Enter to subscribe."

Verified: zero console errors, keyboard end-to-end test still passes (Enter from a focused radio advances step 1 → 2; Cmd+Enter from a focused method radio fires the submit handler and resets cleanly).

### Optimize pass changes (2026-05-06)

Measured first, fixed only what was actually wasteful. Numbers from `agent-browser` performance API on a 1280×900 viewport:

| Metric           | Value                             |
| ---------------- | --------------------------------- |
| HTML transfer    | 49.3 KB                           |
| DOMContentLoaded | ~25 ms (warm cache)               |
| FCP              | ~56 ms (warm cache)               |
| LCP              | ~84 ms (warm cache)               |
| Subresources     | 1 Google Fonts CSS link (~0.9 KB) |

The page is fast on file://, so the meaningful optimization is what cold-cache real users will pay for. Auditing computed styles surfaced one real waste:

- **Inter weight 700 was downloaded only to render two elements buried in the faux dashboard backdrop** — the `.logo` "K" tile and the page-bg `<h1>` "claw-prod-08". Both are obscured by the modal during normal use of the prototype.

Fixes:

1. Removed `;700` from the Google Fonts URL. Cold-cache now downloads three Inter woff2 files instead of four (~15–20 KB saved on cold load).
2. Demoted `.logo` and `.page-bg .content .h` from weight 700 to 600 (already in the loaded set). Both still read as bold next to surrounding 400/500 text.
3. Added `contain: layout paint` to `.page-bg` so any repaint of the backdrop can't propagate into the dialog's layer during scroll or hover.

Verified after fixes: Inter 700 no longer appears in any element's computed style; visual screenshot identical to pre-optimize.

Deliberately not done:

- **Self-hosting fonts.** Worth doing in production but inappropriate for a single-file prototype.
- **Minifying CSS/HTML.** 49 KB on file:// is not the bottleneck.
- **Caching DOM queries in `renderPaymentMath`.** Hot path runs at most a couple dozen times per session. Marginal at best.
- **`content-visibility: hidden` on the page-bg when the modal is open.** Would risk a flash on close; the `contain` change already covers the meaningful win.

### Detector follow-up

The deterministic detector (`npx impeccable --json`) flags two remaining items, both deliberate project-canonical choices:

- `overused-font` (Inter) — DESIGN.md mandates Inter as the brand sans.
- `flat-type-hierarchy` (11 / 12 / 13 / 18 px at 1.6×) — the small-chrome cluster matches DESIGN.md `eyebrow` (11) / `label` (12) / `code` (13) tokens. The 1.09× ratio at the small end is intentional density for the operator console; the larger steps (13 → 14 → 18 → 20) hit the 1.25× target.
