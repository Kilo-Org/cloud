# Coding Plans

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in capitalized form.

---

## Definitions

**Coding Plan** - A recurring subscription product that grants a user access through Kilo to an upstream provider plan by installing its issued credential in the user's existing personal BYOK provider slot. A user's later BYOK changes do not alter Coding Plan billing.

**Plan Catalog** - The set of Coding Plan offerings enabled by Kilo. The catalog is controlled by trusted application configuration and may contain one or more offerings.

**Plan ID** - A stable identifier for a purchasable Coding Plan offering. A Plan ID is distinct from the upstream provider or routing identifier used to execute API traffic.

**Upstream Plan ID** - The MiniMax-issued identifier paired with a Managed Plan Credential and used by support to deprovision that provider plan. It is operational metadata, not the Kilo Plan ID.

**Managed Plan Credential** - An upstream API key acquired or provisioned by Kilo for a Coding Plan. Kilo manages its assignment and revocation. It is paired with an Upstream Plan ID and is not exposed to the subscriber after it is installed in BYOK.

**Installed BYOK Configuration** - A normal personal BYOK entry that Kilo initially populates with a Managed Plan Credential. While unchanged, it identifies Token Plan Plus as its origin and Kilo may delete it at Effective Cancellation. A subscriber may test, enable, disable, update, or delete it using normal BYOK operations. Replacing its credential transfers cleanup ownership to the subscriber.

**Availability Notification Intent** - A user's plan-scoped request to be notified when a sold-out Coding Plan has capacity again. It is not a reservation, purchase, subscription, or entitlement.

**Manual Revocation Work Item** - Durable inventory remediation state requiring authorized support staff to deprovision an issued MiniMax plan using its stored Upstream Plan ID through the provider admin process and record its outcome in Kilo. The initial pilot represents this work on the inventory row and does not require a separate remediation audit-event history. MiniMax does not provide an automated revocation integration for the initial release.

**Kilo Credits** - The unit of account used for Coding Plan billing. The pricing layer manages conversion to internal microdollar accounting; user-facing surfaces display `Credits` as the payment source and charged amounts in USD.

**Upstream Provider** — An external API vendor whose plan access is offered through Kilo. The initial planned offering uses MiniMax.

**Obfuscated Identity** — An irreversible, per-provider cryptographic hash of a user's internal identifier, used when Kilo must identify a subscriber to an upstream provider without sending personally identifiable information.

**Effective Cancellation** — The time when a Coding Plan ceases to provide access. For a user-requested cancellation, this is the end of the already-paid billing period. For account deletion or an immediate administrative termination, this is immediate.

---

## 1. Plan catalog

1.1. The system **MUST** present the configured Plan Catalog within app.kilo.ai. The catalog **MAY** contain a single offering.

1.2. Each catalog entry **MUST** have a stable Plan ID and **MUST** display its provider name, plan name, recurring USD price, billing period, and payment source. Coding Plans paid from a user's credit balance **MUST** identify `Credits` as their payment source.

1.3. Kilo's backend **MUST** be the source of truth for the set of available Coding Plans and their pricing. A change to enabled offerings or price **MUST** be deployed through controlled application configuration or code review.

1.4. A Plan ID **MUST NOT** be treated as the upstream provider identity. Multiple future plans from one upstream provider **MAY** coexist without extending or replacing one another unless their product rules explicitly state otherwise.

1.5. The initial implementation is intended to configure one offering: MiniMax Token Plan Plus. This initial offering does not impose a requirement that future catalogs contain MiniMax or any minimum number of offerings.

1.6. When no assignable Managed Plan Credential exists for an offering, customer-facing catalog responses **MUST** identify the offering as sold out without exposing credential counts or credential metadata.

## 2. Subscription and billing

2.1. Users **MUST** be able to purchase a Coding Plan using Kilo Credits through Kilo. The system **MUST NOT** redirect a user to an upstream provider to subscribe.

2.2. The system **MUST** allow at most one non-terminal subscription for a given user and Plan ID. A terminal subscription **MUST NOT** prevent a later new subscription to the same Plan ID.

2.3. Each purchase request **MUST** include an idempotency key scoped to the user and Plan ID. Retrying a successfully processed request with the same idempotency key **MUST** return the original outcome and **MUST NOT** create an additional billing period, charge, or credential assignment.

2.4. The initial release **MUST NOT** sell an additional prepaid period for a non-terminal subscription. A successful idempotent retry **MUST** return the existing purchase result; all other purchase attempts while a subscription is `active` or `past_due` **MUST** be rejected. Later-period billing occurs only through recurring renewal in the initial release.

2.5. The system **MUST** atomically perform initial activation: verify that the user's personal provider slot is unoccupied, debit sufficient Kilo Credits using a guarded balance operation, claim an available Managed Plan Credential, create the Installed BYOK Configuration, record the charged term, and create the active subscription. If any step fails, none of those effects **MUST** commit.

2.6. A failed initial activation **MUST NOT** commit a debit that later needs a compensating refund. The user **MUST** receive an error that indicates whether the failure was insufficient credits or unavailable plan capacity without exposing credential material.

2.7. Each charged term **MUST** snapshot the plan price and billing period applied to it. A later catalog price change **MUST NOT** retroactively alter a paid term.

## 3. Customer relationship and managed access

3.1. Kilo **MUST** manage the subscriber's account relationship, subscription status, and Kilo Credit billing. Kilo **MUST NOT** send a subscriber's email address, name, password, or other personally identifiable account data to an upstream provider.

3.2. When an upstream operation needs subscriber attribution, Kilo **MUST** use only an Obfuscated Identity unless another non-PII identifier is required by an approved provider contract.

3.3. A Managed Plan Credential remains controlled by Kilo for inventory and revocation. A subscriber **MUST NOT** receive its raw value through application UI or API responses in the initial release.

3.4. On activation, Kilo **MUST** configure an Installed BYOK Configuration in the ordinary personal provider slot so eligible traffic can use the plan through the Kilo Gateway. Activation **MUST** fail without charge or assignment if that provider slot is occupied, including by a disabled key.

3.5. While an Installed BYOK Configuration still contains Kilo's issued credential, user-facing BYOK surfaces **MUST** identify its Coding Plan origin. Ordinary BYOK test, enable/disable, update, and delete operations **MUST** remain available. Before updating, disabling, or deleting that configuration, Kilo **MUST** warn that the operation changes routing but does not cancel subscription billing and **MUST** direct cancellation to the Subscription Center. Updating the credential **MUST** mark the entry as user-managed and detach it from later Coding Plan cleanup; deleting it **MUST NOT** cancel or pause the subscription. Testing or re-enabling the key does not require this warning.

## 4. Credential provisioning and inventory

4.1. Kilo **MUST** acquire or provision Managed Plan Credentials before accepting a purchase that depends on them. For an offering initially provisioned by operator upload, only authorized administrative tooling **MAY** insert credentials into inventory.

4.2. Available and assigned credentials **MUST** be encrypted at rest. Raw credentials **MUST NOT** appear in logs, analytics, error messages, customer responses, ordinary BYOK responses, or administrative inventory and remediation responses. Authorized administrative remediation surfaces **MAY** display the stored Upstream Plan ID needed to revoke issued MiniMax access.

4.3. Inventory **MUST** distinguish at least these credential lifecycle states: available, assigned, revocation pending, revoked, and revocation failed.

4.4. An available credential **MUST** be assigned at most once. Once assigned, it **MUST NOT** return to available inventory, including after cancellation, failed revocation, user deletion, or a later re-subscription.

4.5. A new subscription **MUST** be confirmed active only after an available credential is claimed and its Installed BYOK Configuration has been created within Kilo.

4.6. When no available credential exists for the requested plan, activation **MUST** fail without debiting credits or creating a subscription.

4.7. Kilo **MUST** retain the Upstream Plan ID and non-secret assignment and revocation disposition evidence on inventory records for the required operational and compliance retention period. When an issued credential enters manual revocation remediation, Kilo **MUST** remove retained encrypted credential material because support deprovisions it using the Upstream Plan ID. After the applicable retention period, terminal credential records **MAY** be deleted without deleting billing history.

4.8. Administrative upload tooling **MUST** accept each MiniMax issued credential with its Upstream Plan ID, using the `<api key>::<upstream plan id>` input format or an equivalent structured input, and **MUST** persist the identifier on the inventory record without treating it as the Kilo Plan ID.

4.9. Administrative upload tooling **MUST** prevent accidental duplicate credential assignment without exposing raw credential values in list responses, for example through a secure, non-reversible fingerprint comparison.

4.10. Before a MiniMax credential becomes `available` inventory, administrative upload tooling **MUST** validate that it can use the approved ordinary MiniMax routing and model behavior for Token Plan Plus. An invalid or incompatible credential **MUST NOT** become assignable inventory.

## 5. Subscription lifecycle

5.1. A Coding Plan with successful activation enters `active` state and remains billable until its paid period ends or it is terminated immediately under this section. A subscriber's BYOK updates, disablement, or deletion **MUST NOT** change that billing lifecycle.

5.2. When a user requests cancellation, the subscription **MUST** stop renewing and **MUST** remain paid through the end of its current period. On the first billing lifecycle sweep processing the subscription at or after Effective Cancellation, Kilo **MUST** delete its Installed BYOK Configuration only if that configuration is still linked and Kilo-installed, and **MUST** create a Manual Revocation Work Item for the originally issued credential. Kilo **MUST NOT** delete a replacement or later user-created provider key.

5.3. An uninterrupted successful renewal **MUST** extend paid access using the existing assigned credential. The system **MUST** debit the snapshotted renewal price atomically with recording the new charged term.

5.4. If a subscription reaches renewal without sufficient Kilo Credits and the user has not enabled applicable auto-top-up, the next billing lifecycle sweep **MUST** terminate it, delete only a still-linked Installed BYOK Configuration, and create a Manual Revocation Work Item for the issued credential.

5.5. If a subscription reaches renewal without sufficient Kilo Credits and the user has enabled applicable auto-top-up, the system **MUST** trigger no more than one auto-top-up attempt for that due term, move the subscription to `past_due`, and allow payment recovery for a grace period calculated as no more than 24 hours from the due time.

5.6. During the `past_due` recovery period, arrival of sufficient credits before the stored grace deadline **MUST** allow one atomic renewal debit and restore `active` status. If renewal cannot be funded by that deadline, the next billing lifecycle sweep **MUST** terminate the subscription, delete only a still-linked Installed BYOK Configuration, and create a Manual Revocation Work Item for the issued credential.

5.7. A user-requested cancellation **MUST NOT** trigger auto-top-up. Updating, disabling, or deleting an Installed BYOK Configuration **MUST NOT** trigger cancellation or affect renewal billing.

5.8. When a user account is deleted, Kilo **MUST** immediately terminate any Coding Plan subscription, delete the user's BYOK configurations and Availability Notification Intents under the general deletion policy, create a Manual Revocation Work Item for each issued credential, and anonymize subscriber linkage in retained credential disposition records. Account deletion **MUST NOT** wait until the end of a prepaid period. Subscription and charged-term history **MAY** remain associated with the platform's anonymized user record when required for financial or compliance retention.

5.9. Manual upstream revocation **MUST** be completed by authorized support through the MiniMax admin process using the stored Upstream Plan ID, and its outcome **MUST** be recorded on the inventory item in Kilo. Pending and failed work **MUST** remain visible in the admin console for remediation. Kilo **MUST** keep the Coding Plan terminated while revocation is pending or failed. An issued credential awaiting or failing revocation **MUST NOT** be reassigned; a separate user-managed provider key **MUST NOT** be removed because of revocation work.

5.10. The initial pilot **MAY** leave an unchanged Kilo-installed BYOK configuration routable between its paid-period or grace deadline and the next scheduled billing lifecycle sweep. Once that sweep processes termination, local Kilo-installed access **MUST** be deleted regardless of whether manual upstream revocation is complete.

## 6. Traffic routing

6.1. Initial Token Plan Plus setup **MUST** route through the Kilo Gateway using the existing ordinary personal MiniMax BYOK provider identity. The initial release **MUST NOT** expose saved raw credential values through Kilo UI or API responses.

6.2. The system **MUST NOT** add a Token Plan Plus-specific provider or model-routing namespace. The Kilo-installed MiniMax key and any later subscriber replacement **MUST** use ordinary MiniMax BYOK routing and model availability.

6.3. Purchase **MUST** reject an occupied personal MiniMax BYOK slot before a charge or issued credential assignment commits. Once subscribed, a user's ordinary MiniMax BYOK actions affect routing configuration only; Coding Plan billing and revocation of Kilo's originally issued credential remain independent.

## 7. User-facing behavior

7.1. Users **MUST** be able to view catalog offerings, purchase a Coding Plan, view their subscription status and paid-period dates, and request cancellation from Kilo surfaces.

7.2. Coding Plan surfaces **MUST** display recurring prices and charged-term amounts in USD regardless of payment source. Kilo Credits are valued one-to-one with USD for display. Surfaces **MUST** identify `Credits` as the payment source for credit-funded subscriptions and **MUST NOT** expose internal microdollars.

7.3. While an Installed BYOK Configuration is unchanged, the BYOK surface **MUST** identify it as configured by Token Plan Plus. Before updating, disabling, or deleting it, the surface **MUST** warn that routing changes do not cancel subscription billing and direct the user to Subscription Center to cancel. Saved raw-key view or copy controls **MUST NOT** be added for customer BYOK surfaces.

7.4. Purchase messaging **MUST** state that Kilo configures MiniMax in BYOK and **MUST** tell users with an existing MiniMax key to delete it before subscribing. Cancellation messaging **MUST** state when billing ends, that Kilo deletes only its unchanged installed configuration, and that Kilo revokes its issued credential when plan access ends.

7.5. A `past_due` subscription **MUST** communicate its grace deadline with date and local time, the consequence of unsuccessful payment recovery, and that a replacement or user-created MiniMax BYOK key is not deleted by Coding Plan termination.

7.6. A sold-out offering **MUST** display its unavailable state and **MUST** offer an authenticated user a way to record an Availability Notification Intent. Recording the same intent again **MUST** be idempotent, **MUST NOT** reserve capacity or initiate billing, and **MUST** show the saved intent state. A successful activation **MUST** clear the activated user's intent for that Plan ID.

## 8. Security and observability

8.1. Logs and monitoring **MUST NOT** contain raw Managed Plan Credentials, credential-bearing authorization headers, provider-management secrets, or unfiltered provider/SDK key-test error content.

8.2. General administrative credential inventory responses **MUST** return non-secret status and remediation metadata only. For a `revocation_pending` or `revocation_failed` item, the manual-revocation admin console **MAY** display its Upstream Plan ID to authorized staff. Raw credential values **MUST NOT** be returned by queue, list, or remediation APIs or appear on customer surfaces.

8.3. The initial pilot does not require a Coding Plans audit-log history for admin inventory upload or manual revocation actions. Inventory lifecycle state, Upstream Plan ID, request/completion timestamps, attempt count, and sanitized failure information **MUST** record current disposition without retaining raw credentials after remediation starts.
