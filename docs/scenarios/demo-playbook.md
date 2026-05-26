# Purpl Brain — Demo Playbook

Four demo scripts for showing purpl_brain's value live. Each script has a target
audience, setup requirements, a word-for-word run sequence, and guidance on
handling the most common pushback.

Pick one based on who is in the room and how much time you have.

---

## Demo 1 — The Live Query
**Best for:** Investors, executives, first-time prospects  
**Time:** 5 minutes  
**Prep:** Brain seeded with at least one real project (GitHub history + a few agent sessions)  
**What it proves:** The brain answers questions a new team member would ask, instantly, with sources

---

### Setup

Open the purpl_brain web UI on the project you've seeded. Have the chat panel
visible on the right side. No slides, no script visible on screen — just the UI.

---

### Run sequence

**Step 1 — Frame it in one sentence before touching the keyboard**

Say:

> "I'm going to ask it something a new engineer would ask on their first week.
> Something that would normally take 30 minutes of Slack archaeology or
> interrupting a colleague."

**Step 2 — Type the first query**

```
Why do we use raw SQL queries instead of an ORM?
```

Let it stream. Don't talk over it.

When it finishes, point to the citations at the bottom:

> "Every sentence in that answer is grounded in a source — you can click through
> to the Slack thread, the PR, the ADR. It's not generating an opinion.
> It's surfacing what your team actually decided and why."

**Step 3 — Type the second query**

```
What are the most important constraints I need to know before
touching the billing module?
```

Let it stream. When it finishes, read one of the citations aloud — the source,
the actor, the timestamp. Then say:

> "That constraint was in a Slack thread from four months ago. It is not in
> any file a new engineer would open. Without this, they build the wrong thing,
> it fails silently, and someone spends an afternoon figuring out why."

**Step 4 — Close with the question, not a feature**

Don't describe more features. Ask:

> "How long would it take your team to answer those two questions for a new hire?
> Not find the right document — actually answer them, with the reasoning behind
> the decision?"

Let the room sit with that for three seconds. Then:

> "That's the problem. The answers exist. They're in your PRs, your Slack, your
> meeting notes. They're just not findable at the moment someone needs them."

---

### Most common pushback and how to handle it

**"Couldn't you just write better documentation?"**

> "You could. Teams have been trying that for 30 years. The reason it doesn't
> work isn't discipline — it's that documentation requires someone to stop and
> write it at exactly the moment they're under the most pressure to ship.
> Purpl_brain captures decisions as a side effect of work that's already
> happening: PRs, Slack messages, agent session logs. There's nothing extra
> to write."

**"What if the brain gives a wrong answer?"**

> "Every answer comes with citations. If the answer is wrong, you can see exactly
> which source it came from and correct the source. It can't hallucinate a
> decision that isn't in the graph — it will tell you it didn't find anything
> rather than invent something."

---

## Demo 2 — The Live Drift Catch
**Best for:** Engineering teams, CTOs, technical evaluators  
**Time:** 3 minutes  
**Prep:** 20 minutes to pre-log two sessions with a planted contradiction  
**What it proves:** The brain catches contradictions between agent sessions automatically, in real time

---

### Setup (do this before the demo)

Log two agent sessions with a contradiction. Use the `POST /brain/agent-log`
endpoint or the `brain_log_decision` MCP tool. Use your actual project ID.

**Session 1 — log this first:**

```json
{
  "schema_version": "1.0",
  "session_id": "demo-session-checkout-backend",
  "agent_id": "claude-code",
  "project_id": "YOUR_PROJECT_ID",
  "timestamp_start": "2026-05-26T09:00:00Z",
  "timestamp_end": "2026-05-26T10:30:00Z",
  "work_completed": "Built discount code application logic for checkout",
  "decisions": [{
    "id": "discount-timing",
    "description": "Discount codes are applied to the subtotal before tax is calculated",
    "rationale": "Mathematically correct — tax is a percentage of the taxable amount, which is the post-discount price. Applying discount before tax gives the customer the right taxable base.",
    "alternatives_considered": ["apply discount after tax", "split discount pre/post tax by item type"],
    "confidence": "high"
  }]
}
```

**Session 2 — log this second (wait 1 minute):**

```json
{
  "schema_version": "1.0",
  "session_id": "demo-session-cart-frontend",
  "agent_id": "cursor-agent",
  "project_id": "YOUR_PROJECT_ID",
  "timestamp_start": "2026-05-26T11:00:00Z",
  "timestamp_end": "2026-05-26T12:00:00Z",
  "work_completed": "Built cart summary and order total display on checkout page",
  "decisions": [{
    "id": "cart-total-display",
    "description": "Cart total display shows tax calculated on the full item price, then subtracts the discount from the final total for display consistency with line items",
    "rationale": "Displaying tax on the discounted subtotal made line-item tax amounts appear inconsistent with the individual product display. Applying discount after tax on the display keeps each line item's tax visually consistent.",
    "alternatives_considered": ["show tax on discounted subtotal"],
    "confidence": "medium"
  }]
}
```

Wait for the drift detector to run (up to 2 minutes). Confirm the drift alert
appears in the UI before your demo. Then resolve it back to `pending` so it
appears live during the demo.

To reset: `POST /brain/drift-alerts/{alert_id}/resolve` with `{ "resolution": "pending" }`.

---

### Run sequence

**Step 1 — Show the two session logs side by side (1 minute)**

Open the Sessions tab in the UI. Show Session 1:

> "This is the backend agent's session from this morning. It built the discount
> logic. The decision: discounts apply before tax. Mathematically correct —
> tax should be on the discounted amount."

Show Session 2:

> "This is the frontend agent's session. It built the cart display. The decision:
> show tax on the full price, then subtract the discount at the end. Visually
> cleaner on the screen."

Pause. Ask the room:

> "Is either of these wrong?"

Let them think. Neither is wrong in isolation. Both engineers made a reasonable call.

**Step 2 — Show the drift alert (30 seconds)**

Switch to the Drift tab. The alert is there.

> "The brain connected these two decisions. Backend calculates tax on the
> discounted price. Frontend displays tax on the full price. Every order that
> uses a discount code will show the customer a different total than what gets
> charged. This is a live bug — in two PRs that both passed review."

Click into the alert. Read the LLM explanation aloud. Point to both citations.

**Step 3 — Resolve it live (30 seconds)**

Click "Mark changed." Show the follow-up task that gets generated.

> "Now both engineers get a task. The brain doesn't decide which approach is
> right — that's a product decision. It just makes sure someone makes it
> explicitly, with both options in front of them."

**Step 4 — Close**

> "Neither of those PRs had a bug in them. A reviewer looking at the backend
> PR would see correct tax logic. A reviewer looking at the frontend PR would
> see correct display logic. The bug only exists in the gap between them.
> Code review doesn't see gaps. The brain does."

---

### Most common pushback and how to handle it

**"A good reviewer would have caught this."**

> "Maybe — if Sam reviewed Darius's PR and happened to remember his own session
> decision while reading a cart display component in a different repo. The brain
> catches it every time, regardless of who reviews what. Consistency is the
> feature."

**"Could you just have a shared design doc?"**

> "The discount timing decision was in a design doc — the PRD said 'apply
> discount before tax.' The frontend engineer read it. Then made a display
> decision that was locally reasonable but globally inconsistent. Design docs
> describe intent. They don't catch implementation divergence. The brain
> watches what actually gets built."

---

## Demo 3 — The Archaeology Test
**Best for:** Product managers, design leads, team leads with real projects  
**Time:** 15 minutes  
**Prep:** A real project with 4+ weeks of history in the brain  
**What it proves:** The brain finds real decisions from your own project that your team has half-forgotten

---

### Setup

Before the demo, identify one real decision from the project that:
- Was made more than 3 weeks ago
- Lives primarily in a Slack thread or PR description (not a prominent ADR)
- At least one person in the room has probably forgotten the reasoning

Good candidates:
- Why a specific library was chosen over an obvious alternative
- A product rule about who can or can't do something (plan limits, role restrictions)
- A performance constraint that shaped how something was built
- A decision to explicitly NOT build something and why

Do not tell anyone what the decision is in advance.

---

### Run sequence

**Step 1 — Set up the race (2 minutes)**

Pick one engineer in the room. Tell them:

> "I'm going to ask you and the brain the same question at the same time.
> You use whatever you normally use — Slack search, the codebase, asking
> someone. I'll ask the brain. We'll see who gets the fuller answer faster."

Ask both simultaneously:

> "Why did we choose [library/approach X] instead of [the obvious alternative]?
> What was the reasoning, and were there any constraints that came out of that
> decision?"

**Step 2 — Let it play out (5 minutes)**

The brain will answer in under 10 seconds. The engineer will be in Slack.

Do not rush. Let the engineer actually search. The silence is the demo.

When the engineer has their answer (or gives up), compare:
- Completeness: did the brain surface the alternatives considered?
- Accuracy: does the engineer agree with what the brain returned?
- Citations: can the engineer verify where the brain's answer came from?

**Step 3 — Ask the engineer one follow-up question (2 minutes)**

> "Is there anything in the brain's answer that you'd forgotten about?"

There almost always is. A constraint, an alternative that was considered and
rejected, a follow-up item that was never resolved. When the engineer says yes,
point to the citation:

> "That's from a Slack thread from [date]. The brain has had that for
> [N] weeks."

**Step 4 — Close with the implication (2 minutes)**

> "What you just watched is the onboarding experience for every new engineer
> you hire. Except they don't have you in the room to run the race with.
> They just have Slack search and the courage to interrupt someone."

---

### Most common pushback and how to handle it

**"Our Slack search is actually pretty good."**

> "Let's try it. Same question, Slack search only, no asking colleagues.
> Find the reasoning behind [the decision], including the alternatives
> considered and any constraints that came out of it."

Let them try. Slack search finds messages that contain keywords. It does not
surface the reasoning, the alternatives, or the connected constraints unless
all of those happened to appear in the same thread. They usually didn't.

---

## Demo 4 — The New Employee Simulation
**Best for:** Enterprise buyers, HR/People teams, CTO evaluations  
**Time:** 10 minutes  
**Prep:** Brain seeded with a real project  
**What it proves:** Non-engineers can get grounded, specific answers about a codebase without asking a developer

---

### Setup

Find someone in the room who does not work directly on the project — a PM,
a salesperson, a customer success person, an investor. Give them the keyboard
or let them dictate questions.

Tell them:

> "Pretend you just joined the engineering team yesterday. You've been given
> access to the brain. Ask it anything you're genuinely curious about — why
> things work the way they do, what the team has decided, what the open
> questions are. I'll stay quiet."

---

### Run sequence

Let them drive. Do not suggest questions. The point is that the questions a
non-engineer asks are the exact questions the brain is built to answer — "why
does it work this way?", "what were the other options?", "who made this decision?"

When they hit a question the brain answers well, let them react before you say
anything.

When they hit a question the brain can't answer (insufficient data), be honest:

> "The brain doesn't have that yet — it only knows what's been ingested. That
> particular decision was probably made verbally and never written down anywhere.
> That's actually a useful signal: the gaps in the brain are the gaps in your
> institutional knowledge."

**Close after 8 minutes:**

> "What you just did is what every new hire does in their first two weeks —
> except they do it by interrupting engineers who are trying to ship.
> The average new engineer takes 3 months to reach full productivity.
> A significant part of that is exactly this: learning why things are the
> way they are. The brain makes that self-serve."

---

### Most common pushback and how to handle it

**"Will engineers actually write decisions into it?"**

> "They don't have to — the brain ingests from GitHub, Slack, and Jira
> automatically. Agent sessions log decisions at the end of every run via
> a stop hook. The manual surface is there for decisions that happen outside
> those channels — meeting transcripts, ad-hoc signals. Most of the brain
> fills itself."

**"What's the ROI?"**

> "One senior engineer costs around $200k/year. If the brain saves them
> 2 hours per week of context-switching and archaeology, that's $20k/year
> per engineer in recaptured time. More concretely: one production incident
> caused by a forgotten constraint costs more than the annual subscription.
> We've got two documented examples of exactly that catch in the first
> six weeks of a pilot."

---

## Choosing the Right Demo

| Who's in the room | How much time | Which demo |
|---|---|---|
| Investors, board | 5 min | Demo 1 — Live Query |
| Engineering team evaluating | 5 min | Demo 2 — Live Drift Catch |
| Mixed technical/non-technical | 10 min | Demo 1 then Demo 4 |
| Enterprise buyer (procurement) | 15 min | Demo 3 — Archaeology Test |
| Conference talk / recorded demo | 8 min | Demo 2 then Demo 1 |
| Solo CTO evaluating | 20 min | Demo 3 (their own project) |

---

## The One Question That Closes Every Demo

Regardless of which script you ran, end with this:

> "In the last three months, has your team shipped something that contradicted
> a decision made six months earlier — and nobody caught it until a customer
> complained?"

Every room with more than five engineers answers yes.

That's not a pitch. That's the problem statement. Purpl_brain is the answer.
