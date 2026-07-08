---
name: agentcard
description: Create and manage virtual debit cards with AgentCard — issue and close cards, check balances and transactions, manage plan, payment methods, and account, and contact support. Use whenever the user wants to create or spend a virtual card, fund a purchase, or manage their AgentCard account.
---

# AgentCard

AgentCard issues virtual debit cards for agent spending. Use this skill whenever
the user wants to create or close a card, fund a purchase, check a balance or
transactions, manage their plan or payment methods, or contact AgentCard support.

AgentCard runs as the `agentcard` MCP server, reached through your `mcporter` skill.
Call its tools with:

```bash
mcporter call agentcard.<tool> <arg>:<value>
```

## First: discover the live tools and their exact arguments

The tool set and arguments can change, so introspect rather than guess:

```bash
mcporter list agentcard                      # list available tools
mcporter call agentcard.<tool> --schema      # see one tool's exact parameters
```

## Available tools

### Cards
- **`list_cards`** — List all virtual cards with IDs, last four, expiry, balance,
  and status. Start here to find a card.
- **`create_card`** — Create a new virtual debit card. Takes `amount_cents` (integer,
  min 100; e.g. `2000` = $20). Cards are funded from the user's AgentCard wallet.
  May return a resolvable precondition instead of a card: `user_info_required`
  (→ `submit_user_info`), `kyc_required` (→ `start_kyc`), `wallet_funding_required`
  (→ `fund_wallet`), or `deposit_confirming` (funds are on the way — wait and retry;
  do NOT ask the user to pay again). Limits depend on the plan — see `get_plan`.
- **`check_balance`** — Live balance for a card. Prefer this over `get_card_details`
  when you only need funds (faster, no sensitive credentials).
- **`get_card_details`** — Decrypted PAN, CVV, expiry, and balance for a card. Use
  only to fill a payment form. May require human approval — if it returns a 202,
  prompt the user and then call `approve_request`.
- **`list_transactions`** — Transactions for a card (amount, merchant, status,
  timestamps); supports `limit`/`status` filters.
- **`close_card`** — Permanently close a card. Irreversible; idempotent.

### Approvals
- **`approve_request`** — Resolve a pending approval (approve/deny). Use after
  `get_card_details` or `create_card` returns a 202 requiring approval; on approval it
  automatically completes the follow-up action.

### Account & onboarding
- **`whoami`** — The connected AgentCard account (who this token belongs to).
- **`submit_user_info`** — Submit phone number + terms acceptance required before the
  first card. Call after `create_card` returns a `user_info_required` response. (Name
  and DOB are collected automatically during KYC.)
- **`start_kyc`** / **`get_kyc_status`** — Identity verification, required before the
  first live card. It is conversational (government ID photo, missing fields, then a
  short browser face scan) — parts need the user's own browser/phone, so relay the
  links/instructions to the user and poll `get_kyc_status` until verified.

### Wallet & funding
- **`get_wallet`** — The user's wallet and its balance; cards are funded from here.
- **`fund_wallet`** — Add funds in USD (returns an Apple Pay / Google Pay link the
  user opens). Use when `create_card` returns `wallet_funding_required`.
- **`redeem_code`** / **`list_codes`** — Apply a promo code (credits the wallet;
  once per user per code) / see which codes were used.

### Plan & billing
- **`get_plan`** — Current plan, per-card cap, monthly card limit, and usage. Call
  before `create_card` when you need the cap or remaining quota.
- **`upgrade_plan`** — Start a paid-plan upgrade; returns a Stripe Checkout URL the
  user opens to pay. Use only when the user explicitly wants to upgrade.
- **`cancel_plan`** — Cancel the active paid subscription, reverting to free.

### Payment methods
- **`list_payment_methods`** — Saved methods used to fund card creation (id, brand,
  last 4, expiry, default).
- **`setup_payment_method`** — Add a payment method; returns a secure checkout URL the
  user must open.
- **`set_default_payment_method`** — Set which saved method funds new cards
  (`payment_method_id`).
- **`remove_payment_method`** — Detach a saved method permanently (`payment_method_id`).

### Connections
- **`list_connections`** — Third-party apps (e.g. Kilo) connected to the user's
  AgentCard account via OAuth, with connected-at and active status.
- **`revoke_connection`** — Revoke one of those connections. **Confirm with the user
  first** — revoking the Kilo connection cuts off this agent's own AgentCard access.

### Support
- **`start_support_chat`** — Start a support conversation and send the first message.
- **`send_support_message`** — Send a message in an existing support conversation.
- **`read_support_chat`** — Read a support conversation's message history.

### Shopping
- **`buy`** — Describe a purchase in natural language (e.g. "order a caesar salad
  from Zuni on DoorDash") and it runs the whole flow conversationally — call `buy`
  again to answer its questions. Call `get_instructions` first for the current usage
  guide. **Never place an order without the user's explicit confirmation of the cart
  and total** — this spends real money.

### Browser checkout (requires the AgentCard Pay Chrome extension)
These automate paying on a real checkout page and need Chrome with the AgentCard Pay
extension — **not available in the headless agent**, so they typically won't work here.
Prefer `create_card` + `get_card_details` and fill the form yourself.
- **`detect_checkout`** — Check whether the current browser tab is a checkout page.
- **`pay_checkout`** — Create/reuse a card and auto-fill a checkout page.
- **`fill_card`** — Fill an existing card into the current checkout form.

## Common operations

```bash
mcporter call agentcard.create_card amount_cents:2000     # $20 card
mcporter call agentcard.list_cards
mcporter call agentcard.check_balance card_id:<id>
mcporter call agentcard.get_card_details card_id:<id>     # PAN/CVC/expiry (may need approval)
mcporter call agentcard.list_transactions card_id:<id>
mcporter call agentcard.close_card card_id:<id>
```

## Sandbox vs live cards

Whether cards are LIVE or TEST is decided by **how this connection was authorized**
(the OAuth client's mode), not by a per-request choice — there is no runtime mode
switch. Cards are live by default; a connection authorized in sandbox mode mints
TEST cards (mock: no real charge, not usable at real merchants), and such a card is
flagged as a test card in the result. After creating a card, check the result — if
it says TEST, tell the user this connection is in sandbox mode.

## If AgentCard isn't connected

If `mcporter list agentcard` reports the server is unavailable (no `agentcard`
server configured), the user hasn't connected their account yet. Tell them to connect
it in **Settings → Payments → Connect Agentcard** — it's a one-click OAuth step, with
nothing to install. Once connected, the `agentcard` tools become available
automatically.
