Write a Medium article based on an engineering problem, decision, or lesson from this session or described in $ARGUMENTS.

If $ARGUMENTS is empty, review the current conversation for the most interesting engineering insight worth publishing — a bug found, a design decision made, a pattern discovered — and ask the user to confirm before writing.

---

## Before writing, establish:

1. **The core insight** — what is the one non-obvious thing a reader will learn? If it can be stated in one sentence, the article is ready to write. If not, ask.
2. **IP boundary** — what must NOT appear: product names, internal architecture specifics, proprietary patterns. Ask the user if unclear. Default to maximum abstraction.
3. **The audience** — practising engineers who build systems, not researchers. Write for someone who will recognise the problem from their own work.

---

## Style rules (match exactly)

**Structure:**
- Title: punchy, scenario-first, creates tension. Add one relevant emoji at the start (🚨 🛑 ⚠️ 💥 🔍). Avoid clever wordplay — be direct.
- Intro: 3–4 short paragraphs. Open with "Imagine..." and a concrete, specific scenario the reader can picture immediately. No abstract preamble. End the intro with exactly one sentence stating what the article covers.
- Numbered sections (1, 2, 3...) with a single emoji prefix on each heading. Subsections use ### with no emoji.
- Final section: always "💡 Key Takeaways" — 4 bullet points max, each starting with a relevant emoji and a bold phrase.

**Writing:**
- Paragraphs: 2–3 sentences maximum. If it runs longer, split it.
- Explain the WHY behind every design decision, not just the WHAT. Use **Effect:** as a label when explaining the impact of a code or design choice.
- Bold key terms on first use. Never bold for decoration.
- Tone: direct, no hedging, no passive voice. Write as a practising engineer, not an academic.
- Never say "In conclusion" or "In summary." The takeaways section is the close.
- Reading time target: 6–8 minutes.

**Technical content:**
- Include at least 2 Mermaid diagrams. Add a comment above each: `<!-- Export as PNG from mermaid.live before importing to Medium -->`. Diagrams should show system flow, not just boxes.
- Code snippets: include when a concrete implementation clarifies the concept. Keep to the essential lines — no boilerplate.
- No markdown tables — Medium drops them on import. Replace with grouped bullet lists using ✅ / ❌ to show contrast, or **Bold label:** followed by bullets.

**IP protection:**
- Replace internal product names with generic equivalents: "AI assistant", "knowledge pipeline", "workspace", "extraction stage".
- Replace internal architecture terms with generic ones unless they are industry-standard (RAG, vector store, LLM are fine).
- The insight and the failure mode can be specific. The implementation that produced it should be generic.

**Observations and Limitations section:**
- Always include. Be honest about what the solution does NOT solve. This is what separates engineering articles from marketing.
- 2–4 items, each starting with a bold label.

---

## Output

1. Write the full article in markdown.
2. Save it to `docs/articles/medium-<kebab-case-title>.md`.
3. Add a comment block at the bottom with Medium import instructions:
   - Render mermaid diagrams at mermaid.live, export as PNG, insert as images.
   - Use Medium's import feature (profile → Stories → Import a story) — do not paste.
   - Tables have already been converted to bullet groups.

After saving, show the user the title, estimated read time, and section list so they can request changes before importing.
