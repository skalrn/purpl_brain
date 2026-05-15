# User Personas — Project Brain

## Persona 1: The Context Switcher (Primary)

**Name:** Alex, Senior Software Engineer  
**Team size:** 3–8 engineers  
**Environment:** 1–3 active codebases, heavy AI-assisted development (Cursor, Claude)

### Situation
Alex works on a feature, gets pulled into a P0 bug for 4 days, then returns. The ticket has comments, there was a design discussion in Slack, and a PR touched adjacent code. Reconstructing where things were takes 45–90 minutes — often longer than the actual work.

### Goals
- Resume any task within minutes, not hours
- Know what changed while away, and why
- Not have to ask teammates to repeat context

### Frustrations
- Slack threads are the real source of truth but completely unsearchable at scale
- Jira tickets are always stale relative to what was actually decided
- AI assistants have no memory of what was decided in a prior session

### How Project Brain Helps
Queries the brain: *"What's the current state of the payment module PR and what decisions were made while I was on the P0?"* Gets a grounded, cited answer in seconds.

---

## Persona 2: The Floating Specialist (Primary)

**Name:** Priya, Staff Security Engineer  
**Team size:** Works across 4–6 product teams part-time  
**Environment:** Drops into codebases to advise, does not own any single product

### Situation
Priya is the go-to for auth and security across the org. She reviews a design in Product A on Monday, helps Product B with an OAuth issue Wednesday, then gets pinged by Product C about a token storage question Friday. She can't hold all four codebases' current state in her head simultaneously.

### Goals
- Instantly understand the current state of any product's security posture when called in
- Surface prior decisions she made in other products that are relevant to the current question
- Leave her recommendations in a form the team can query later without her being present

### Frustrations
- Has to re-read entire Slack threads and PRs every time she's pulled in
- Her advice is given verbally in meetings and then lost
- Same problems get solved differently across products because her prior solutions aren't surfaced

### How Project Brain Helps
Expertise-scoped query: *"Show me all open decisions touching auth or token storage across active products."* Her prior recommendations are captured as specialist input and surfaced when the next related question arises.

---

## Persona 3: The AI Agent (Non-Human Actor)

**Type:** Codegen agent (Claude, Cursor, Devin-style)  
**Pattern:** Invoked by a human, runs a bounded task, session ends, resumed later

### Situation
An agent is invoked Monday to scaffold a new API module. It makes decisions: REST over GraphQL, a specific error handling pattern, a library choice. Session ends. Thursday the agent is resumed on a follow-up task touching the same module. Without persistent memory, it re-derives context, potentially contradicts Monday's decisions, and the human has to course-correct.

### Goals
- Access prior session decisions without re-prompting
- Emit structured rationale at session end so the next actor inherits full context
- Not contradict its own prior choices or the team's established patterns

### How Project Brain Helps
The brain serves as the agent's persistent working memory. On resume, the agent queries: *"What decisions did I make in the last session on this module?"* At session end, the agent emits a decision log back into the brain.

---

## Persona 4: The Tech Lead / PM

**Name:** Jordan, Engineering Manager / Technical PM  
**Team size:** Manages 2–4 squads across 2 products  
**Environment:** Attends many meetings, reviews status async, rarely writes code

### Situation
Jordan needs to know the current state of multiple work streams without attending every standup or reading every PR. When a decision changes — a scope cut, a deadline slip, a tech pivot — Jordan needs to know immediately, not when it surfaces in the next planning meeting.

### Goals
- Current plan state across all work streams without information relay from reports
- Immediate awareness when plans change or anomalies emerge
- Impact analysis before signing off on a scope or tech change

### Frustrations
- Learns about decisions after they've been acted on
- Status updates in Jira don't reflect the real state, which lives in Slack
- No easy way to ask "what changed this week and what does it affect"

### How Project Brain Helps
Proactive anomaly alerts when plan drift is detected. Human-invokable impact analysis: *"We just decided to drop the mobile client from Phase 1 — what does this affect across current tickets and commitments?"*
