/**
 * seed-demo — populate Orion Commerce demo dataset
 *
 * Seeds a realistic 8-week decision history for a fictional e-commerce team
 * building the "Orion" checkout and order management system. Covers every
 * ingestion source and query angle so beta testers can explore freely.
 *
 * Team:
 *   sarah_chen    — tech lead
 *   marcus_rowe   — senior engineer
 *   priya_shah    — product manager
 *   james_okafor  — junior engineer
 *   aria          — AI agent (Claude Code sessions)
 *
 * Sources seeded:
 *   ADR document, GitHub PRs, Slack threads, meeting transcript, agent sessions
 *
 * Drift alerts seeded by injecting contradicting events — the drift-detector
 * worker will flag them within ~30s of brain-writer indexing them.
 *
 * Usage:
 *   npm run seed:demo -w apps/api
 *   BRAIN_API_KEY=demo-key npm run seed:demo -w apps/api
 */
import "dotenv/config";
import { Redis } from "ioredis";
import { randomUUID } from "crypto";
import type { CanonicalEvent } from "@purpl/types";

const API_BASE  = process.env.API_BASE  ?? "http://localhost:3001";
const API_KEY   = process.env.BRAIN_API_KEY ?? process.env.DEV_API_KEY ?? "dev-local";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const PROJECT   = "orion_commerce";

const redis = new Redis(REDIS_URL);

// ── Time helpers ──────────────────────────────────────────────────────────────

function weeksAgo(n: number, offsetHours = 0): string {
  return new Date(Date.now() - n * 7 * 24 * 60 * 60 * 1000 + offsetHours * 60 * 60 * 1000).toISOString();
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ── Ingestion helpers ─────────────────────────────────────────────────────────

async function pushToRaw(event: CanonicalEvent): Promise<void> {
  await redis.xadd("events:raw", "*", "event", JSON.stringify(event));
}

async function ingestDocument(body: {
  text: string;
  title: string;
  path?: string;
  document_type?: "adr" | "prd" | "runbook" | "unknown";
  project_id: string;
  source_url: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/brain/ingest/document`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ingest/document failed: ${res.status} ${await res.text()}`);
}

async function ingestTranscript(body: {
  text: string;
  title: string;
  project_id: string;
  source_url: string;
  participants: string[];
}): Promise<void> {
  const res = await fetch(`${API_BASE}/brain/ingest/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ingest/transcript failed: ${res.status} ${await res.text()}`);
}

async function ingestAgentLog(body: object): Promise<void> {
  const res = await fetch(`${API_BASE}/brain/agent-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`agent-log failed: ${res.status} ${await res.text()}`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Dataset ───────────────────────────────────────────────────────────────────

async function seedAll() {
  console.log("\n── Orion Commerce — demo seed ─────────────────────────────────\n");
  console.log(`  API       : ${API_BASE}`);
  console.log(`  Project   : ${PROJECT}`);
  console.log(`  Redis     : ${REDIS_URL}\n`);

  // Verify API is reachable
  try {
    const h = await fetch(`${API_BASE}/health`);
    if (!h.ok) throw new Error(`status ${h.status}`);
  } catch (e) {
    console.error(`  ERROR  Cannot reach ${API_BASE} — is the stack running?\n  ${(e as Error).message}`);
    process.exit(1);
  }

  // ── 1. ADR document (8 weeks ago) ─────────────────────────────────────────
  console.log("  [1/8] ADR-001: Checkout and Cart Architecture");

  await ingestDocument({
    project_id: PROJECT,
    title: "ADR-001: Checkout and Cart Architecture",
    path: "docs/adr/001-checkout-cart.md",
    document_type: "adr",
    source_url: "https://github.com/orion-commerce/platform/blob/main/docs/adr/001-checkout-cart.md",
    text: `# ADR-001: Checkout and Cart Architecture

**Status:** Accepted
**Date:** ${weeksAgo(8)}
**Author:** Sarah Chen (Tech Lead)

## Context

We are building the checkout flow for Orion Commerce v1. Several foundational decisions need to be locked before implementation begins to avoid costly rework.

## Decisions

### 1. Guest checkout is allowed

We will not require account creation to complete a purchase. Data from comparable platforms shows that mandatory account creation results in 23–35% cart abandonment at the checkout step. We will prompt for account creation after a successful order, not before.

### 2. Cart is stored server-side

Cart state is persisted in our database, not in browser localStorage or cookies. This enables abandoned cart recovery emails, cross-device continuity, and accurate inventory holds. The trade-off is slightly higher server load, which is acceptable at our current scale.

### 3. Price is locked at checkout page render

The price shown when a customer enters the checkout flow is the price they pay. If a price changes after the customer has started checkout, they complete at the displayed price. This prevents a class of customer complaints about price bait-and-switch and is standard practice in e-commerce.

### 4. Inventory hold during checkout

Inventory is soft-reserved for 15 minutes when a customer enters the checkout flow (reaches the payment page). If payment is not completed within 15 minutes, the hold is released and the item returns to available stock. On successful payment, the hold becomes a hard reservation confirmed with the warehouse system.

### 5. Order auto-cancel policy

If payment has not cleared within 15 minutes of order placement, the order is automatically cancelled and inventory released. The customer receives a single notification explaining the cancellation. This prevents indefinitely pending orders clogging our fulfilment queue.

## Alternatives considered

- **Browser-based cart storage**: Rejected. Loses cart on device switch, prevents abandoned cart emails, can't enforce inventory holds reliably.
- **30-minute inventory hold**: Rejected. Doubles the lockup time per item with no meaningful improvement in conversion; harms overall inventory availability for other buyers.
- **Price at order placement**: Rejected. Creates confusion when the customer sees a different price at payment vs. confirmation.

## Consequences

These decisions constrain the session management, payment, and inventory subsystems. Deviating from these defaults in a later sprint must be treated as an ADR update, not a silent implementation detail.`,
  });

  // ── 2. GitHub PR — order confirmation flow (6 weeks ago) ─────────────────
  console.log("  [2/8] GitHub PR #34 — order confirmation flow");

  await pushToRaw({
    event_id: `gh_pr_orion_34_${randomUUID().slice(0,8)}`,
    source: "github",
    source_id: "orion-commerce/platform/pull/34",
    project_id: PROJECT,
    actor: { type: "human", id: "marcus_rowe", name: "Marcus Rowe" },
    timestamp: weeksAgo(6),
    event_type: "pr_merged",
    url: "https://github.com/orion-commerce/platform/pull/34",
    raw_content: `PR #34: feat: implement order confirmation and notification flow

Author: Marcus Rowe
Merged by: Sarah Chen

Description:
Implements the order confirmation email flow. Based on discussion with Sarah before I started:
the confirmation email must only fire after BOTH payment is confirmed AND inventory is reserved.
Never on payment alone.

---

**Sarah Chen** (review comment):
This is exactly right. We had a wave of customer complaints two quarters ago when a previous
system sent confirmation emails the moment payment succeeded — before checking if we actually
had stock. Customers received beautiful confirmation emails for orders we couldn't fulfil.
The return emails were painful. Payment AND inventory. Both. Non-negotiable.

**James Okafor** (comment):
What happens if payment succeeds but the inventory check fails?

**Sarah Chen** (reply):
We refund the customer immediately via Stripe's refund API and send a single
"sorry, we ran out of stock" email. Better to disappoint once cleanly than
to confirm and then cancel. Marcus, make sure the refund path is covered in tests.

**Marcus Rowe** (reply):
Done — added tests for the payment-success / inventory-fail path.
OrderEmailService now has a hard guard: both conditions must be true
before email dispatch is allowed.`,
  });

  // ── 3. GitHub PR — refund policy (6 weeks ago) ────────────────────────────
  console.log("  [3/8] GitHub PR #37 — refund policy decision");

  await pushToRaw({
    event_id: `gh_pr_orion_37_${randomUUID().slice(0,8)}`,
    source: "github",
    source_id: "orion-commerce/platform/pull/37",
    project_id: PROJECT,
    actor: { type: "human", id: "priya_shah", name: "Priya Shah" },
    timestamp: weeksAgo(6, 3),
    event_type: "pr_merged",
    url: "https://github.com/orion-commerce/platform/pull/37",
    raw_content: `PR #37: docs: v1 refund policy

Author: Priya Shah
Merged by: Sarah Chen

Description:
Documenting the refund policy we agreed on in this morning's call.

For v1: full refunds only. No partial refunds.

Marcus pushed back on this — his concern is that if a 3-item order has one out-of-stock
item discovered late, a full refund is clunky. I understand the concern but I'm making
the call: partial refunds introduce too many edge cases with our current inventory model,
the payment reconciliation logic, and our support team's tooling. We can revisit in Q3
once we have data on how often this actually happens.

The partial refund path should be explicitly blocked in the refund service, not just
absent — so we catch it at code review if someone tries to add it before we're ready.

**Sarah Chen** (review):
Agreed. Clean over clever for v1. Approving.

**Marcus Rowe** (comment):
Noted. I've added a NotImplementedError to the partial refund method with a comment
pointing to this PR for context.`,
  });

  // ── 4. GitHub issue — Apple Pay closed (5 weeks ago) ─────────────────────
  console.log("  [4/8] GitHub issue #41 — Apple Pay closed out of scope");

  await pushToRaw({
    event_id: `gh_issue_orion_41_${randomUUID().slice(0,8)}`,
    source: "github",
    source_id: "orion-commerce/platform/issues/41",
    project_id: PROJECT,
    actor: { type: "human", id: "sarah_chen", name: "Sarah Chen" },
    timestamp: weeksAgo(5),
    event_type: "pr_closed",
    url: "https://github.com/orion-commerce/platform/issues/41",
    raw_content: `Issue #41: Add Apple Pay and Google Pay to checkout

Closing this issue. Apple Pay and Google Pay are out of scope for v1.

When we scoped this properly, the integration effort came out at roughly 3x our
original estimate once you account for: domain verification requirements,
the merchant identity certificate setup, the Stripe Payment Element migration
needed to support both wallets cleanly, and the testing matrix across Safari
versions and iOS devices.

Our current user base is 87% desktop (from analytics). The conversion uplift
from wallet payments is meaningful on mobile, much less so on desktop.

Decision: implement standard card payment for v1, add wallet payments to the
Q2 roadmap when we have mobile traffic data to justify the investment.

Closing. /cc @priya_shah @marcus_rowe`,
  });

  // ── 5. Slack threads (4 weeks ago) ────────────────────────────────────────
  console.log("  [5/8] Slack threads — inventory display + SMS scope");

  await pushToRaw({
    event_id: `slack_inv_${randomUUID().slice(0,8)}`,
    source: "slack",
    source_id: "C_engineering_inv_thread",
    project_id: PROJECT,
    actor: { type: "human", id: "priya_shah", name: "Priya Shah" },
    timestamp: weeksAgo(4),
    event_type: "slack_message",
    url: "https://orion-commerce.slack.com/archives/C_engineering/p_inv",
    slack_channel: "engineering",
    raw_content: `Priya Shah: Quick decision needed — do we show exact stock counts to customers?
Like "Only 3 left in stock"?

Marcus Rowe: I'd lean yes. Creates urgency and helps buyers make faster decisions.

Sarah Chen: No exact counts. Showing our exact inventory position lets competitors
track our stock levels. It also causes panic buying that distorts our reorder signals
and can create artificial scarcity for regular customers.

The rule: show one of three states only.
- "In Stock" (10 or more units)
- "Low Stock" (1–9 units — without a number)
- "Out of Stock"

That's it. The threshold numbers are internal, not shown.

Priya Shah: Makes sense, Sarah's right. Going with the three-state display.
Marcus can we update the ProductAvailability component?

Marcus Rowe: On it.`,
  });

  await pushToRaw({
    event_id: `slack_sms_${randomUUID().slice(0,8)}`,
    source: "slack",
    source_id: "C_product_sms_thread",
    project_id: PROJECT,
    actor: { type: "human", id: "james_okafor", name: "James Okafor" },
    timestamp: weeksAgo(4, 2),
    event_type: "slack_message",
    url: "https://orion-commerce.slack.com/archives/C_product/p_sms",
    slack_channel: "product",
    raw_content: `James Okafor: Are we doing SMS order notifications? I saw some design mockups
that included SMS but I don't see it in the spec.

Priya Shah: SMS is out of scope for v1. Email only.

Sarah Chen: Correct. SMS adds: carrier integrations, opt-in compliance (TCPA in the US,
GDPR implications in EU), number validation, delivery status tracking, and a per-message
cost that adds up fast. All of that for a channel our customers haven't asked for yet.

Email handles order lifecycle notifications for v1. We can add SMS in v2 if users
ask for it.

James Okafor: Got it, removing from my sprint tasks.`,
  });

  // ── 6. Meeting transcript — order modification debate (4 weeks ago) ────────
  console.log("  [6/8] Meeting transcript — sprint planning, order edge cases");

  await ingestTranscript({
    project_id: PROJECT,
    title: "Sprint Planning — Order Management Edge Cases",
    source_url: "https://orion-commerce.notion.so/meetings/sprint-planning-order-edge-cases",
    participants: ["Sarah Chen", "Marcus Rowe", "Priya Shah", "James Okafor"],
    text: `Sprint Planning — Order Management Edge Cases
${weeksAgo(4, 1)}
Attendees: Sarah Chen, Marcus Rowe, Priya Shah, James Okafor

Priya Shah: I want to settle the order modification question today. Can customers change their order after placing it?

Sarah Chen: No. The answer is no for v1. Here's why — the moment an order is placed, it enters the fulfilment queue. By the time a customer realises they ordered the wrong size or colour, we may have already picked and packed it. Supporting modification means we either have a cut-off window that's hard to communicate clearly, or we build a recall flow with the warehouse. Both are significant.

Marcus Rowe: What if it's just a shipping address change? That seems low-risk since it doesn't touch inventory.

Sarah Chen: Still no for v1. An address change after payment means we need to verify the new address, potentially re-run fraud checks, and make sure our fulfilment partner gets the updated address before dispatch. There are also cases where the original address was in a supported delivery zone and the new one isn't. I don't want to build all the exception handling for a feature we don't have user demand for yet.

Priya Shah: Agreed. No order modification. We show a clear message at checkout: "Please review your order carefully — changes are not possible after placing." And we make sure the checkout UI is clear enough that people don't get confused about what they're ordering.

James Okafor: What about cancellations? Can customers cancel before dispatch?

Sarah Chen: Cancellation is different — it's a single clean operation. Customer cancels, we release inventory, we issue a full refund. That's in scope for v1. What's out of scope is modification.

Marcus Rowe: So to be clear: cancel yes, modify no.

Sarah Chen: Exactly.`,
  });

  // ── 7. Agent sessions — Aria's implementation decisions (1 week ago) ──────
  console.log("  [7/8] Agent sessions — Aria (implementation decisions)");

  await ingestAgentLog({
    schema_version: "1.0",
    session_id: `aria_payment_${randomUUID()}`,
    agent_id: "aria",
    project_id: PROJECT,
    task_id: "implement-payment-flow",
    codebase: "orion-commerce/platform",
    timestamp_start: daysAgo(9),
    timestamp_end: daysAgo(9),
    decisions: [
      {
        id: "d1",
        description: "Used idempotency keys on all Stripe API calls",
        rationale: "Payment requests can be safely retried without risk of double-charging the customer. The idempotency key is derived from the order_id so retries on the same order always use the same key regardless of which server handles the retry.",
        alternatives_considered: ["retry without idempotency keys", "no retries — fail fast"],
        confidence: "high" as const,
      },
      {
        id: "d2",
        description: "Did not implement webhook signature verification for the shipping carrier API",
        rationale: "The shipping carrier's sandbox environment does not send valid signatures, which blocked local testing. Deferred to pre-launch checklist. Without verification, a spoofed webhook could update order status incorrectly — this is high priority before go-live.",
        alternatives_considered: ["verify in prod only", "mock verification in tests"],
        confidence: "high" as const,
      },
    ],
    work_completed: "Implemented Stripe payment intent creation, confirmation, and webhook handling. Idempotency keys on all write calls. Shipping carrier webhook receiver scaffolded.",
    files_modified: ["src/payments/stripe-client.ts", "src/webhooks/shipping-carrier.ts"],
    next_steps: ["Add signature verification to shipping webhook before go-live"],
  });

  await ingestAgentLog({
    schema_version: "1.0",
    session_id: `aria_orders_${randomUUID()}`,
    agent_id: "aria",
    project_id: PROJECT,
    task_id: "implement-order-state-machine",
    codebase: "orion-commerce/platform",
    timestamp_start: daysAgo(7),
    timestamp_end: daysAgo(7),
    decisions: [
      {
        id: "d1",
        description: "Modelled order status as a string enum rather than boolean flags",
        rationale: "Enum states are mutually exclusive, which matches the real-world constraint that an order cannot be simultaneously 'confirmed' and 'cancelled'. Boolean flags allow invalid states like is_confirmed=true AND is_cancelled=true. Enum also makes it easy to add states later without schema changes — just extend the enum.",
        alternatives_considered: ["boolean flags (is_confirmed, is_dispatched, etc.)", "integer state codes"],
        confidence: "high" as const,
      },
      {
        id: "d2",
        description: "Auto-cancel timer implemented as a background job polling every 5 minutes",
        rationale: "A per-order scheduled task would require a job scheduler with persistence and exactly-once delivery guarantees. At our current order volume, a background job that scans for pending orders older than 15 minutes and runs every 5 minutes is simpler to operate, easier to debug, and carries at most 5 minutes of extra hold time — acceptable per the ADR.",
        alternatives_considered: ["per-order scheduled task", "database triggers"],
        confidence: "high" as const,
      },
      {
        id: "d3",
        description: "Inventory soft-reserve uses a 15-minute TTL in Redis, matching the ADR-001 hold period",
        rationale: "TTL-based expiry in Redis is atomic and self-cleaning. When the TTL expires, the reservation disappears without a cleanup job. The hold period matches ADR-001's 15-minute checkout window so inventory is released exactly when the order would auto-cancel.",
        alternatives_considered: ["database row with expiry timestamp", "30-minute TTL"],
        confidence: "high" as const,
      },
    ],
    work_completed: "Implemented order state machine, auto-cancel background job, and Redis-based inventory reservation with TTL.",
    files_modified: ["src/orders/order-state.ts", "src/orders/auto-cancel-job.ts", "src/inventory/reservation.ts"],
    next_steps: ["Hook inventory reservation release into order cancellation flow"],
  });

  await ingestAgentLog({
    schema_version: "1.0",
    session_id: `aria_inventory_${randomUUID()}`,
    agent_id: "aria",
    project_id: PROJECT,
    task_id: "implement-inventory-availability",
    codebase: "orion-commerce/platform",
    timestamp_start: daysAgo(5),
    timestamp_end: daysAgo(5),
    decisions: [
      {
        id: "d1",
        description: "Out-of-stock check at payment time queries the inventory database directly, bypassing Redis cache",
        rationale: "The Redis cache is the source for the 15-minute soft-reserve TTL, not for current stock counts. Querying the cache at payment time risks stale reads — a cache hit could show 'in stock' for an item that was hard-reserved by another completed order 30 seconds ago. The extra 20ms database round-trip at payment is worth the accuracy guarantee.",
        alternatives_considered: ["query Redis cache", "query Redis + DB with fallback"],
        confidence: "high" as const,
      },
    ],
    work_completed: "Wired payment confirmation handler to direct inventory DB check before emitting order-confirmed event.",
    files_modified: ["src/payments/webhook-handler.ts"],
    next_steps: [],
  });

  // ── 8. Drift-triggering events (today) ───────────────────────────────────
  console.log("  [8/8] Drift events — three contradictions for drift detection");

  // Drift 1: Early confirmation email (contradicts email-only-after-both policy)
  await pushToRaw({
    event_id: `gh_pr_drift1_${randomUUID().slice(0,8)}`,
    source: "github",
    source_id: "orion-commerce/platform/pull/89",
    project_id: PROJECT,
    actor: { type: "human", id: "james_okafor", name: "James Okafor" },
    timestamp: daysAgo(1),
    event_type: "pr_opened",
    url: "https://github.com/orion-commerce/platform/pull/89",
    raw_content: `PR #89: feat: add early order preparation email

Adding a new transactional email: "Your order is being prepared!"

This fires immediately when payment is confirmed by Stripe, before the inventory
reservation is finalised. The goal is to improve the post-purchase experience —
customers currently see nothing for up to 30 seconds after paying while we run
the inventory check, which feels broken.

I've added a new OrderPreparationEmail that triggers in the PaymentSucceededHandler,
right after we receive the Stripe payment_intent.succeeded webhook.

This is separate from the existing order confirmation email (which still requires
both payment and inventory). Think of this as a "we got your payment, hang tight"
message.`,
  });

  // Drift 2: Partial refund implementation (contradicts full-refunds-only policy)
  await pushToRaw({
    event_id: `gh_pr_drift2_${randomUUID().slice(0,8)}`,
    source: "github",
    source_id: "orion-commerce/platform/pull/91",
    project_id: PROJECT,
    actor: { type: "human", id: "marcus_rowe", name: "Marcus Rowe" },
    timestamp: daysAgo(1),
    event_type: "pr_opened",
    url: "https://github.com/orion-commerce/platform/pull/91",
    raw_content: `PR #91: feat: partial refund support for multi-item orders

Implementing partial refund capability. Use case: a 3-item order where one item
goes out of stock after payment. Currently we issue a full refund and ask the
customer to reorder — terrible experience.

This adds a PartialRefundService that refunds individual line items via Stripe's
refund API with an amount parameter. The refund amount is calculated from the
line item price including any discounts applied at checkout.

I know this was deferred in PR #37 but we've now had 12 customer support tickets
in 2 weeks specifically about this scenario. Feels like the right time.`,
  });

  // Drift 3: Apple Pay implementation (contradicts issue #41 closure)
  await ingestAgentLog({
    schema_version: "1.0",
    session_id: `aria_applepay_${randomUUID()}`,
    agent_id: "aria",
    project_id: PROJECT,
    task_id: "implement-apple-pay",
    codebase: "orion-commerce/platform",
    timestamp_start: daysAgo(2),
    timestamp_end: daysAgo(2),
    decisions: [
      {
        id: "d1",
        description: "Implemented Apple Pay and Google Pay using the Stripe Payment Element",
        rationale: "The Stripe Payment Element covers Apple Pay, Google Pay, and Link in a single integration. The merchant certificate setup was simpler than expected using Stripe's hosted domain verification. Feature is shipped behind a FEATURE_WALLET_PAYMENTS flag and disabled by default.",
        alternatives_considered: ["Stripe Checkout (hosted page)", "manual Apple Pay JS SDK"],
        confidence: "high" as const,
      },
    ],
    work_completed: "Migrated checkout payment form from Stripe CardElement to PaymentElement. Apple Pay and Google Pay now available in supported browsers when FEATURE_WALLET_PAYMENTS=true.",
    files_modified: ["src/checkout/payment-form.tsx", "src/config/features.ts"],
    next_steps: ["Enable FEATURE_WALLET_PAYMENTS in staging for QA"],
  });

  console.log("\n  All events queued. Waiting 40s for pipeline processing...\n");
  await sleep(40_000);

  // Verify queries work
  console.log("  Verifying brain is queryable...");
  let queryable = false;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${API_BASE}/brain/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ query: "What is the order confirmation email policy?", project_id: PROJECT }),
    });
    if (res.ok) {
      const body = await res.json() as { answer?: string; citations?: unknown[] };
      if ((body.citations ?? []).length > 0) { queryable = true; break; }
    }
    await sleep(5_000);
  }

  await redis.quit();

  // ── Print suggested queries ───────────────────────────────────────────────
  console.log("\n─────────────────────────────────────────────────────────────────");
  console.log("  Demo seed complete.\n");

  if (!queryable) {
    console.log("  ⚠  Brain did not become queryable within timeout.");
    console.log("     Try the queries below in ~30s once the pipeline catches up.\n");
  }

  console.log(`  Project ID : ${PROJECT}`);
  console.log(`  API key    : ${API_KEY}\n`);

  const queries = [
    ["Decision retrieval",   "Why does the order confirmation email only send after both payment and inventory are confirmed?"],
    ["Attribution — person", "What did Priya decide about refunds?"],
    ["Attribution — agent",  "What did Aria implement for payment reliability?"],
    ["Temporal diff",        "What changed in the order management approach over the last two months?"],
    ["Rejection decision",   "Why did we decide not to support order modifications?"],
    ["Scope decision",       "What did we decide about SMS notifications?"],
    ["Drift alerts",         "Show me open drift alerts"],
    ["Graph traversal",      "What decisions are connected to the inventory reservation system?"],
    ["Author query",         "What decisions has Sarah made?"],
    ["Won't-do list",        "What did we decide not to build in v1?"],
  ];

  console.log("  ── Suggested queries to try ─────────────────────────────────\n");
  for (const [label, q] of queries) {
    console.log(`  ${label.padEnd(22)}  "${q}"`);
  }

  console.log("\n  ── Drift alerts to explore ──────────────────────────────────\n");
  console.log("  Three contradictions were seeded. After the drift-detector runs (~30s),");
  console.log("  GET /brain/drift-alerts?project_id=orion_commerce will show:");
  console.log("  1. Early preparation email contradicts 'email only after both confirmed'");
  console.log("  2. Partial refund PR contradicts 'full refunds only in v1'");
  console.log("  3. Aria's Apple Pay session contradicts 'wallet payments out of scope for v1'");
  console.log("\n─────────────────────────────────────────────────────────────────\n");
}

seedAll().catch(e => {
  console.error("\nSeed failed:", e);
  process.exit(1);
});
