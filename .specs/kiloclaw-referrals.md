# KiloClaw Referral Program

## Role of This Document

This spec defines KiloClaw referral program business rules and invariants powered by Impact Advocate. It is the source
of truth for _what_ the system must guarantee: eligibility, referral/affiliate attribution conflict resolution, referral
conversion timing, reward granting/fulfillment, and behavior when Impact Advocate or billing integrations are
unavailable. It does not prescribe _how_ to implement those guarantees; handler names, column layouts, retry strategies,
and other implementation details belong in plans and code.

## Status

Draft -- created 2026-04-21. Updated 2026-05-06 -- require Impact Advocate reward redemption after local reward
application. Updated 2026-05-12 -- note price-versioned billing preserves referral semantics.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT
RECOMMENDED", "MAY", and "OPTIONAL" are interpreted as described in BCP 14 [RFC 2119] [RFC 8174] only when they appear
in all capitals, as shown here.

## Definitions

- **Impact Advocate**: Impact.com referral product used to generate share links, register referral participants,
  attribute referred users, and report referral lifecycle and reward events.
- **Impact Performance Program**: Existing Impact.com affiliate/conversion program for KiloClaw, CampaignId `50754`.
- **Advocate Program**: Impact Advocate referral program for KiloClaw, ProgramId `51699`.
- **UTT (Universal Tracking Tag)**: Impact.com JavaScript snippet that enables client-side tracking, first-party cookies,
  and identity bridging.
- **Advocate widget**: Impact Verified Access in-app widget `p/51699/w/referrerWidget` for logged-in users to access
  referral share links and referral status.
- **Referrer**: Existing user who shares a referral link and may earn a referral reward when an eligible referee
  converts.
- **Referee**: Referred user who arrives through a referral link, creates a Kilo account, and may earn a referral reward
  after their first eligible paid KiloClaw conversion.
- **Referral touch**: Captured Impact Advocate attribution interaction, including `_saasquatch` and related referral
  parameters or cookies. The value is opaque to Kilo.
- **Valid referral touch**: Referral touch with a non-empty `_saasquatch` value, associated with the converting user's
  pre-signup session or user record, where `conversion_time < touched_at + 30 * 24 hours` using server UTC timestamps.
- **Affiliate touch**: Captured Impact affiliate interaction, including the `im_ref` click identifier. The value is
  opaque to Kilo.
- **Sale-attributed affiliate touch**: Affiliate touch already used to report a SALE conversion to Impact. This protects
  the initial SALE and subsequent KiloClaw renewals from referral override, so an affiliate who already earned SALE
  attribution continues receiving affiliate renewal attribution under the affiliate tracking spec.
- **Attribution touch**: Referral touch or affiliate touch considered by KiloClaw conversion-time attribution
  resolution.
- **Valid touch**: Attribution touch that has not expired, belongs to the converting user or their pre-signup session,
  and is eligible for the conversion being evaluated.
- **Referral-priority attribution**: KiloClaw referral/affiliate conflict-resolution model: at conversion time, a valid
  referral touch wins over an affiliate touch unless that affiliate touch has already been sale-attributed.
- **First paid KiloClaw conversion**: Referee's first confirmed paid personal KiloClaw subscription payment period,
  whether funded by Stripe settlement, hybrid settlement, or pure-credit deduction. Trial start does not qualify, nor
  does a purchase of inference / credits.
- **Monetized KiloClaw payment period**: KiloClaw billing period with positive Stripe-settled value, positive hybrid
  settled value, or positive credit deduction. Zero-dollar invoices, fully comped periods, and admin adjustments are not
  monetized payment periods.
- **Free-month reward**: Local KiloClaw billing reward that delays the beneficiary's next KiloClaw renewal by one
  calendar month. It is not a general account credit.
- **Calendar month**: Billing-period extension that preserves day-of-month semantics of the current KiloClaw billing
  calendar, clamping to the last valid day of the target month when necessary.
- **Reward beneficiary**: User who may receive a free-month reward. Beneficiary roles are `referrer` and `referee`.
- **Reward state**: Durable lifecycle state for a reward. Required states are `pending`, `earned`, `applied`,
  `reversed`, `expired`, `canceled`, and `review_required`.
- **Active eligible personal KiloClaw subscription**: Personal KiloClaw subscription that is active, not canceling at
  period end, not suspended, and not past due.
- **Personal KiloClaw subscription**: KiloClaw subscription owned by an individual user. Organization/team-scoped
  KiloClaw subscriptions are not eligible.
- **Brand-new Kilo account**: User identity with no current or historical Kilo user identity under the configured
  identity key before the referral touch. Adding an auth provider to an existing user is not brand-new.
- **Reward-bearing referral configuration**: Environment configuration required to create referral touches, register
  Advocate participants, report Impact conversions, grant local rewards, and apply KiloClaw billing extensions.
- **Chargeback**: Stripe dispute event for the qualifying Stripe payment.
- **Fraud-marked payment**: Qualifying payment marked fraudulent by Stripe, an internal fraud process, or an authorized
  operator.
- **Support review**: Durable `review_required` reward state with the triggering reason, affected billing period, and
  source payment or dispute recorded. Kilo team review is required before an already-applied reward can be canceled,
  clawed back, or otherwise adjusted.
- **Impact-facing status field**: Local status retained only to compare Kilo state with Impact dashboard exports or API
  reads; it cannot drive eligibility, reward granting, or billing fulfillment.

## Overview

The KiloClaw referral program is double-sided: when an eligible existing user refers an eligible new KiloClaw paying
subscriber, referrer and referee each earn one free KiloClaw month. A reward is earned only after the referee's first
confirmed paid personal KiloClaw subscription payment and is fulfilled by delaying the beneficiary's next KiloClaw
renewal by one calendar month.

Impact Advocate owns referral sharing, share links, referral cookies, participant registration, and Advocate program
reporting. Impact may mirror referral priority and reward settings for reporting, but Kilo owns authoritative product
eligibility, affiliate/referral attribution conflict resolution, first-paid-conversion detection, reward grant
idempotency, reward caps, and billing fulfillment.

Existing Impact Performance Program conversion events drive Impact Advocate conversion state. The system uses
`Sale (71659)` as the paid-conversion event for paid KiloClaw periods, including renewals.

This program applies only to personal KiloClaw subscriptions. Organization-scoped KiloClaw instances, team plans, admin
interventions, and non-KiloClaw purchases are out of scope.

Price-versioned KiloClaw billing does not change referral eligibility, attribution priority, first-paid-conversion
timing, reward caps, or free-month fulfillment. A first paid KiloClaw conversion remains governed by monetized
payment-period rules, regardless of the subscription price version.

## Rules

### Program Configuration

1. The system MUST treat these identifiers as integration configuration constants:
   - Impact Account: `7138521`
   - Impact Performance CampaignId: `50754`
   - Impact Advocate ProgramId: `51699`
   - UTT UUID: `A7138521-9724-4b8f-95f4-1db2fbae81141`
   - Advocate widget ID: `p/51699/w/referrerWidget`

2. The system MUST use existing Impact Performance conversion action tracker IDs for KiloClaw lifecycle reporting:

   | Event       | ActionTrackerId | Trigger                                       |
   | ----------- | --------------- | --------------------------------------------- |
   | VISIT       | 71668           | Visitor lands on `kilo.ai` with `im_ref`      |
   | SIGNUP      | 71655           | New user creation with attribution            |
   | TRIAL_START | 71656           | KiloClaw trial subscription becomes active    |
   | TRIAL_END   | 71658           | KiloClaw trial subscription ends (any reason) |
   | SALE        | 71659           | Monetized KiloClaw payment period is funded   |

3. Impact Advocate API credentials MUST remain server-side and MUST NOT be exposed to the browser.

4. If Impact Advocate configuration is absent, referral sharing, participant registration, and Impact reconciliation MAY
   be disabled, but the application MUST continue to function normally.

5. If reward-bearing referral configuration is absent in an environment where the referral program is enabled:
   - the system MUST fail closed for reward issuance;
   - the system MUST log the configuration failure; and
   - the system MUST NOT silently mark rewards or Impact work as completed.

6. Referral UTT loading is controlled by the application's public Impact UTT configuration for the active environment.

### Advocate Experience

7. Logged-in users MUST access referral sharing through the Impact Verified Access widget.

8. The system MUST authenticate users to Impact Advocate using the configured Verified Access contract: the JWT header
   MUST set `kid` to the Impact Account SID, the JWT payload MUST contain the top-level `user` object, and the JWT MUST
   be signed with the Impact Advocate Auth Token.

9. The Impact Advocate identity contract for Kilo is: `id = plain user email`, `accountId = plain user email`, and
   `email = plain user email`.

10. The system MUST NOT allow users to alter the identity payload used to establish Advocate identity.

11. The system MUST register every Kilo user issued an Impact Advocate Verified Access token as a participant in the
    Advocate program server-side, even when the user has no inbound referral attribution. This MUST happen no later than
    the first token issuance for that user. Registration MUST be idempotent across repeat issuances and MUST persist the
    SaaSquatch-issued referral code per rule 51, so the user becomes resolvable as the referrer when their referees
    later convert.

### Client-Side Tracking and Identity

12. The system MUST load the Impact UTT script on pages used by the referral program when the UTT identifier is
    configured and MUST NOT load it otherwise.

13. The system MUST invoke Impact `identify` on pages used by the referral program.

14. Anonymous `identify` calls MUST pass empty string values for unknown `customerId` and `customerEmail`. The system
    MUST NOT pass `undefined`, `null`, placeholders, or fake identifiers for unknown users.

15. Logged-in `identify` calls MUST pass a stable customer identifier and SHA-1 hashed email.

16. `identify` calls MUST include a stable `customProfileId` derived from the Kilo user ID for logged-in users and a
    stable first-party anonymous ID for anonymous users.

17. The system MUST treat `_saasquatch`, `rsCode`, `rsShareMedium`, `rsEngagementMedium`, `im_ref`, and related tracking
    values as opaque. The system MUST NOT parse, validate the internal format of, or assign meaning to these values.

18. Opaque tracking values MUST have a documented maximum accepted length, MUST be stored as UTF-8 strings, and MUST be
    ignored for attribution when they exceed that maximum. Logs MUST redact or truncate opaque tracking values.

### Referral Touch Capture

19. When a visitor opens an Impact Advocate referral link, the system MUST recognize that referral before signup and
    preserve it through account creation so the referral can be associated with the newly created user.

20. A referral touch is valid for attribution only when it contains a non-empty `_saasquatch` value. If `_saasquatch` is
    absent, the system MAY preserve related metadata for diagnostics but MUST NOT treat it as a valid referral touch.

21. A referral touch SHOULD include related opaque metadata when available, including `rsCode`, `rsShareMedium`,
    `rsEngagementMedium`, UTM parameters, and sanitized landing path.

22. Referral touch capture MUST preserve attribution across the authentication flow, including OAuth redirects and
    callback URLs.

23. Referral touches MUST expire 30 days after the touch time. A touch is valid only when `conversion_time < touched_at
    - 30 \* 24 hours`, using server UTC timestamps. A touch at or after that instant is expired.

24. The system MUST associate pre-signup referral touches with the created user during signup or first authenticated
    request after signup.

25. Capturing or associating a referral touch MUST NOT grant a reward.

26. If a user arrives with multiple referral touches, the system MUST preserve enough chronological information to
    resolve referral-priority attribution at conversion time.

### Affiliate and Referral Attribution Priority

27. KiloClaw referral rewards and KiloClaw affiliate attribution MUST share a 30-day conversion-time attribution window.

28. At first paid KiloClaw conversion time, the system MUST evaluate valid affiliate and referral touches together.

29. For KiloClaw conversions governed by this referral spec, referral-priority attribution overrides the permanent
    first-touch affiliate attribution rules in `.specs/kiloclaw-affiliates.md`.

30. A valid referral touch MUST win over a valid affiliate touch unless the affiliate touch has already been
    sale-attributed before the referral touch occurred. Initial attribution for a not-yet-attributed SALE MUST prefer
    the valid referral touch.

31. A sale-attributed affiliate touch MUST keep affiliate attribution for the initial SALE and subsequent KiloClaw
    renewals only when that initial SALE occurred before the referral touch. Referral touches MUST NOT retroactively
    override those affiliate-attributed SALE events.

32. If multiple valid referral touches exist and no sale-attributed affiliate touch is present, the oldest valid
    referral touch MUST win.

33. If no valid referral touch exists, the oldest valid affiliate touch MUST win.

34. If all touches are expired or invalid, neither affiliate attribution nor referral rewards win for that conversion.

35. If an affiliate touch wins, the system MUST NOT grant referral rewards for that conversion.

36. If a referral touch wins, the system MUST NOT attribute that first paid KiloClaw conversion to an affiliate for
    reward or payout purposes.

37. The system MUST record when an affiliate touch has been attributed to a SALE conversion to preserve affiliate
    attribution for that initial sale and subsequent KiloClaw renewals.

38. The system MUST implement at least these attribution outcomes.

| Scenario                                                                     | Expected winner |
| ---------------------------------------------------------------------------- | --------------- |
| Affiliate first, referral second, both valid, no prior affiliate SALE        | Referral        |
| Affiliate first, referral second, both valid, affiliate SALE before referral | Affiliate       |
| Referral first, affiliate second, both valid, no prior affiliate SALE        | Referral        |
| Only affiliate valid                                                         | Affiliate       |
| Only referral valid                                                          | Referral        |
| All touches expired or invalid                                               | None            |

39. Attribution resolution for referral rewards MUST happen at conversion time, not only at signup time.

40. Impact-side attribution MUST NOT override local eligibility, reward caps, or billing fulfillment decisions.

### Referred Participant Registration

41. When a new user signs up with `_saasquatch` attribution, the system MUST attempt to register or upsert the user as a
    referred participant in Impact Advocate.

42. Register Participant requests MUST be made server-side.

43. Register Participant requests MUST pass the captured `_saasquatch` value as opaque cookie attribution.

44. Register Participant requests SHOULD include locale and country code when available.

45. If `_saasquatch` is present during signup, referral touch association and participant registration enqueueing MUST
    occur before signup is considered complete, but external Impact delivery MUST NOT block user access.

46. Register Participant failures MUST be recorded for retry or reconciliation.

47. Transient participant registration failures MUST leave the registration in a retryable state until it succeeds, is
    superseded by a corrected payload, or is marked permanently failed by an operator-visible terminal state.

48. Register Participant requests that fail with client errors MUST be logged and MUST NOT be retried until the request
    payload or configuration is corrected.

49. Register Participant requests MUST use the user's plain email for Advocate `id` and `accountId`.

50. Register Participant requests MUST include plain-text email only as the Advocate contact email.

51. On a successful Register Participant response, the system MUST persist the program-scoped referral code returned in
    `referralCodes[<programId>]` against the participant record so inbound referral touches can resolve the originating
    Advocate user. Persistence MUST be idempotent: re-running registration for the same participant MUST NOT corrupt or
    duplicate the code. If another participant already holds the same code (vanishingly unlikely under SaaSquatch's
    per-tenant uniqueness guarantee, but constraint-protected on the Kilo side), the new participant's code MUST NOT be
    persisted; the rest of the registration success state MUST still be recorded.

### Referee Eligibility

52. A referee MUST be a brand-new Kilo account to qualify for referral rewards.

53. Existing users MUST NOT qualify as referees, even if they later click a referral link.

54. Adding an auth provider to an existing Kilo user MUST NOT qualify as a brand-new Kilo account.

55. Previously deleted users MUST NOT qualify as referees. Disqualification MUST use a legal-approved normalized-email
    hash tombstone.

56. A referee MUST convert on a personal KiloClaw subscription. Team plans, organization-scoped KiloClaw subscriptions,
    and non-KiloClaw subscriptions MUST NOT qualify.

57. A referee MUST make a first confirmed paid KiloClaw subscription payment before either side earns a reward.

58. The first confirmed paid KiloClaw subscription payment MUST fund a monetized KiloClaw payment period.

59. Trial start, trial end, account signup, widget registration, zero-dollar invoices, fully comped periods, admin
    adjustments, or referral touch capture MUST NOT qualify as a paid referral conversion.

60. A referee's renewals after the first paid KiloClaw conversion MUST NOT generate additional referral rewards.

61. A user MUST NOT refer themselves. The system MUST disqualify a referral when the referrer and referee resolve to the
    same Kilo user.

62. Fraudulent, test, admin-created, or manually adjusted subscriptions MUST NOT qualify for referral rewards unless an
    authorized operator explicitly marks the conversion as eligible under a documented support process.

### Referrer Eligibility

63. A referrer MUST be a Kilo user registered or registerable as an Impact Advocate participant.

64. A referrer's current KiloClaw subscription state MUST NOT prevent reward earning.

65. If a referrer has no active eligible personal KiloClaw subscription when the reward is earned, the system MUST keep
    the reward pending so it can be applied when the referrer starts or reactivates an eligible personal KiloClaw
    subscription.

66. A pending inactive-referrer reward MUST expire and be canceled 12 months after it is earned if the referrer has not
    started or reactivated an eligible paid personal KiloClaw subscription.

67. A pending referrer reward MUST NOT apply to a KiloClaw trial. It MUST apply to the next unpaid renewal boundary
    after the referrer starts or reactivates a paid personal KiloClaw subscription.

68. A referrer MUST NOT receive more than 12 total free-month rewards from the referral program.

69. The referrer cap MUST be enforced before granting a referrer reward.

70. The 12-month referrer cap MUST be enforced atomically across concurrent reward grants. Concurrent processing MUST
    NOT produce more than 12 granted referrer reward months.

71. When a qualified referral occurs after the referrer has reached the 12-month cap, the system MUST record that the
    referrer reward was cap-limited and MUST NOT grant another referrer free month.

72. Referee rewards MUST NOT count against the referrer's 12-month cap.

### Reward Granting

73. A qualified referral conversion MUST grant one free-month reward to the referee.

74. A qualified referral conversion MUST grant one free-month reward to the referrer. The reward MUST be marked
    cap-limited instead of granted when the referrer cap has been reached or another referrer eligibility rule prevents
    it.

75. Referral reward granting MUST be idempotent. Processing the same qualifying conversion multiple times MUST NOT
    create duplicate rewards for the same beneficiary role.

76. For a qualified referral, reward grant processing MUST be atomic across both beneficiary reward decisions. Both
    beneficiary outcomes MUST be recorded together, including granted, cap-limited, and disqualified outcomes.

77. Reward records MUST identify the source referral, source conversion, beneficiary user, beneficiary role, number of
    months granted, status, and relevant timestamps.

78. Reward records MUST support the reward states defined in this spec.

79. A reward MUST NOT be considered fulfilled until KiloClaw billing state and any required Stripe state have been
    updated to delay the corresponding KiloClaw renewal.

80. Impact Advocate reward state MAY be used for reconciliation, support, or reporting. It MUST NOT be the source of
    truth for local free-month fulfillment.

### Reward Fulfillment and Billing

81. Free-month rewards MUST be fulfilled by delaying a KiloClaw renewal by one calendar month per reward.

82. An earned reward applies to the beneficiary's next unpaid renewal boundary after the reward is earned. It MUST NOT
    modify already-finalized invoices or already-funded periods.

83. Free-month rewards MUST NOT be fulfilled as general account credits.

84. Free-month rewards MUST apply to KiloClaw billing only. They MUST NOT apply to inference usage, Kilo Pass, team
    plans, or non-KiloClaw purchases.

85. Multiple free-month rewards MAY stack. Each applied reward MUST delay renewal by exactly one calendar month.

86. For month-to-month KiloClaw subscriptions, one reward MUST delay the next monthly renewal by one calendar month.

87. For six-month commitment KiloClaw subscriptions, one reward MUST delay the next six-month renewal by one calendar
    month. The reward MUST NOT convert the subscription to month-to-month and MUST NOT reduce the next invoice by one
    sixth.

88. For pure-credit KiloClaw subscriptions, reward application MUST update local renewal state so the credit renewal
    sweep does not deduct KiloClaw hosting credits until the extended renewal time.

89. For Stripe-funded or hybrid KiloClaw subscriptions, reward application MUST keep local billing state and Stripe
    billing state consistent. The system MUST NOT create a local-only renewal delay for a Stripe-funded subscription
    while allowing Stripe to charge on the original schedule.

90. Reward application MUST be idempotent. Retrying reward application MUST NOT extend the same subscription more than
    once for the same reward.

91. Reward application MUST record an audit trail containing the reward, beneficiary, affected subscription, previous
    renewal or period boundary, new renewal or period boundary, and any external billing operation identifiers.

92. Reward application MUST NOT break existing KiloClaw billing invariants for trials, pure-credit renewal, hybrid
    invoice settlement, commit plans, plan switching, cancellation, reactivation, past-due recovery, suspension, or
    destruction.

93. Reward application MUST respect cancellation state. If a subscription is canceled or canceling before reward
    application, the reward MUST remain pending until the beneficiary has an active eligible personal KiloClaw
    subscription.

### Impact Conversion Reporting

94. Impact Advocate referral conversion MUST be driven by existing Impact Performance conversion events.

95. `Sale (71659)` MUST be the paid KiloClaw conversion event used for referral conversion and renewal reporting.

96. The system MUST NOT dispatch client-side `trackConversion` for referrals while server-side Performance conversion is
    the configured reporting mechanism.

97. When a referral wins attribution and the first paid conversion qualifies, the system MUST ensure Impact receives the
    required Performance conversion data for Advocate conversion reporting.

98. Conversion reporting MUST use deterministic order identifiers where possible so retries do not create duplicate
    Impact actions.

99. Conversion reporting failures MUST NOT block billing settlement, reward ledger creation, or user access. Failures
    MUST leave the conversion report in a retryable state until it succeeds, is superseded by a corrected payload, or is
    marked permanently failed by an operator-visible terminal state.

### Impact Reconciliation

100. The system MUST NOT rely on Impact Advocate webhooks for referral eligibility, reward granting, billing
     fulfillment, or reconciliation.

101. The system MAY use Impact dashboard exports or API reads for manual reconciliation and support investigations.

102. Impact reconciliation data MAY update local Impact-facing status fields, but it MUST NOT bypass local eligibility,
     cap, attribution, or billing fulfillment rules.

### Refunds, Reversals, and Fraud

103. Rewards from a qualifying Stripe payment MUST be canceled if Stripe reports a chargeback for that payment.

104. Pending or earned-but-unapplied rewards MUST be canceled when the qualifying Stripe payment is charged back.

105. Already-applied rewards from a charged-back Stripe payment MUST be marked for support review and MUST NOT be
     automatically canceled or clawed back.

106. Rewards from refunded or fraud-marked payments MUST be canceled before application. Already-applied rewards from
     refunded or fraud-marked payments MUST be marked for support review and MUST NOT be automatically canceled or
     clawed back.

107. If a qualifying Impact action must be reversed, the system SHOULD use Impact's reverse-action mechanism instead of
     creating an unrelated negative conversion.

108. Reversal and reward-cancellation handling MUST be idempotent.

### GDPR and PII

109. Referral tables that store user IDs, emails, referral relationships, IP addresses, referral cookies, Impact IDs, or
     reconciliation payloads MUST be included in GDPR soft-delete or anonymization flows.

110. GDPR deletion MUST delete or anonymize referral participant records, referral touch records, referral relationship
     records, reconciliation payloads containing PII, and reward records to the extent required by policy.

111. Plain email stored for Impact Advocate compatibility MUST be deleted or anonymized during GDPR deletion.

112. Previously deleted user disqualification MUST use a legal-approved non-PII tombstone or irreversible hash. The
     system MUST NOT retain PII solely for this purpose.

113. Referral tracking values MUST NOT be logged in a way that exposes secrets, auth headers, cookies, or unnecessary
     PII.

### Reliability and Isolation

114. Referral touch capture, participant registration, conversion reporting, reconciliation processing, and reward
     fulfillment failures MUST NOT break unrelated product functionality.

115. Reward ledger operations MUST be transactional where needed to prevent duplicate grants, partial grants, or missing
     audit records.

116. Reward fulfillment failures MUST leave rewards in a retryable state unless the failure is a permanent eligibility
     or configuration failure.

117. The system MUST expose enough operational state to distinguish pending Impact registration, pending Impact
     conversion reporting, pending local reward application, applied rewards, reversed rewards, canceled rewards,
     review-required rewards, and disqualified referrals.

118. Admin-only subscription interventions, internal test conversions, and support adjustments MUST NOT emit referral
     rewards or Impact referral conversions unless explicitly marked as eligible by an authorized operator.

### Existing Internal Referral System

119. The existing internal referral-code system MUST NOT grant additional KiloClaw referral rewards for conversions
     already governed by this spec.

120. Before launch, the existing internal referral system MUST be scoped away from KiloClaw, disabled for KiloClaw, or
     migrated into this program's rules to prevent double rewards.

### Impact Reward Redemption

121. When a local free-month reward is applied to KiloClaw billing, the system MUST mark the corresponding Impact
     Advocate credit reward as redeemed so Impact reporting matches Kilo's fulfillment state.

122. Impact Advocate reward redemption MUST happen asynchronously and MUST NOT block reward application, billing
     settlement, or user access.

123. Before redeeming an Impact Advocate reward, the system MUST fetch the beneficiary account's rewards from Impact
     Advocate and select the corresponding credit reward ID.

124. Redeeming an Impact Advocate reward MUST use Impact Advocate's single-reward redemption endpoint with the local
     reward's granted month count and the configured free-month reward unit.

125. Impact Advocate reward lookup and redemption attempts MUST be idempotently queued per local reward.

126. If the Impact reward is not yet visible when redemption is attempted, the system MUST leave the redemption work in
     a retryable state.

127. Impact reward redemption state is for reporting and reconciliation only. It MUST NOT be the source of truth for
     local reward eligibility, application, cancellation, or reversal.

## Error Handling

1. If referral touch capture fails, the system SHOULD log the failure and continue the primary request.

2. If Register Participant delivery fails with a server error or timeout, the system MUST leave the registration in a
   retryable state.

3. If Register Participant delivery fails with a client error, the system MUST log the error and MUST NOT retry
   unchanged payloads.

4. If Impact conversion reporting fails with a server error or timeout, the system MUST leave the report in a retryable
   state.

5. If Impact conversion reporting fails with a client error, the system MUST log the error and MUST NOT retry unchanged
   payloads.

6. If reward grant processing detects an ineligible referee, ineligible referrer, expired attribution, self-referral,
   exceeded cap, or non-personal subscription, the system MUST record the disqualification reason when a referral record
   exists.

7. If reward application fails after a reward is earned, the reward MUST remain retryable unless the failure is
   permanent and auditable.

8. If required billing state is ambiguous, the system MUST NOT apply a reward. It MUST leave the reward pending and log
   the ambiguity for investigation.

9. If Impact Advocate reward lookup or redemption fails with a server error or timeout, the system MUST leave the
   redemption work in a retryable state.

10. If Impact Advocate reward lookup or redemption fails with a client error, the system MUST log the error and MUST NOT
    retry unchanged payloads, except an already-redeemed response MAY be treated as idempotent success.

## Changelog

### 2026-05-12 -- Price-versioned billing preserves referral semantics

Reviewed against KiloClaw price-versioned billing. Referral eligibility, attribution priority, first-paid-conversion
timing, reward caps, and free-month fulfillment are unchanged; monetized payment-period rules still define qualifying
paid conversions regardless of price version.

### 2026-05-06 -- Redeem applied rewards in Impact Advocate

Added rules requiring local free-month reward application to enqueue asynchronous Impact Advocate reward lookup and
single-reward redemption, including retry behavior when rewards are not yet visible and idempotent handling for already
redeemed rewards.

### 2026-04-21 -- Initial spec

Created source-of-truth rules for the KiloClaw referral program using Impact Advocate. Defined program identifiers,
Advocate widget and participant registration requirements, referral-priority attribution over affiliate attribution,
exact 30-day UTC expiration semantics, brand-new and previously deleted user boundaries, first-paid monetized KiloClaw
conversion, double-sided free-month rewards, referrer 12-month cap, atomic reward decisions, pending rewards for
inactive referrers, next-unpaid-renewal reward application, app-owned billing fulfillment, Impact reconciliation
behavior, no Advocate webhook reliance, retryable failure states, tracking-value limits, support-review state, GDPR
handling, Impact identity mapping, and Stripe chargeback reward cancellation.
