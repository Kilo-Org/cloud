---
name: specs
description: Business-rule specs for KiloClaw billing/lifecycle/controller/data model/Composio, MCP Gateway auth, model experiments, Security Agent, subscription center, team/enterprise seat billing, Impact affiliate/referrals, Kilo Pass, organization SSO, Stripe early fraud warnings, and coding plans. Load when you need context about the business requirements that guided the implementation.
---

# Business-Rule Specs

Specs in `.specs/` are context as to the original business intention, rules and
invariants of the domains they cover. Consult them for context and flag inconsistencies
to the user if instructions or changes will cause deviations from the original intent. 

## Index

| Spec | Governs |
|---|---|
| `.specs/kiloclaw-billing.md` | KiloClaw billing, pricing, invoicing, usage metering, payment flows |
| `.specs/kiloclaw-billing-lifecycle.md` | KiloClaw billing lifecycle — credit-renewal orchestration safety |
| `.specs/kiloclaw-composio.md` | KiloClaw Composio credential provisioning, injection, and sharing |
| `.specs/kiloclaw-controller.md` | KiloClaw controller/machine lifecycle, bootstrap, Docker image |
| `.specs/kiloclaw-datamodel.md` | KiloClaw data model — instance/subscription tables, invariants |
| `.specs/mcp-gateway-auth.md` | Kilo MCP Gateway v1 — protocol surface, ownership, OAuth lifecycle, provider grants, runtime auth |
| `.specs/model-experiments.md` | Model experiment routing, bucketing, lifecycle, prompt retention, and reporting rules |
| `.specs/security-agent.md` | Security Agent Auto Remediation and finding/SLA notification guarantees |
| `.specs/subscription-center.md` | Subscription Center ownership, states, and user-facing behavior |
| `.specs/team-enterprise-seat-billing.md` | Team and Enterprise seat billing, subscription management |
| `.specs/impact-affiliate-tracking.md` | Impact.com affiliate conversion tracking |
| `.specs/impact-referrals.md` | Impact.com Advocate referral programs for KiloClaw and Kilo Pass |
| `.specs/kilo-pass.md` | Kilo Pass states, provider support, credit amounts, eligibility, lifecycle |
| `.specs/organization-sso.md` | Organization SSO enforcement — auth requirements, membership admission/removal, policy inheritance |
| `.specs/stripe-early-fraud-warnings.md` | Stripe Early Fraud Warning enforcement — scope, containment, financial unwinding, remediation |
| `.specs/coding-plans.md` | Coding Plans business rules (RFC 2119 normative language) |

`.specs/template.md` is the authoring template for new specs, not a governed domain.
