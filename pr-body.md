## Summary

Stacks on #7609 and finishes the credits page for the paid-credit expiry policy.

- The balance card now states the purchased-credit term from the live policy instead of promising that credits never expire. With the policy off it reads "Do not expire"; once `PAID_CREDIT_EXPIRATION_EFFECTIVE_AT` is set it reads "Expire one year after purchase". Before the policy loads, or if the read fails, the card says "Loading terms..." or "Terms unavailable" instead of a stale promise.
- The card keeps the earliest-expiry date and the footnote that existing credits keep their terms.

Not included yet: the deductions table change that pairs a purchase with its expiry in one row. The layout options are with the author.

## Verification

- `@kilocode/db`, `@kilocode/web-shared`, `web`, and `kilo-app` typechecks pass.
- Targeted web Jest suites for credits, expiry, refunds, transfers, Pass, reporting, and the credits router pass (327 tests), plus the credits router suite on its own (18 tests).
- Mobile Vitest for `credit-expiry` and the Profile credits card pass (29 tests).
