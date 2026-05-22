---
sidebar_position: 3
---

# Eval Suite

## Overview

The eval suite validates that the system meets its core correctness guarantees before changes go to trusted users. All Phase 1 and Phase 2 evals are passing as of 2026-05-17.

## Extraction eval (M7.1)

**What it tests:** The entity extractor's ability to correctly identify decisions in real GitHub PRs and Slack threads.

**Method:** 20-30 GitHub PRs from real projects with manually labeled ground truth: decisions made, rationale, confidence levels. Run the extractor and compare against labels.

**Metrics:**
- **Precision:** of extracted decisions, what percentage are genuine decisions (not suggestions or noise)
- **Recall:** of labeled decisions, what percentage did the extractor find
- **Rationale accuracy:** when rationale is extracted, does it match the labeled rationale

**Targets vs. results:**

| Metric | Target | Phase 1 Result |
|---|---|---|
| Precision | > 75% | 92.3% |
| Recall | > 65% | 80.0% |
| Fabricated citations | 0 | 0 |

The precision improvement from the initial run to 92.3% came from expanding the extraction system prompt with a decision taxonomy (distinguishing "concluded choices" from "suggestions" and "open questions") and 5 few-shot examples showing the extractor what to accept and reject.

**How to run:**
```bash
npm run eval:extraction -- --dataset data/evals/extraction-labeled.json
```

**Interpreting results:** Precision below 75% means the brain is filling with noise — reduce the LLM call rate, tighten the decision marker phrase list, or increase the confidence threshold for what triggers Pass 2. Recall below 65% means important decisions are silently missing — add more decision marker phrases or lower the phrase-matching threshold.

## Query accuracy eval (M7.2)

**What it tests:** The query layer's ability to return correct, grounded answers to real questions about real codebases.

**Method:** 18 test queries against the `encode/httpx` repo with known ground-truth answers. Two evaluation strategies: automated word-overlap scoring and human review of borderline cases.

**Target vs. result:** > 80% correct or partially correct → **Result: 83.3% (15/18)**

The three failed queries identified two fixable bugs: brain-writer was not indexing `raw_content` for certain event types, causing chunks to be empty; and the context budget was set too conservatively, dropping relevant chunks. Both were fixed before Phase 1 exit.

**How to run:**
```bash
npm run eval:query -- --project-id encode-httpx
```

## Citation accuracy eval (M7.3)

**What it tests:** That the answer generation step does not hallucinate citations — every `[N]` reference in an answer must map to a real chunk that supports the claim.

**Method:** 15 queries producing 24 total citations. Manual verification: each cited chunk was checked against the associated claim.

**Target vs. result:** 0 fabricated citations → **Result: 0 fabricated**

All `source_url` values were valid GitHub URLs. All `quoted_text` fields contained substantive content. `citation_warning` was false on all 15 queries.

**How to run:**
```bash
npm run eval:citations -- --project-id encode-httpx
```

## Link-following eval

**What it tests:** That the extractor correctly follows GitHub PR URLs embedded in documents and ingests those PR discussions.

**Method:** Ingest a set of ADR documents that contain embedded PR URLs. Verify that the decisions from the linked PRs appear in the brain as extracted Decision nodes.

**Target vs. result:** 100% of decisions in linked PRs ingested (up from 9% before link-following) → **Result: 100%** on test set.

**How to run:**
```bash
npm run eval:link-following -- --project-id test-project
```

## Latency eval (M7.4)

**What it tests:** Query latency under realistic conditions.

**Results by backend:**
- Claude API / Bedrock: p95 < 2s (meets the < 5s target)
- Ollama (local 4B model, dev-only): p95 ~40s (expected — local models are not production backends)

**How to run:**
```bash
npm run eval:latency -- --queries 36 --project-id encode-httpx
```

`QUERY_TOP_K` and `QUERY_CONTEXT_BUDGET` are environment-driven for tuning per provider. Lower `TOP_K` and smaller `CONTEXT_BUDGET` reduce latency at the cost of answer quality.

## Demo scenario (M7.5)

**What it tests:** The complete end-to-end experience that validates the Phase 1 exit criterion.

**Setup:** A developer returns after a 2-week absence from a real GitHub repo. The brain has been ingesting for 2 weeks.

**Test queries:**
1. "What is the current state of [feature] work?"
2. "What decisions were made while I was away and why?"
3. "What changed in the last 14 days?"

**Target:** All three queries return factually accurate, cited answers in under 5 seconds.

**Result: PASS**. Baseline without brain: ~53 minutes manual catch-up. With brain: < 2 minutes, cited.

**How to run:**
```bash
npm run eval:demo
```

## Running the full eval suite

```bash
npm run eval  # runs all evals in sequence, prints pass/fail summary
```

Run the full suite before any significant change to the extraction system prompt, query system prompt, context budget configuration, or similarity thresholds. These parameters are all coupled — changing one can affect all four evals.
