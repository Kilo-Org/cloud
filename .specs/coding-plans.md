# Coding Plans

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in capitalized form.

---

## Definitions

**Coding Plan** — A recurring subscription product that grants a user an API key for an upstream provider's API. Subscriptions are billed periodically in Kilo Credits. A coding plan remains active until it is cancelled or the user's credit balance is insufficient to renew. The API key belongs to the subscribing user, who may use it both through the Kilo gateway and independently outside of Kilo.

**Kilo Credits** — The unit of account within Kilo used for billing. The conversion between Kilo Credits and the internal microdollar accounting system is managed by the pricing layer; specs and user-facing surfaces refer only to Kilo Credits.

**Upstream Provider** — An external API vendor (e.g., Z.AI, GLM, BytePlus, ByteLabs) whose coding services are resold through Kilo as coding plans.

**Pre-Purchased Key** — An API key that Kilo has acquired from an upstream provider in advance and stored in its database, ready to be assigned to a user upon subscription creation.

**Kilo Gateway** — The Kilo-operated API reverse proxy. Traffic routed through the gateway uses the user's assigned coding plan key on their behalf.

**BYOK (Bring Your Own Key) Path** — The separate traffic flow and user-facing key management surface for API keys that users supply themselves, independent of coding plans.

**Obfuscated Identity** — An irreversible, per-provider cryptographic hash of the user's internal identifier, used to represent the user to upstream providers without exposing personally identifiable information.

---

## 1. Plan Catalog

1.1. The system **MUST** present a catalog of coding plans from multiple upstream providers (e.g., Z.AI, GLM, BytePlus, ByteLabs) within app.kilo.ai.

1.2. Each coding plan **MUST** display its associated recurring cost in Kilo Credits and its billing period.

## 2. Subscription and Billing

2.1. Users **MUST** be able to subscribe to coding plans using Kilo Credits through the Kilo backend.

2.2. The system **MUST NOT** redirect users to an external provider site to complete a subscription.

2.3. The system **MUST** reject a subscription if the user's available Kilo Credits balance is less than the plan's cost. Credit deduction and subscription activation **MUST** be atomic — either both succeed or neither takes effect.

2.4. The system **MUST** ensure that concurrent subscription requests from the same user for the same plan are handled idempotently — at most one subscription is fulfilled per plan per user.

2.5. If a user already holds an active subscription to the same upstream provider, a new purchase **MUST** extend the existing subscription rather than creating a duplicate.

## 3. Customer Relationship

3.1. The end user's account, credentials, and billing **MUST** be managed entirely within Kilo. No upstream provider **MAY** have direct contact with or visibility into the end user.

3.2. The system **MUST** identify users to upstream providers using only obfuscated identities (irreversible, per-provider cryptographic hashes). Personally identifiable information such as email addresses, names, and passwords **MUST NOT** be forwarded to any upstream provider.

## 4. Provisioning

4.1. Kilo **MUST** pre-purchase API keys from upstream providers and store them in the database before they are needed. When a subscription is created, the Kilo backend **MUST** assign a pre-purchased key to the subscribing user and configure it in the user's BYOK section. The key **MUST** be available to the user before the subscription is confirmed as active.

4.2. The Kilo backend **MUST** store all unassigned (pre-purchased) API keys encrypted at rest. Unassigned keys **MUST NOT** appear in application logs, error messages, or API responses.

4.2.1. Once a key is assigned to a user, the user **MUST** be able to view and copy their API key through the Kilo UI. The key belongs to the user and they **MAY** use it outside of Kilo.

4.3. If no pre-purchased key is available for the requested upstream provider at the time of subscription, the system **MUST** reject the subscription, refund any deducted credits, and surface an error to the user. The system **MUST NOT** debit credits for a plan whose key assignment has failed.

4.4. The provisioning lifecycle (creation, rotation, revocation) **SHOULD** be managed via direct API integration with each upstream provider in a future version. For v1, Kilo operators **MAY** pre-purchase and upload keys manually.

## 5. Subscription Lifecycle

5.1. When a subscription expires, is cancelled, or the user's account is deleted, the system **MUST** immediately remove the associated API key from the user's BYOK configuration within Kilo. The system **MUST NOT** revoke the key with the upstream provider, because the key belongs to the user and they may continue to use it independently outside of Kilo.

5.2. Revocation of keys on account deletion **MUST** be included in the GDPR soft-delete flow.

## 6. Traffic Routing

6.1. When a user sends API traffic through Kilo, coding plan keys **MUST** route through the Kilo-operated API gateway. Users **MAY** also use their assigned API key directly with the upstream provider, outside of Kilo.

6.2. Within Kilo, coding plan traffic **MUST NOT** share routing infrastructure with traffic that uses user-supplied (BYOK) API keys. These two traffic classes **MUST** be treated as distinct and independent flows.

## 7. Purchase Processing Order

7.1. The system **MUST** process a new subscription in this order: (1) verify sufficient credit balance, (2) atomically deduct credits and record the subscription, (3) assign a pre-purchased API key to the user's BYOK configuration, (4) confirm the subscription as active to the user.
