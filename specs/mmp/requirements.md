---
goal: Deliver a production-ready version of `mmp` with verified identities, paid messaging, and compliant notifications.
status: draft
---

## 1) User Stories

1. As a recipient, I can create an account, verify phone and email, and set a message price so I can control who can reach me and what they pay.
2. As a sender, I can discover a recipient via ID and send a message only after paying the required amount.
3. As a user, I can top up and withdraw USDC while preserving on-chain visibility of payments.
4. As a user, I can connect at least one notification channel and receive alerts for paid messages.
5. As an operator, I can monitor message delivery, failed notifications, and payment failures with traceability.

## 2) Functional Requirements (FR)

### FR-1 Identity and Access
- FR-1.1: Users can register with passkey/social login and create a smart account on Base.
- FR-1.2: Users can verify phone with OTP and email via magic-link or OTP.
- FR-1.3: Users can create and manage one canonical public ID and optionally a Basename alias.
- FR-1.4: Users can define pricing policy:
  - default price
  - first-message price
  - optional allowlist discounts
- FR-1.5: Users can opt in/out of discoverability by phone and by public search.

### FR-2 Messaging
- FR-2.1: Senders can look up a recipient by public ID and view pricing before composing.
- FR-2.2: Each message is associated with a hash/fingerprint and payer/recipient.
- FR-2.3: Sender must have sufficient prepaid balance or pay top-up before sending.
- FR-2.4: Successful send always creates on-chain `MessagePaid` event.
- FR-2.5: Recipient receives message in-app inbox regardless of third-party channel failures.

### FR-3 Payments and Ledger
- FR-3.1: Users can deposit USDC into internal balance.
- FR-3.2: Payment for each sent message debits sender balance, credits recipient balance, and deducts fee.
- FR-3.3: Recipients can withdraw available USDC.
- FR-3.4: All on-chain payment events are indexable and retriable.

### FR-4 Notifications
- FR-4.1: Recipient can connect Telegram and opt-in channels.
- FR-4.2: WhatsApp and X notifications are optional and explicit opt-in only.
- FR-4.3: Notification delivery failures must not block in-app message access.

### FR-5 Security and Vault
- FR-5.1: Sensitive connector credentials are stored encrypted at rest.
- FR-5.2: Vault cannot be decrypted with server-side keys alone (separation of trust).
- FR-5.3: Users can rotate/revoke connector access and delete linked credentials.

### FR-6 Operations
- FR-6.1: Admin can pause critical contract operations if abuse/risk detected.
- FR-6.2: System logs immutable payment and moderation events for audits.
- FR-6.3: Abuse detection applies sender/recipient rate limits and device/IP heuristics.

## 3) Non-Functional Requirements (NFR)

### Security
- NFR-S: All auth flows must use secure cookie/session or signed tokens with short lifetime.
- NFR-S: Secrets, vault keys, and external tokens are separated by purpose and encrypted.
- NFR-S: No plaintext phone/email stored on-chain.

### Reliability
- NFR-R: On-chain confirmations and app delivery should have bounded retry and backoff.
- NFR-R: Notification and indexing services must be idempotent.
- NFR-R: Service must tolerate temporary RPC and queue outages without data loss.

### Performance
- NFR-P: Message payment simulation + compose flow < 800ms for 95th percentile.
- NFR-P: End-to-end send acknowledgment < 2.5s p95 under normal conditions.

### Compliance
- NFR-C: Platform integrations only run in compliant opt-in mode.
- NFR-C: Legal/compliance review required before mainnet launch.
- NFR-C: Store explicit consent versions per notification channel.

### Observability
- NFR-O: Distributed traces for user request -> chain tx -> indexer -> inbox write.
- NFR-O: Alerts on failed txs, webhook failures, abnormal withdrawal volumes.

## 4) Non-Goals (v1)

- True carrier-grade iMessage/WhatsApp P2P API as arbitrary transport.
- Full E2E group messaging at launch.
- Arbitrary chain support beyond Base.
- Advanced AI spam/agent automation in v1.

## 5) Acceptance Criteria (Minimum Viable Product)

- AC-1: User can onboard, verify identity, connect notification channel(s), set price, and receive paid message.
- AC-2: Sender can find recipient, fund balance, send a paid message, and see on-chain event.
- AC-3: Recipient can open inbox and view paid messages with metadata.
- AC-4: Top up + withdraw paths are implemented and verifiable.
- AC-5: Notification channels are optional, non-blocking, and compliant by default.
- AC-6: No plaintext sensitive connector credentials in DB exports or server logs.
