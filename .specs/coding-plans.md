# Coding Plans

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in capitalized form.

---

## 1. Plan Catalog

1.1. The system **MUST** present a catalog of coding plans from multiple upstream providers (e.g., Z.AI, GLM, BytePlus, ByteLabs) within app.kilo.ai.

1.2. Each coding plan **MUST** display its associated cost in Kilo Credits.

## 2. Purchase and Billing

2.1. Users **MUST** be able to purchase coding plans using Kilo Credits through the Kilo backend.

2.2. The system **MUST NOT** redirect users to an external provider site to complete a purchase.

## 3. Customer Relationship

3.1. Kilo **MUST** own the customer relationship. The end user's account, credentials, and billing **MUST** be managed entirely within Kilo.

3.2. User identity **MUST** be obfuscated when interacting with upstream providers. Personally identifiable information such as email addresses and passwords **MUST NOT** be forwarded to the provider.

## 4. Provisioning

4.1. Upon purchase, the system **MUST** automatically provision an API key from the upstream provider and associate it with the purchasing user.

4.2. Provisioned API keys **MUST** be stored securely within the Kilo backend.

4.3. The provisioning lifecycle (creation, rotation, revocation) **SHOULD** be managed via direct API integration with each upstream provider.

## 5. Traffic Routing

5.1. All coding plan API traffic **MUST** route through the Kilo gateway (Vercel).

5.2. Coding plan traffic **MUST NOT** route through the OpenRouter path.

5.3. Implementers **MUST** treat the Kilo gateway path and the OpenRouter BYOK path as distinct and independent traffic flows.
