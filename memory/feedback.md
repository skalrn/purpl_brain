---
name: feedback
description: Preferences and working style corrections from Deepak
metadata:
  type: feedback
---

**Ask before building non-trivial features.** Deepak consistently asked "should we build this now or wait?" before proceeding (contradiction detector, temporal query). Always present the trade-off first, let him decide.

**Why:** He thinks carefully about build order and doesn't want premature complexity.
**How to apply:** For any feature not on the immediate milestone, propose it as a question with a one-line trade-off before generating code.

---

**Don't over-explain decisions he's already comfortable with.** When he picks a direction (e.g. Redis Streams over BullMQ, staying on Python vs Node), confirm and move on. Don't re-litigate.

**Why:** Wastes time, feels patronizing.
**How to apply:** One-line acknowledgment, then proceed.

---

**He prefers committing frequently with meaningful messages.** Every milestone and significant fix was committed immediately after it worked.

**Why:** Clean git history, easy to revert.
**How to apply:** Commit after each working milestone or fix, not in batches.

---

**Debugging preference: add targeted logging first, don't rewrite.** When the signature verification failed, we added a debug log line rather than guessing. He was comfortable with iterative diagnosis.

**How to apply:** On failures, instrument first, interpret the output, then fix.

---

**He evaluates AI assistance critically.** He asked "where could your evaluation be wrong?" after the meta-evaluation. He responds well to honest uncertainty.

**How to apply:** Flag uncertainty explicitly rather than projecting false confidence.
