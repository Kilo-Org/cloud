# Impact.com Referral Programs

## Role of This Document

This spec defines business rules and invariants for Impact Advocate referral programs for KiloClaw and Kilo Pass. It is
the source of truth for what the system must guarantee: product/program configuration, referral sharing, participant
registration, referral/affiliate attribution conflict resolution, conversion eligibility, reward granting, reward
fulfillment, adverse-payment handling, GDPR behavior, and behavior when Impact Advocate, Impact Performance, or billing
integrations are unavailable.

This spec does not prescribe implementation mechanics such as handler names, persistence layout, retry scheduling,
request formats, or provider configuration variable names unless they are part of a business invariant.

## Status

Draft -- created 2026-04-21 as `.specs/kiloclaw-referrals.md` for KiloClaw referrals.
Updated 2026-05-06 -- require Impact Advocate reward redemption after local KiloClaw reward application.
Updated 2026-05-12 -- note price-versioned KiloClaw billing preserves referral semantics.
Updated 2026-05-22 -- renamed to `.specs/impact-referrals.md` and expanded to Kilo Pass referrals.
Updated 2026-05-28 -- classify enforced Stripe EFW refunds as adverse payments.

## Conventions

BCP 14 [RFC 2119] [RFC 8174] keywords apply only when they appear in all capitals: "MUST", "MUST NOT",
"REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL".

## Definitions

### Shared Impact Definitions

- **Impact.com**: Third-party platform that provides Impact Performance affiliate tracking and Impact Advocate referral
  programs.
- **Impact Advocate**: Impact.com referral product used to generate share links, register participants, attribute
  referred users, report referral conversions, and expose referral/reward state.
- **Impact Performance Program**: Impact.com affiliate/conversion program used for server-side conversion reporting.
  The existing Kilo Impact Performance CampaignId is `50754`.
- **UTT (Universal Tracking Tag)**: Impact.com JavaScript snippet that enables client-side tracking, first-party
  cookies, and identity bridging.
- **Advocate Program**: Product-scoped Impact Advocate referral program. KiloClaw and Kilo Pass MUST use separate
  Advocate programs.
- **Advocate widget**: Impact Verified Access in-app widget used by logged-in users to access referral share links and
  referral status. KiloClaw and Kilo Pass MUST use separate widget configuration.
- **Program key**: Local product-scoped key identifying an Advocate program. Required keys are `kiloclaw` and
  `kilo_pass`.
- **Referral product**: Product whose referral conversion and reward rules apply. Required products are `kiloclaw` and
  `kilo_pass`.
- **Referrer**: Existing user who shares a referral link and may earn a referral reward when an eligible referee
  converts.
- **Referee**: Referred user who arrives through a referral link, creates a Kilo account, and may earn a reward after
  their first eligible product conversion.
- **Referral touch**: Captured Impact Advocate attribution interaction, including `_saasquatch` and related referral
  parameters or cookies. The value is opaque to Kilo.
- **Valid referral touch**: Referral touch with a non-empty `_saasquatch` value, associated with the converting user's
  pre-signup session or user record, where `conversion_time < touched_at + 30 * 24 hours` using server UTC timestamps.
- **Affiliate touch**: Captured Impact Performance affiliate interaction, including the `im_ref` click identifier. The
  value is opaque to Kilo.
- **Sale-attributed affiliate touch**: Affiliate touch already used to report a SALE conversion for the same product.
  This protects affiliate attribution for the initial SALE and applicable renewals from later referral override.
- **Attribution touch**: Referral touch or affiliate touch considered by product conversion-time attribution resolution.
- **Provider-agnostic conversion identity**: Durable conversion identity made from `payment_provider` and
  `source_payment_id`, where `source_payment_id` is the provider's stable payment, invoice, or transaction identifier.
- **Valid touch**: Attribution touch that has not expired, belongs to the converting user or their pre-signup session,
  and is eligible for the conversion being evaluated.
- **Referral-priority attribution**: Conversion-time attribution model where a valid referral touch wins over an
  affiliate touch unless that affiliate touch was already sale-attributed before the referral touch occurred.
- **Brand-new Kilo account**: User identity with no current or historical Kilo user identity under the configured
  identity key before the referral touch. Adding an auth provider to an existing user is not brand-new.
- **Reward beneficiary**: User who may receive a referral reward. Beneficiary roles are `referrer` and `referee`.
- **Reward state**: Durable lifecycle state for a reward. Required states are `pending`, `earned`, `applied`,
  `reversed`, `expired`, `canceled`, and `review_required`.
- **Impact-facing status field**: Local status retained only to compare Kilo state with Impact dashboard exports or API
  reads; it cannot drive eligibility, reward granting, or billing fulfillment.
- **Chargeback**: Stripe dispute event for the qualifying Stripe payment.
- **Fraud-marked payment**: Qualifying payment marked fraudulent by Stripe, an internal fraud process, or an authorized
  operator.
- **Enforced EFW refund**: Refund of a qualifying personal Stripe payment performed under
  `.specs/stripe-early-fraud-warnings.md` after a new Stripe Early Fraud Warning; it is an adverse payment even when no
  later chargeback is created.
- **Support review**: Durable `review_required` reward state with triggering reason, affected billing period, and source
  payment or dispute recorded. Kilo team review is required before an already-applied reward can be canceled, clawed
  back, or otherwise adjusted.

### KiloClaw Definitions

- **KiloClaw Advocate Program**: Impact Advocate referral program for KiloClaw. Existing ProgramId is `51699`.
- **KiloClaw Advocate widget**: Existing Verified Access widget `p/51699/w/referrerWidget`.
- **First paid KiloClaw conversion**: Referee's first confirmed paid personal KiloClaw subscription payment period,
  whether funded by Stripe settlement, hybrid settlement, or pure-credit deduction. Trial start does not qualify, nor
  does inference/credit purchase.
- **Monetized KiloClaw payment period**: KiloClaw billing period with positive Stripe-settled value, positive hybrid
  settled value, or positive credit deduction. Zero-dollar invoices, fully comped periods, and admin adjustments are not
  monetized payment periods.
- **Free-month reward**: Local KiloClaw billing reward that delays the beneficiary's next KiloClaw renewal by one
  calendar month. It is not a general account credit.
- **Calendar month**: Billing-period extension that preserves day-of-month semantics of the current KiloClaw billing
  calendar, clamping to the last valid day of the target month when necessary.
- **Active eligible personal KiloClaw subscription**: Personal KiloClaw subscription that is active, not canceling at
  period end, not suspended, and not past due.
- **Personal KiloClaw subscription**: KiloClaw subscription owned by an individual user. Organization/team-scoped
  KiloClaw subscriptions are not eligible.

### Kilo Pass Definitions

- **Kilo Pass Advocate Program**: Separate Impact Advocate referral program for Kilo Pass. It MUST NOT reuse the
  KiloClaw Advocate program or widget identifiers.
- **Kilo Pass Advocate widget**: Separate Verified Access widget for Kilo Pass referrals.
- **Kilo Pass referral page**: User-facing Kilo Pass referral page at `/subscriptions/kilo-pass/refer`.
- **Eligible Kilo Pass conversion**: Referee's first confirmed paid personal monthly Kilo Pass Stripe payment at launch.
  Annual subscriptions, team plans, organization plans, App Store payments, and Google Play payments are out of launch
  scope; schema and business language should remain provider-agnostic for later store support.
- **Kilo Pass monthly tier**: Eligible monthly tier `tier_19`, `tier_49`, or `tier_199`.
- **Kilo Pass referral bonus reward**: Local Kilo Pass reward worth 50% of the referee's eligible monthly tier at
  conversion time. It is fulfilled as one future `referral_bonus` Kilo Pass issuance item.
- **Referral bonus amount**: USD amount snapshotted at qualifying conversion as
  `monthly_price(referee_conversion_tier) * 0.5`.
- **Kilo Pass base monthly issuance**: Monthly issuance event that grants base Kilo Pass credits for the beneficiary's
  active monthly Kilo Pass subscription.
- **Eligible Kilo Pass reward issuance**: Kilo Pass base monthly issuance for an active personal monthly subscription
  after the referral reward was earned. Annual subscription issuances and already-created issuances are not eligible.
- **Kilo Pass bonus-like issuance item**: Kilo Pass issuance item of kind `bonus`, `promo_first_month_50pct`, or
  `referral_bonus`. At most one bonus-like item may exist for an issuance.
- **Referral launch cutoff**: UTC instant configured for the Kilo Pass referral launch. First-time monthly subscribers
  who started before the cutoff keep legacy month-2 welcome promo behavior; subscribers starting at or after the cutoff
  receive only the first-month welcome promo.

## Overview

Kilo referral programs are double-sided and Impact Advocate-powered. Impact Advocate owns referral sharing, share links,
referral cookies, participant registration, and provider-facing referral reporting. Kilo owns authoritative product
eligibility, affiliate/referral attribution conflict resolution, first-paid-conversion detection, reward grant
idempotency, reward caps, reward expiry, adverse-payment handling, and local billing/credit fulfillment.

KiloClaw referrals reward both sides with one free KiloClaw month, fulfilled by delaying an eligible KiloClaw renewal by
one calendar month. KiloClaw remains scoped to personal KiloClaw subscriptions and preserves existing behavior.

Kilo Pass referrals reward both sides with a one-time 50% Kilo Pass bonus based on the referee's eligible monthly tier,
fulfilled as a future monthly `referral_bonus` issuance item after the reward is earned. Pending Kilo Pass rewards stack
across future months and expire after 12 months if not consumed. Once applied, referral bonus credits follow normal Kilo
Pass balance consumption order and expire at the month boundary if unused. Referral bonus application replaces, and does
not stack with, the normal Kilo Pass monthly/promo bonus for that issuance.

Existing Impact Performance conversion events drive Impact Advocate conversion state. The system uses `Sale (71659)` as
the paid-conversion event for referral conversion and renewal reporting. When referral wins attribution for a paid
conversion, local referral rewards are authoritative and affiliate SALE reporting for the same conversion is suppressed.

## Rules

### Program Configuration

1. The system MUST support product-scoped Advocate program configuration for `kiloclaw` and `kilo_pass`.

2. KiloClaw MUST keep compatibility with the existing configuration constants:
   - Impact Account: `7138521`
   - Impact Performance CampaignId: `50754`
   - Impact Advocate ProgramId: `51699`
   - UTT UUID: `A7138521-9724-4b8f-95f4-1db2fbae81141`
   - Advocate widget ID: `p/51699/w/referrerWidget`

3. Existing unscoped Impact Advocate configuration MAY remain as KiloClaw fallback configuration only. Kilo Pass MUST
   require explicit Kilo Pass Advocate program/widget configuration and MUST NOT fall back to KiloClaw configuration.

4. Kilo Pass MUST use a different Impact Advocate program ID and widget ID than KiloClaw.

5. The system MUST use existing Impact Performance conversion action tracker IDs for lifecycle reporting where
   applicable:

   | Event | ActionTrackerId | Referral use |
   |---|---|---|
   | VISIT | 71668 | Affiliate/visit reporting where applicable |
   | SIGNUP | 71655 | New user creation with attribution |
   | TRIAL_START | 71656 | KiloClaw trial subscription becomes active |
   | TRIAL_END | 71658 | KiloClaw trial subscription ends |
   | SALE | 71659 | KiloClaw monetized period or Kilo Pass conversion |

6. Impact Advocate API credentials MUST remain server-side and MUST NOT be exposed to the browser.

7. If Impact Advocate configuration is absent for a product, referral sharing, participant registration, and provider
   reconciliation for that product MAY be disabled, but unrelated application functionality MUST continue normally.

8. If reward-bearing referral configuration is absent in an environment where a product referral program is enabled:
   - the system MUST fail closed for reward issuance;
   - the system MUST log the configuration failure;
   - the system MUST NOT silently mark rewards or Impact work as completed.

9. Referral UTT loading is controlled by the application's public Impact UTT configuration for the active environment.

### Advocate Experience

10. Logged-in users MUST access referral sharing through the product's Impact Verified Access widget.

11. Kilo Pass referral sharing MUST be available from `/subscriptions/kilo-pass/refer` when configured.

12. The Kilo Pass referral page MUST use Kilo Pass-specific widget configuration, token issuance, reward summary, and
    copy. It MUST NOT show KiloClaw referral wording, widgets, links, or rewards as Kilo Pass referral state.

13. When the Kilo Pass Advocate program is unconfigured, the Kilo Pass referral page MUST remain usable and explain that
    referral sharing is unavailable. It MUST NOT fall back to KiloClaw sharing.

14. The system MUST authenticate users to Impact Advocate using the configured Verified Access contract: the JWT header
    MUST set `kid` to the Impact Account SID, the JWT payload MUST contain the top-level `user` object, and the JWT MUST
    be signed with the Impact Advocate Auth Token.

15. The Impact Advocate identity contract for Kilo is: `id = plain user email`, `accountId = plain user email`, and
    `email = plain user email`.

16. The system MUST NOT allow users to alter the identity payload used to establish Advocate identity.

17. The system MUST register every Kilo user issued a product's Impact Advocate Verified Access token as a participant
    in that product's Advocate program server-side, even when the user has no inbound referral attribution. Registration
    MUST happen no later than first token issuance for that user/program pair.

18. Advocate participant registration MUST be idempotent per user/program pair and MUST persist the program-scoped
    referral code returned by Impact Advocate so inbound referral touches can resolve the originating referrer.

19. The same Kilo user MAY have separate participant records and referral codes for KiloClaw and Kilo Pass.

### Client-Side Tracking and Identity

20. The system MUST load the Impact UTT script on pages used by referral programs when the UTT identifier is configured
    and MUST NOT load it otherwise.

21. The system MUST invoke Impact `identify` on pages used by referral programs.

22. Anonymous `identify` calls MUST pass empty string values for unknown `customerId` and `customerEmail`. The system
    MUST NOT pass `undefined`, `null`, placeholders, or fake identifiers for unknown users.

23. Logged-in `identify` calls MUST pass a stable customer identifier and SHA-1 hashed email.

24. `identify` calls MUST include a stable `customProfileId` derived from the Kilo user ID for logged-in users and a
    stable first-party anonymous ID for anonymous users.

25. The system MUST treat `_saasquatch`, `rsCode`, `rsShareMedium`, `rsEngagementMedium`, `im_ref`, and related
    tracking values as opaque. The system MUST NOT parse, validate their internal format, or assign meaning to them.

26. Opaque tracking values MUST have a documented maximum accepted length, MUST be stored as UTF-8 strings, and MUST be
    ignored for attribution when they exceed that maximum. Logs MUST redact or truncate opaque tracking values.

### Referral Touch Capture

27. When a visitor opens an Impact Advocate referral link, the system MUST recognize that referral before signup and
    preserve it through account creation so the referral can be associated with the newly created user.

28. A referral touch is valid for attribution only when it contains a non-empty `_saasquatch` value. If `_saasquatch` is
    absent, the system MAY preserve related metadata for diagnostics but MUST NOT treat it as a valid referral touch.

29. A referral touch SHOULD include related opaque metadata when available, including `rsCode`, `rsShareMedium`,
    `rsEngagementMedium`, UTM parameters, and sanitized landing path.

30. Referral touch capture MUST preserve attribution across the authentication flow, including OAuth redirects and
    callback URLs.

31. Referral touches MUST expire 30 days after touch time. A touch is valid only when
    `conversion_time < touched_at + 30 * 24 hours`, using server UTC timestamps. A touch at or after that instant is
    expired.

32. The system MUST associate pre-signup referral touches with the created user during signup or first authenticated
    request after signup.

33. Capturing or associating a referral touch MUST NOT grant a reward.

34. If a user arrives with multiple referral touches, the system MUST preserve enough chronological information to
    resolve referral-priority attribution at conversion time.

35. Attribution touches MUST record the product they target. Impact Advocate referral touches MUST also record the
    program key they target. If the product or required program key cannot be resolved, the touch MAY be retained for
    diagnostics but MUST NOT be eligible for reward or affiliate attribution.

### Affiliate and Referral Attribution Priority

36. Product referral rewards and product affiliate attribution MUST share a 30-day conversion-time attribution window.

37. At first eligible paid product conversion time, the system MUST evaluate valid affiliate and referral touches
    together for that product.

38. For conversions governed by this referral spec, referral-priority attribution overrides the permanent first-touch
    affiliate attribution rules in `.specs/impact-affiliate-tracking.md` for the initial paid conversion decision.

39. A valid referral touch MUST win over a valid affiliate touch unless that affiliate touch was already
    sale-attributed for the same product before the referral touch occurred.

40. A sale-attributed affiliate touch MUST keep affiliate attribution for the initial SALE and applicable subsequent
    renewal SALEs only when that SALE attribution occurred before the referral touch. Referral touches MUST NOT
    retroactively override those affiliate-attributed SALE events.

41. If multiple valid referral touches exist and no preserved sale-attributed affiliate touch is present, the oldest
    valid referral touch MUST win.

42. If no valid referral touch exists, the oldest valid affiliate touch MUST win.

43. If all touches are expired or invalid, neither affiliate attribution nor referral rewards win for that conversion.

44. If an affiliate touch wins, the system MUST NOT grant referral rewards for that conversion.

45. If a referral touch wins, the system MUST NOT attribute that first paid product conversion to an affiliate for reward
    or payout purposes.

46. The system MUST record when an affiliate touch has been attributed to a SALE conversion for a product to preserve
    affiliate attribution for that initial sale and applicable renewals.

47. The system MUST implement at least these attribution outcomes:

| Scenario | Expected winner |
|---|---|
| Affiliate first, referral second, both valid, no prior affiliate SALE | Referral |
| Affiliate first, referral second, both valid, affiliate SALE before touch | Affiliate |
| Referral first, affiliate second, both valid, no prior affiliate SALE | Referral |
| Only affiliate valid | Affiliate |
| Only referral valid | Referral |
| All touches expired or invalid | None |

48. Attribution resolution for referral rewards MUST happen at conversion time, not only at signup time.

49. Impact-side attribution MUST NOT override local eligibility, reward caps, or billing fulfillment decisions.

### Referred Participant Registration

50. When a new user signs up with `_saasquatch` attribution, the system MUST attempt to register or upsert the user as a
    referred participant in the Impact Advocate program associated with the captured referral touch.

51. Register Participant requests MUST be made server-side.

52. Register Participant requests MUST pass the captured `_saasquatch` value as opaque cookie attribution.

53. Register Participant requests SHOULD include locale and country code when available.

54. If `_saasquatch` is present during signup, referral touch association and participant registration enqueueing MUST
    occur before signup is considered complete, but external Impact delivery MUST NOT block user access.

55. Register Participant failures MUST be recorded for retry or reconciliation.

56. Transient participant registration failures MUST leave registration in a retryable state until it succeeds, is
    superseded by a corrected payload, or is marked permanently failed by an operator-visible terminal state.

57. Register Participant requests that fail with client errors MUST be logged and MUST NOT be retried until the request
    payload or configuration is corrected.

58. Register Participant requests MUST use the user's plain email for Advocate `id` and `accountId`.

59. Register Participant requests MUST include plain-text email only as Advocate contact email.

60. On a successful Register Participant response, the system MUST persist the program-scoped referral code returned in
    `referralCodes[<programId>]` against the participant record for that program.

61. Referral code persistence MUST be idempotent. Re-running registration for the same participant/program MUST NOT
    corrupt or duplicate the code.

62. If another participant in the same program already holds the same referral code, the new participant's code MUST NOT
    be persisted; the rest of registration success state MUST still be recorded.

63. The same opaque referral identifier MAY exist in different Advocate programs only when scoped by program key.

### Shared Referee Eligibility

64. A referee MUST be a brand-new Kilo account to qualify for referral rewards.

65. Existing users MUST NOT qualify as referees, even if they later click a referral link.

66. Adding an auth provider to an existing Kilo user MUST NOT qualify as a brand-new Kilo account.

67. Previously deleted users MUST NOT qualify as referees. Disqualification MUST use a legal-approved normalized-email
    hash tombstone.

68. A user MUST NOT refer themselves. The system MUST disqualify a referral when referrer and referee resolve to the
    same Kilo user.

69. Fraudulent, test, admin-created, or manually adjusted subscriptions/payments MUST NOT qualify for referral rewards
    unless an authorized operator explicitly marks the conversion as eligible under a documented support process.

### KiloClaw Product Rules

70. KiloClaw referrals apply only to personal KiloClaw subscriptions. Organization-scoped KiloClaw instances, team
    plans, admin interventions, and non-KiloClaw purchases are out of scope.

71. A KiloClaw referee MUST make a first confirmed paid personal KiloClaw subscription payment before either side earns
    a reward.

72. The first confirmed paid KiloClaw subscription payment MUST fund a monetized KiloClaw payment period.

73. Trial start, trial end, account signup, widget registration, zero-dollar invoices, fully comped periods, admin
    adjustments, or referral touch capture MUST NOT qualify as a paid KiloClaw referral conversion.

74. A KiloClaw referee's renewals after first paid KiloClaw conversion MUST NOT generate additional referral rewards.

75. A KiloClaw referrer MUST be a Kilo user registered or registerable as an Impact Advocate participant.

76. A KiloClaw referrer's current KiloClaw subscription state MUST NOT prevent reward earning.

77. If a KiloClaw referrer has no active eligible personal KiloClaw subscription when the reward is earned, the system
    MUST keep the reward pending so it can apply when the referrer starts or reactivates an eligible personal KiloClaw
    subscription.

78. A pending inactive-referrer KiloClaw reward MUST expire and be canceled 12 months after it is earned if the referrer
    has not started or reactivated an eligible paid personal KiloClaw subscription.

79. A pending KiloClaw referrer reward MUST NOT apply to a KiloClaw trial. It MUST apply to the next unpaid renewal
    boundary after the referrer starts or reactivates a paid personal KiloClaw subscription.

80. A KiloClaw referrer MUST NOT receive more than 12 total free-month rewards from the KiloClaw referral program.

81. The KiloClaw referrer cap MUST be enforced before granting a referrer reward and MUST be enforced atomically across
    concurrent reward grants.

82. When a qualified KiloClaw referral occurs after the referrer has reached the 12-month cap, the system MUST record
    the referrer reward as cap-limited and MUST NOT grant another referrer free month.

83. KiloClaw referee rewards MUST NOT count against the referrer's cap.

84. A qualified KiloClaw referral conversion MUST grant one free-month reward to the referee.

85. A qualified KiloClaw referral conversion MUST grant one free-month reward to the referrer unless cap-limited or
    disqualified.

86. KiloClaw free-month rewards MUST be fulfilled by delaying a KiloClaw renewal by one calendar month per reward.

87. An earned KiloClaw reward applies to the beneficiary's next unpaid renewal boundary after the reward is earned. It
    MUST NOT modify already-finalized invoices or already-funded periods.

88. KiloClaw free-month rewards MUST NOT be fulfilled as general account credits.

89. KiloClaw free-month rewards MUST apply to KiloClaw billing only. They MUST NOT apply to inference usage, Kilo Pass,
    team plans, or non-KiloClaw purchases.

90. Multiple KiloClaw free-month rewards MAY stack. Each applied reward MUST delay renewal by exactly one calendar month.

91. For month-to-month KiloClaw subscriptions, one reward MUST delay the next monthly renewal by one calendar month.

92. For six-month commitment KiloClaw subscriptions, one reward MUST delay the next six-month renewal by one calendar
    month. The reward MUST NOT convert the subscription to month-to-month and MUST NOT reduce the next invoice by one
    sixth.

93. For pure-credit KiloClaw subscriptions, reward application MUST update local renewal state so the credit renewal
    sweep does not deduct KiloClaw hosting credits until the extended renewal time.

94. For Stripe-funded or hybrid KiloClaw subscriptions, reward application MUST keep local billing state and Stripe
    billing state consistent. The system MUST NOT create a local-only renewal delay for a Stripe-funded subscription
    while allowing Stripe to charge on the original schedule.

95. KiloClaw reward application MUST respect cancellation state. If a subscription is canceled or canceling before
    reward application, the reward MUST remain pending until the beneficiary has an active eligible personal KiloClaw
    subscription.

96. Price-versioned KiloClaw billing does not change referral eligibility, attribution priority, first-paid-conversion
    timing, reward caps, or free-month fulfillment.

### Kilo Pass Product Rules

97. Kilo Pass referrals apply only to personal monthly Kilo Pass subscriptions. Team plans, organization plans, annual
    Kilo Pass subscriptions, non-Kilo Pass purchases, and admin-only interventions are out of scope.

98. At launch, eligible Kilo Pass referral conversions are monthly Stripe web payments only. App Store and Google Play
    conversions MAY be added later without changing provider-agnostic conversion identity rules.

99. A Kilo Pass referee MUST be a brand-new Kilo account and MUST NOT have any current or historical Kilo Pass
    subscription before the qualifying first Kilo Pass subscription/payment, excluding the current first subscription
    being converted.

100.  Existing or previously canceled Kilo Pass subscribers MUST NOT qualify as Kilo Pass referees.

101.  A Kilo Pass referee MUST make a first confirmed paid personal monthly Kilo Pass payment before either side earns a
      Kilo Pass referral reward.

102.  Kilo Pass Stripe launch conversions MUST use provider-agnostic conversion identity with
      `payment_provider = stripe` and `source_payment_id = Stripe invoice ID`.

103.  Annual Kilo Pass subscriptions MUST NOT qualify for Kilo Pass referral rewards because annual pricing already
      includes the annual discount.

104.  Kilo Pass renewals after the first eligible monthly conversion MUST NOT generate additional referral rewards.

105.  A Kilo Pass referrer MUST be a Kilo user registered or registerable as a Kilo Pass Impact Advocate participant.

106.  A Kilo Pass referrer's active subscription state at referee conversion time MUST NOT prevent reward earning.

107.  If a Kilo Pass beneficiary has no active eligible monthly Kilo Pass subscription when a reward would apply, the
      reward MUST remain pending until the beneficiary starts or reactivates an eligible monthly Kilo Pass subscription,
      is canceled by adverse-payment handling, is manually resolved, or expires.

108.  A pending Kilo Pass referral reward MUST expire and be canceled 12 months after it is earned if it has not been
      consumed.

109.  A Kilo Pass referrer MUST NOT receive more than 5 granted referrer rewards from the Kilo Pass referral program.

110.  The Kilo Pass referrer cap MUST be enforced before granting a referrer reward and MUST be enforced atomically
      across concurrent reward grants.

111.  When a qualified Kilo Pass referral occurs after the referrer has reached the 5-reward cap, the system MUST record
      the referrer reward as cap-limited and MUST NOT grant another referrer reward.

112.  Kilo Pass referee rewards MUST NOT count against the referrer's cap.

113.  A qualified Kilo Pass referral conversion MUST grant one Kilo Pass referral bonus reward to the referee.

114.  A qualified Kilo Pass referral conversion MUST grant one Kilo Pass referral bonus reward to the referrer unless
      cap-limited or disqualified.

115.  Kilo Pass first-time monthly subscribers MUST keep the first-month welcome promo when otherwise eligible. Referral
      rewards MUST NOT replace, reduce, or retroactively alter the source conversion's first-month welcome issuance.

116.  Kilo Pass referral reward value MUST be snapshotted at conversion as 50% of the referee's eligible monthly tier.
      Later tier changes by either beneficiary MUST NOT change the reward amount.

117.  Kilo Pass reward amounts MUST be represented as USD monetary amounts with cent precision and MUST NOT be rounded
      beyond normal cent representation.

118.  Kilo Pass referral reward records MUST store enough information to audit the source conversion, source tier,
      reward percent, reward amount, beneficiary, role, status, expiry, and consumed issuance/application.

119.  Kilo Pass referral rewards MUST stack as pending future monthly applications. Five pending Kilo Pass referral
      rewards represent up to five future monthly referral bonus applications.

120.  At eligible Kilo Pass base monthly issuance time, if the beneficiary has one or more pending unexpired Kilo Pass
      referral rewards and no permanent application blocker applies, the system MUST consume exactly one reward.

121.  At most one pending Kilo Pass referral reward MUST be consumed per eligible monthly Kilo Pass base issuance.

122.  When multiple pending unexpired Kilo Pass referral rewards are eligible for the same issuance, the oldest earned
      reward MUST be consumed first.

123.  A Kilo Pass referral reward MUST apply only to an eligible monthly base issuance after the reward is earned. It MUST
      NOT apply retroactively to the source conversion's base issuance or to any already-created issuance.

124.  A consumed Kilo Pass referral reward MUST create a distinct `referral_bonus` Kilo Pass issuance item.

125.  A `referral_bonus` item MUST be mutually exclusive with normal `bonus` and `promo_first_month_50pct` items for the
      same Kilo Pass issuance.

126.  When a `referral_bonus` item is issued for a Kilo Pass issuance, the system MUST NOT later issue normal Kilo Pass
      bonus or promo bonus credits for that same issuance, even if the user later crosses the usage-triggered bonus
      threshold.

127.  Kilo Pass referral bonus credits MUST be granted at base monthly issuance time, not at usage-triggered bonus unlock.

128.  Kilo Pass referral bonus credits MUST follow normal Kilo Pass balance consumption order: paid credits are consumed
      before bonus credits.

129.  Applied Kilo Pass referral bonus credits MUST expire at the month boundary if unused, using the same expiry behavior
      as regular monthly Kilo Pass bonus credits.

130.  Kilo Pass referral bonus credits MUST NOT carry over month-over-month after application.

131.  Kilo Pass referral rewards MUST NOT apply to annual Kilo Pass subscription issuances. If a beneficiary has pending
      rewards but only an annual Kilo Pass subscription, rewards remain pending until an eligible monthly subscription is
      available or the rewards expire.

132.  Kilo Pass welcome bonus behavior MUST change at referral launch: first-time monthly subscribers who started before
      the referral launch cutoff keep legacy month-2 promo eligibility; subscribers starting at or after the cutoff MUST
      receive only the first-month welcome promo.

### Shared Reward Granting

133. Referral reward granting MUST be idempotent. Processing the same qualifying conversion multiple times MUST NOT
     create duplicate rewards for the same beneficiary role.

134. For a qualified referral, reward grant processing MUST be atomic across both beneficiary reward decisions. Both
     beneficiary outcomes MUST be recorded together, including granted, cap-limited, and disqualified outcomes.

135. Reward records MUST identify source referral, source conversion, beneficiary user, beneficiary role, reward kind,
     status, relevant amount/duration fields, and relevant timestamps.

136. Reward records MUST support the reward states defined in this spec.

137. A reward MUST NOT be considered fulfilled until local billing/credit state and any required external billing state
     have been updated for that reward kind.

138. Impact Advocate reward state MAY be used for reconciliation, support, or reporting. It MUST NOT be the source of
     truth for local reward eligibility, application, cancellation, or reversal.

139. Reward application MUST be idempotent. Retrying reward application MUST NOT apply the same reward more than once.

140. Reward application MUST record an audit trail containing reward, beneficiary, affected product/subscription,
     previous and new relevant billing/credit state, and any external operation identifiers.

### Impact Conversion Reporting

141. Impact Advocate referral conversion MUST be driven by server-side Impact Performance conversion events unless a
     later product-specific spec explicitly changes this.

142. `Sale (71659)` MUST be the paid conversion event used for KiloClaw and Kilo Pass referral conversion reporting.

143. The system MUST NOT dispatch client-side `trackConversion` for referrals while server-side Performance conversion
     is the configured reporting mechanism.

144. When a referral wins attribution and the first paid conversion qualifies, the system MUST ensure Impact receives the
     required Performance conversion data for Advocate conversion reporting.

145. Kilo Pass referral winners MUST queue server-side Impact Performance `SALE` reporting with Kilo Pass product fields
     for Impact Advocate conversion state.

146. When Kilo Pass referral wins for an invoice, the system MUST suppress affiliate SALE reporting for that same
     invoice.

147. Conversion reporting MUST use deterministic order identifiers where possible so retries do not create duplicate
     Impact actions.

148. Conversion reporting failures MUST NOT block billing settlement, reward ledger creation, reward application, or user
     access. Failures MUST leave the conversion report in a retryable state until it succeeds, is superseded by a
     corrected payload, or is marked permanently failed by an operator-visible terminal state.

### Impact Reconciliation and Reward Redemption

149. The system MUST NOT rely on Impact Advocate webhooks for referral eligibility, reward granting, billing
     fulfillment, or reconciliation.

150. The system MAY use Impact dashboard exports or API reads for manual reconciliation and support investigations.

151. Impact reconciliation data MAY update local Impact-facing status fields, but it MUST NOT bypass local eligibility,
     caps, attribution, or fulfillment rules.

152. For KiloClaw, when a local free-month reward is applied to billing, the system MUST mark the corresponding Impact
     Advocate credit reward as redeemed so Impact reporting matches Kilo's fulfillment state.

153. KiloClaw Impact Advocate reward redemption MUST happen asynchronously and MUST NOT block reward application,
     billing settlement, or user access.

154. Before redeeming a KiloClaw Impact Advocate reward, the system MUST fetch the beneficiary account's rewards from
     Impact Advocate and select the corresponding credit reward ID.

155. Redeeming a KiloClaw Impact Advocate reward MUST use Impact Advocate's single-reward redemption endpoint with the
     local reward's granted month count and configured free-month reward unit.

156. KiloClaw Impact Advocate reward lookup and redemption attempts MUST be idempotently queued per local reward.

157. If the KiloClaw Impact reward is not yet visible when redemption is attempted, redemption work MUST remain in a
     retryable state.

158. Impact reward redemption state is for reporting and reconciliation only. It MUST NOT be the source of truth for
     local reward eligibility, application, cancellation, or reversal.

### Refunds, Reversals, and Fraud

159. Rewards from a qualifying Stripe payment MUST be treated as adverse when Stripe reports a chargeback or when
     Kilo enforces an EFW refund for that payment.

160. Pending or earned-but-unapplied rewards MUST be canceled when the qualifying Stripe payment is charged back,
     refunded, fraud-marked, or refunded as part of enforced EFW handling. This rule applies to both KiloClaw and Kilo
     Pass qualifying payments.

161. Already-applied rewards from a charged-back, refunded, fraud-marked, or EFW-refunded payment MUST be marked for
     support review and MUST NOT be automatically canceled or clawed back.

162. If a qualifying Impact action must be reversed, including after an enforced EFW refund that prevents a later
     chargeback event, the system SHOULD use Impact's reverse-action mechanism instead of creating an unrelated negative
     conversion.

163. Reversal and reward-cancellation handling MUST be idempotent across EFW refund, ordinary refund, fraud marking, and
     later chargeback delivery for the same qualifying payment.

### GDPR and PII

164. Referral tables that store user IDs, emails, referral relationships, IP addresses, referral cookies, Impact IDs, or
     reconciliation payloads MUST be included in GDPR soft-delete or anonymization flows.

165. GDPR deletion MUST delete or anonymize referral participant records, referral touch records, referral relationship
     records, reconciliation payloads containing PII, and reward records to the extent required by policy.

166. Plain email stored for Impact Advocate compatibility MUST be deleted or anonymized during GDPR deletion for every
     product/program participant row and related registration attempts.

167. Previously deleted user disqualification MUST use a legal-approved non-PII tombstone or irreversible hash. The
     system MUST NOT retain PII solely for this purpose.

168. Referral tracking values MUST NOT be logged in a way that exposes secrets, auth headers, cookies, or unnecessary
     PII.

### Reliability and Isolation

169. Referral touch capture, participant registration, conversion reporting, reconciliation processing, and reward
     fulfillment failures MUST NOT break unrelated product functionality.

170. Reward ledger operations MUST be transactional where needed to prevent duplicate grants, partial grants, missing
     audit records, or reward cap races.

171. Reward fulfillment failures MUST leave rewards in a retryable state unless the failure is a permanent eligibility,
     expiry, adverse-payment, or configuration failure.

172. The system MUST expose enough operational state to distinguish pending Impact registration, pending Impact
     conversion reporting, pending local reward application, applied rewards, reversed rewards, canceled rewards,
     expired rewards, review-required rewards, and disqualified referrals.

173. Admin-only subscription interventions, internal test conversions, and support adjustments MUST NOT emit referral
     rewards or Impact referral conversions unless explicitly marked as eligible by an authorized operator.

### Existing Internal Referral System

174. The existing internal referral-code system MUST NOT grant additional product referral rewards for conversions
     already governed by this spec.

175. Before launch, the existing internal referral system MUST be scoped away from KiloClaw and Kilo Pass, disabled for
     those products, or migrated into this program's rules to prevent double rewards.

### Kilo Pass Reusable Payment-Fingerprint Welcome-Promo Guard

176. The Kilo Pass introductory welcome promo MUST be claimable at most once per reusable Stripe payment-instrument
     fingerprint that the system supports. Initial supported instrument types are `card`, `sepa_debit`,
     `us_bank_account`, `bacs_debit`, and `au_becs_debit`. Annual subscriptions are excluded.

177. An instrument fingerprint opportunity MUST be claimed only when a personal monthly Kilo Pass Stripe payment with
     `amount_paid > 0` settles using that instrument, not when the instrument is merely attached, when a zero-value
     invoice is finalized, when usage crosses the bonus threshold, or when welcome-promo credits are later issued.

178. A first-time account whose positively paid monthly Kilo Pass settlement uses a previously claimed reusable instrument
     fingerprint MUST NOT receive the introductory `50%` welcome promo. It MAY receive the ordinary monthly-ramp bonus
     using the same behavior as an existing or previously canceled Kilo Pass subscriber.

179. A positively paid monthly Kilo Pass settlement using a previously claimed reusable instrument fingerprint MUST NOT be
     an eligible Kilo Pass referral conversion and MUST NOT grant a Kilo Pass referral reward to either beneficiary role.

180. A positively paid monthly settlement whose payment method is confirmed not to provide a supported reusable
     fingerprint MUST NOT be disqualified solely because no cross-account instrument signal exists. A supported reusable
     method with an absent fingerprint MAY follow that fallback. An unresolvable settlement MUST NOT be treated as a
     confirmed eligible fallback.

181. Shared household, business, or other jointly used payment instruments are governed by the same one-claim rule; the
     system MUST NOT provide additional welcome-promo or Kilo Pass referral-conversion eligibility solely because a later
     buyer is a different person.

182. A claimed reusable instrument fingerprint MUST remain claimed after refund, dispute, fraud marking, cancellation,
     failure to redeem welcome-promo credits, or account deletion. Credit or reward handling for adverse payments is
     separate from instrument-claim retention.

183. When a paid monthly purchase is welcome-promo ineligible because its reusable payment fingerprint was previously
     claimed, the post-payment Kilo Pass confirmation flow MUST inform the customer that the introductory bonus does not
     apply. The message MUST NOT expose the fingerprint or the existence or identity of another account.

184. Durable instrument-claim records MAY retain the minimum Stripe fingerprint and payment identity data needed to
     enforce these anti-abuse rules after account deletion. Customer-facing surfaces MUST NOT expose that retained
     evidence, and any direct user identity references stored with such records MUST be deleted or anonymized under GDPR
     deletion flows.

## Error Handling

1. If referral touch capture fails, the system SHOULD log the failure and continue the primary request.

2. If Register Participant delivery fails with a server error or timeout, the system MUST leave registration in a
   retryable state.

3. If Register Participant delivery fails with a client error, the system MUST log the error and MUST NOT retry
   unchanged payloads.

4. If Impact conversion reporting fails with a server error or timeout, the system MUST leave the report in a retryable
   state.

5. If Impact conversion reporting fails with a client error, the system MUST log the error and MUST NOT retry unchanged
   payloads.

6. If reward grant processing detects an ineligible referee, ineligible referrer, expired attribution, self-referral,
   exceeded cap, non-personal subscription, non-monthly Kilo Pass subscription, previous Kilo Pass subscription, or
   unsupported payment provider, the system MUST record the disqualification reason when a referral record exists.

7. If reward application fails after a reward is earned, the reward MUST remain retryable unless the failure is permanent
   and auditable.

8. If required billing or credit state is ambiguous, the system MUST NOT apply a reward. It MUST leave the reward pending
   or mark it for review, as appropriate, and log the ambiguity for investigation.

9. If Impact Advocate reward lookup or redemption fails with a server error or timeout, the system MUST leave redemption
   work in a retryable state.

10. If Impact Advocate reward lookup or redemption fails with a client error, the system MUST log the error and MUST NOT
    retry unchanged payloads, except an already-redeemed response MAY be treated as idempotent success.

## Changelog

### 2026-05-28 -- Enforced EFW refunds are adverse payments

Classified an enforced Stripe Early Fraud Warning refund as an adverse qualifying payment for both covered products. Pending or earned-but-unapplied rewards cancel, already-applied rewards require support review, and later refund or chargeback delivery must remain idempotent.

### 2026-05-27 -- Prevent repeated Kilo Pass welcome claims by payment fingerprint

Added the Kilo Pass reusable Stripe payment-fingerprint guard for monthly introductory welcome promos and referral
conversions. The first positively paid settlement using a supported fingerprintable instrument permanently claims that
instrument opportunity; reused instruments retain ordinary monthly-ramp bonus behavior but do not receive the
introductory promo or create Kilo Pass referral rewards. Annual behavior remains outside this restriction.

### 2026-05-22 -- Rename and expand to Kilo Pass

Renamed `.specs/kiloclaw-referrals.md` to `.specs/impact-referrals.md`. Generalized shared Impact Advocate referral
rules and added Kilo Pass referral requirements: separate program/widget config, `/subscriptions/kilo-pass/refer`,
monthly Stripe launch scope, referral-vs-affiliate priority using the KiloClaw resolver model, first-time Kilo Pass
subscriber eligibility, 5-referrer-reward cap, double-sided 50% rewards snapshotted from the referee's monthly tier,
12-month pending reward expiry, base-issuance `referral_bonus` fulfillment, monthly bonus replacement, adverse-payment
handling, server-side Performance SALE reporting for Advocate state, and welcome-bonus cutoff behavior.

### 2026-05-12 -- Price-versioned KiloClaw billing preserves referral semantics

Reviewed against KiloClaw price-versioned billing. Referral eligibility, attribution priority, first-paid-conversion
timing, reward caps, and free-month fulfillment are unchanged; monetized payment-period rules still define qualifying
paid conversions regardless of price version.

### 2026-05-06 -- Redeem applied rewards in Impact Advocate

Added rules requiring local KiloClaw free-month reward application to enqueue asynchronous Impact Advocate reward lookup
and single-reward redemption, including retry behavior when rewards are not yet visible and idempotent handling for
already redeemed rewards.

### 2026-04-21 -- Initial KiloClaw spec

Created source-of-truth rules for the KiloClaw referral program using Impact Advocate. Defined program identifiers,
Advocate widget and participant registration requirements, referral-priority attribution over affiliate attribution,
exact 30-day UTC expiration semantics, brand-new and previously deleted user boundaries, first-paid monetized KiloClaw
conversion, double-sided free-month rewards, referrer 12-month cap, atomic reward decisions, pending rewards for
inactive referrers, next-unpaid-renewal reward application, app-owned billing fulfillment, Impact reconciliation
behavior, no Advocate webhook reliance, retryable failure states, tracking-value limits, support-review state, GDPR
handling, Impact identity mapping, and Stripe chargeback reward cancellation.
