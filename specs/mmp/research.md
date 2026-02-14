---
goal: Build `mmp`, a paid inbox on Base where senders pay per message to reach recipients.
status: draft
---

## 1) Intent and Scope

MMP is defined as an anti-spam paid inbox with:
- Pay-per-message economics on-chain (Base/USDC).
- Phone + email verification during onboarding.
- Recipient-configured rates and optional allowlist/reputation logic.
- Multi-channel notification support (Telegram/WhatsApp/X), with strict platform compliance.
- "Credential suitcase" concept: encrypted client-held/secure storage of sensitive connector credentials.

## 2) Critical Feasibility Notes

True P2P messaging via iMessage/WhatsApp/Telegram/X is not always possible via unrestricted APIs.  
Production-safe interpretation:
- Canonical delivery channel is in-app (Web/Mobile inbox).
- External channels are opt-in notification forwarders only.
- External notification must respect platform rules (opt-in and initiation constraints).

This constraint is foundational and is treated as a hard architecture rule.

## 3) Product Shape for `mmp`

- Recipient is reached by a discoverable ID (`@handle`, optional Basename, phone hash/alias).
- Sender must pay per message before composition is accepted.
- Payment debits a prepaid internal USDC ledger on Base to reduce gas/per-message friction.
- On-chain receipts (`MessagePaid`) are generated for verification, indexing, and trust.
- Outbound notifications can be sent to Telegram/WhatsApp/X if explicitly connected and permitted.

## 4) Non-Technical Reference Inputs and Risks

- API policy can change; all integrations need contract tests + integration staging checks.
- Financial flows introduce legal/compliance risk (money movement, KYC/AML, sanctions depending on jurisdiction).
- Gas, chain confirmation latency, and RPC reliability require resilience layers.

## 5) Key Design Decisions (validated now)

1. On-chain payment model: internal balance + event receipts.
2. Default privacy: canonical identifiers are hashed/discoverable only via explicit user controls.
3. Optional rejection and partial refund policy can be introduced after MVP acceptance.
4. Message security should be at least encrypted at rest + TLS from day one; E2E encryption in post-MVP.

## 6) Open Questions

- Jurisdiction and legal review for pooled balances and payouts before public launch.
- Choice of chain infra provider and paymaster strategy for gas subsidy in growth scenarios.
- Whether to support smart account passkey onboarding only, or include wallet-only fallback.
- Whether first release is web-only, mobile app only, or both (web recommended for MVP).
- Whether recipient receives message receipts as soon as payment event finalizes or once delivery queue confirms.
