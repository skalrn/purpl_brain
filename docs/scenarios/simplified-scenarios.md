# Purpl Brain — Simplified Scenarios for General Audiences

**Purpose:** Two scenarios using a universally understood SaaS problem space — user
permissions and billing seats. The technical decisions are simple enough that any
product person, engineer, or investor can follow the logic. The contradictions are
not bugs in any individual piece of code; they are mismatches between business
assumptions baked silently into separate pieces of correct-looking work.

**The product:** SimpleTeam — a B2B team collaboration SaaS with three plans:
- **Free:** up to 3 members, no admin customisation
- **Pro:** $12/seat/month, unlimited members, custom roles
- **Enterprise:** custom pricing, SSO, audit logs

**Characters:**
- **Jordan** — Product Manager
- **Sam** — Backend engineer
- **Darius** — Frontend engineer
- **Priya** — New engineer, joined 4 weeks ago
- **claude-code** — AI coding agent used by Sam
- **cursor-agent** — AI coding agent used by Darius

---

## Scenario A: Two Correct Decisions That Only Conflict When Combined

### The setup

SimpleTeam is building the billing system. Jordan writes the PRD for the seat
counter — the number that determines what the customer pays each month.

**Jordan's PRD (Notion, shared in #product-eng):**

```
Billing: Seat Count Definition

A "billable seat" is any workspace member who has accepted their invitation.
Invited-but-not-yet-accepted users do not count — we don't charge for people
who haven't shown up yet.

Billing runs on the 1st of each month. The seat count is taken at midnight UTC
on that date.
```

> **Jordan [Slack, #product-eng, 9:14 AM]**
> Seat count PRD is up. Keep it simple — accepted members only, snapshot on the
> 1st. @Sam this is yours for the backend, @Darius the billing settings page
> needs to show the live seat count so admins know what they'll be charged.

---

### Sam's agent session — billing backend

Sam opens Claude Code on `simpleteam-api`. Session start query:

```
brain_query(
  query: "What decisions exist around user membership status and billing?",
  project_id: "simpleteam_api"
)
```

**Brain returns:**

```
No prior decisions on billing seat counting. One related decision from ADR-002
(4 months ago): invitation expiry is 7 days — expired invitations are hard-deleted
from the database, not soft-deleted. Accepted invitations transition the row to a
member record.
[Source: github/PR #87, ADR-002]
```

Sam writes `src/services/billing/seat-counter.ts`:

```typescript
// Count members with status = 'active' (accepted invitation)
// Excludes: invited, expired, deactivated
async function getBillableSeatCount(workspaceId: string): Promise<number> {
  const result = await db('members')
    .where({ workspace_id: workspaceId, status: 'active' })
    .count('id as count');
  return Number(result[0].count);
}
```

At session end, Claude Code logs:

```
brain_log_decision(
  session_id: "sam-billing-seat-counter",
  work_completed: "Built seat counter for billing. Counts members with
                   status = active (accepted invitation). Excludes invited,
                   expired, deactivated.",
  decisions: [{
    id: "billable-status-definition",
    description: "Billable seat = member row with status 'active'. Invited
                  members (status = 'invited') are not counted.",
    rationale: "Matches PRD: accepted members only. Invited-but-not-accepted
                users are excluded because they have not yet accessed the product.",
    alternatives_considered: ["count all non-expired members including invited"],
    confidence: "high"
  }]
)
```

---

### Darius's agent session — billing settings UI

Two days later, Darius builds the billing settings page. Cursor fires the session
start query:

```
brain_query(
  query: "How does the billing seat count work — what counts as a seat?",
  project_id: "simpleteam_web"
)
```

The brain returns Sam's decision from two days ago:

```
Billable seat = member row with status 'active'. Invited members not counted.
[Source: sam-billing-seat-counter session, 2 days ago]
```

Good. Darius knows the definition. He builds the settings page. As part of the UI,
he adds a live seat count that shows admins exactly what they'll be billed for —
and a list of pending invitations below it with a note:

```
These 3 people have been invited but haven't accepted yet.
They are not counted in your current seat total.
Adding them will increase your bill by $36/month.
```

This copy is factually correct per the PRD. Darius submits PR #201.

---

### The problem, invisible in both PRs

Sam's backend and Darius's frontend are both individually correct. But Darius's UI
copy introduces a business assumption that Sam's code does not support:

> *"Adding them will increase your bill by $36/month."*

This implies that the moment an invited user **accepts**, the seat count increments
immediately and they are billed at the next billing cycle.

But Sam's billing job runs a **snapshot at midnight UTC on the 1st**. There is no
trigger in the codebase that re-evaluates the seat count when an invitation is
accepted. If a user accepts on the 15th, they are not in the snapshot until the
1st — meaning 15 days of access before the customer is charged.

From the customer's perspective: they accept an invite on Jan 15th, the admin
sees the UI say "this will increase your bill," but the bill on Feb 1st is
unchanged. On Mar 1st it suddenly jumps. Customers call support: "Why did my
bill go up and when did you add this person?"

Neither PR is wrong. The backend correctly implements the PRD. The UI correctly
explains the seat definition. The gap is a billing timing assumption that was
never written down anywhere — it lived only in Jordan's head and was never
converted into a constraint either engineer knew to implement.

---

### How purpl_brain surfaces it

When Darius's session is ingested, the brain's drift detector compares it against
Sam's decision. The LLM confirmation stage flags:

```
⚠ Drift detected

Decision: "Billable seat = member row with status 'active'. Invited members
           not counted."
           [sam-billing-seat-counter]

Signal from: darius-billing-settings-ui
Content: UI copy states "Adding them will increase your bill by $36/month"
         (referring to pending invited members).

Reason: The UI implies that accepting an invitation immediately affects
        the next bill. Sam's seat counter runs a point-in-time snapshot
        on the 1st — there is no event trigger on invitation acceptance.
        The copy is accurate for the seat definition but creates a billing
        timing expectation the backend does not currently fulfil.
```

Sam and Darius see the alert in the purpl_brain UI. They bring Jordan in:

> **Sam [Slack, #product-eng]**
> Brain flagged something on the billing page. Darius's UI says accepting an
> invite increases your bill — which is true eventually — but my seat counter
> runs on the 1st, not on acceptance. So there's a gap. Jordan, what's the
> intended behaviour: should accepting an invite trigger an immediate prorated
> charge, or do we just fix the copy to say "will be counted starting on the
> 1st of next month"?

> **Jordan [4 min later]**
> Fix the copy. We're not doing proration in v1 — too complicated. Say
> "will be included in your next billing cycle."

Two-line copy change. PR updated. No billing confusion shipped to customers.

---

### Why a reviewer would likely miss this

Darius's PR diff shows UI copy and a React component. It does not show Sam's
billing job scheduler. A reviewer reading `"Adding them will increase your bill
by $36/month"` would think: *is this copy accurate?* The answer is yes — it is
accurate, just incomplete about timing. The timing gap exists in the space
**between** the two PRs, not in either one.

A reviewer would need to:
1. Know that Sam's counter runs a snapshot (not an event trigger)
2. While reading a frontend copy string in a different repo
3. Connect those two facts and recognise the implicit timing assumption

The brain does this because both decisions are in the same graph. The review
process sees one diff at a time.

---

### Brain touchpoints

1. `brain_query` at Sam's session start → surfaced the invitation expiry rule
   from ADR-002 (hard-deleted after 7 days — relevant to seat count edge cases)
2. `brain_log_decision` at Sam's session end → logged the billable seat definition
3. `brain_query` at Darius's session start → Darius correctly learns the seat
   definition from Sam's session (not from re-reading the PRD)
4. `brain_log_decision` at Darius's session end → logged the UI copy assumption
5. Drift detector → connected the timing gap across two sessions and two repos
6. Alert routed to Sam → resolved with a product decision in under 10 minutes,
   before either PR merged

---
---

## Scenario B: The Constraint Nobody Remembered

### The setup — six months ago

SimpleTeam launched the Free plan. During a product discussion in Slack, Jordan
made a deliberate decision:

> **Jordan [Slack, #product-eng, 6 months ago]**
> Quick clarification on Free plan limits: Free workspaces cannot have custom
> admin roles. The only roles on Free are Member and Owner (the person who
> created the workspace). This is intentional — admin customisation is a Pro
> differentiator. If someone tries to assign a custom role on Free, we should
> show an upgrade prompt.

Sam added a guard to the role assignment endpoint at the time. That Slack thread
is now buried and effectively archived. The constraint is not in any ADR. It
lives in a single middleware check in `src/middleware/plan-guards.ts` and in a
six-month-old Slack message nobody has opened since.

purpl_brain ingested that Slack thread when the team connected their workspace.
The decision was extracted and stored:

```
Decision: "Free plan workspaces cannot assign custom admin roles. Attempting
           to do so must surface an upgrade prompt."
Source: slack/#product-eng, Jordan, 6 months ago
Confidence: high (confirmed by PR #112 which added the plan-guard middleware)
```

---

### Today — Priya's ticket

Priya picks up FEAT-2047: **Workspace Settings — Redesign the Members page**.
The ticket is about improving the UI for managing team members. It includes
adding a role dropdown to each member row so admins can change roles inline
without navigating to a separate page.

Jordan's ticket description:

```
Redesign the Members page to make role management easier.
Currently admins must click into each member's profile to change their role.
Add an inline role dropdown to each row in the members table.
```

Priya opens Claude Code. Session start query:

```
brain_query(
  query: "What are the rules around role assignment and plan-based permissions?",
  project_id: "simpleteam_api"
)
```

**Brain returns:**

```
Free plan workspaces cannot assign custom admin roles. Attempting to do so
must show an upgrade prompt. Applies to the role assignment endpoint and
any UI surface that exposes role selection.
[Source: slack/#product-eng (Jordan, 6 months ago), confirmed by PR #112]

Current roles available by plan:
- Free: Member, Owner only
- Pro/Enterprise: Member, Admin, Owner, plus custom roles
[Source: PR #112, plan-guard middleware]
```

Priya reads this before writing a single line. She knows the inline dropdown
needs to behave differently on Free vs Pro — on Free it should either hide
custom roles or show them greyed out with an upgrade prompt.

She builds the dropdown with plan-aware rendering:

```tsx
// Free plan: show roles but disable custom ones with upgrade tooltip
// Pro/Enterprise: all roles selectable
{roles.map(role => (
  <DropdownItem
    key={role.id}
    disabled={isFree && role.isCustom}
    tooltip={isFree && role.isCustom ? "Upgrade to Pro to use custom roles" : undefined}
  >
    {role.name}
  </DropdownItem>
))}
```

Her PR description:

```
FEAT-2047: Inline role dropdown on Members page

Inline role management as per ticket. Plan-aware rendering:
- Free workspaces: custom roles visible but disabled, upgrade tooltip shown
- Pro/Enterprise: all roles fully selectable

Note: constraint sourced from brain query at session start — Free plan cannot
assign custom admin roles (Jordan, Slack, 6 months ago; confirmed PR #112).
Without the brain context I would have built a flat dropdown identical for all
plans, which would have bypassed the plan guard at the API level and shown
custom roles as selectable on Free.
```

That last paragraph is Priya being explicit about what she learned from the brain.

---

### What would have happened without the brain

Priya builds a flat role dropdown — the natural, simple implementation. All roles
appear selectable for all plan types. The frontend sends the role assignment
request. The API-level plan guard in `src/middleware/plan-guards.ts` blocks it
and returns a 403. The UI shows a generic error.

The symptom: Free users who are also admins see a role dropdown, try to change
a member's role, get an unexplained error. Support ticket: "Why can't I change
roles? The dropdown is there." Engineering time to diagnose: 45 minutes (the
guard is not obvious from the frontend codebase). Fix: add upgrade prompt. But
the bug has already shipped.

Priya's PR note makes the value concrete: the constraint was not in the ticket,
not in the codebase she read, not in any file a code reviewer would open. It was
in a six-month-old Slack thread. The brain found it in 4 seconds.

---

### Why the reviewer argument is weaker here

Unlike Scenario A, this is not a cross-PR gap. It is missing context that does
not appear anywhere in the diff. A reviewer reading Priya's PR would see a role
dropdown component. They would not know to ask "does Free plan have role
restrictions?" unless they happened to remember a Slack conversation from
six months ago or had read `plan-guards.ts` recently for an unrelated reason.

This is the purest case of purpl_brain's value: **the constraint existed, was
correct, but was invisible to anyone who wasn't there when it was decided.**

---

### Brain touchpoints

1. `brain_query` at session start → surfaced a 6-month-old product constraint
   that existed only in Slack and a middleware file with no explanatory comment
2. Priya's PR explicitly cites the brain as the source of the constraint —
   this becomes part of the permanent record in git
3. The constraint is now reinforced in the brain with a new citation (Priya's
   session + the PR) — the next engineer who touches role management gets
   two citations pointing to it, not one

---
---

## How to Demonstrate Purpl Brain's Value Quickly

The scenarios above take 10–15 minutes to read. Here are formats for
demonstrating the same value in progressively less time.

---

### Demo format 1 — The 5-minute live query (best for investor or customer meetings)

**Setup required:** Brain seeded with at least one project's GitHub history and
a few agent session logs. No special preparation.

**Script:**

Ask the brain a question a new engineer would ask on day one:

> *"Why don't we use an ORM? I can see we're using raw SQL everywhere."*

The brain returns a grounded answer with citations — Slack thread, PR description,
a decision from an agent session — in under 5 seconds. The room sees:
- A specific, accurate answer (not a hallucination)
- Citations they can click through to verify
- Context that would have taken 30 minutes of Slack archaeology to find

Then ask:

> *"What are the most important constraints I need to know before touching
> the billing module?"*

Show the response. Ask the audience: *"How long would it take your team to answer
this question for a new hire without the brain?"*

This demo works because it is not a feature demo — it is a question the audience
already has an answer to (their own onboarding experience), and the brain answers
it better and faster.

---

### Demo format 2 — The pre-seeded drift (best for engineering audiences)

**Setup required:** 20 minutes of prep. Pre-log two agent sessions with a
contradiction already embedded.

Session 1 logs: *"Discount codes apply before tax is calculated."*
Session 2 logs: *"Cart total applies discount after tax for display consistency."*

Both are reasonable. Neither is wrong in isolation. Together they produce
inconsistent order totals depending on which code path runs.

Run the demo:
1. Show Session 1 in the brain (1 min)
2. Ingest Session 2 live (30 seconds)
3. Watch the drift alert appear in real time (30 seconds)
4. Click into the alert — show the LLM explanation of the contradiction (30 seconds)
5. Resolve it: click "Mark changed," show the follow-up task generated (30 seconds)

Total: under 3 minutes. The audience has watched a real-time contradiction catch
with no manual searching, no cross-referencing, no reviewer involved.

---

### Demo format 3 — The archaeology test (best for product/design audiences)

**Setup required:** A real project with 4+ weeks of history in the brain.

Pick a decision that was made in a Slack thread more than 3 weeks ago — something
the team has genuinely half-forgotten. Ask one of the engineers to find it the
old way (Slack search, asking colleagues) while someone else asks the brain.

Time both. Show the results side by side.

This demo is uncomfortable in a good way. It surfaces a real gap the team has
been living with, using their own data.

---

### Demo format 4 — The new employee simulation (best for enterprise sales)

Invite someone in the room who is not an engineer on the project — a PM, a
salesperson, a customer. Give them 5 minutes to ask the brain any questions about
the codebase or product decisions they're curious about.

The demo shows itself. Non-technical people get grounded, specific answers with
sources. They do not need to find the right engineer to ask.

---

### Which format for which audience

| Audience | Best format | Time needed | Prep required |
|----------|-------------|-------------|---------------|
| Investors / executives | Format 1 — live query | 5 min | Seeded brain |
| Engineering teams | Format 2 — live drift catch | 3 min | 20 min prep |
| Product / design | Format 3 — archaeology test | 15 min | Real project data |
| Enterprise prospects | Format 4 — new employee sim | 10 min | Seeded brain |
| Conference / talk | Format 2 then Format 1 | 8 min | 20 min prep |

---

### The one question every demo should end with

Regardless of format, close with this question directed at the room:

> *"In the last three months, has your team shipped something that contradicted
> a decision made six months earlier — and nobody caught it until a customer
> complained?"*

Every room with more than 5 engineers answers yes. That is the market.
