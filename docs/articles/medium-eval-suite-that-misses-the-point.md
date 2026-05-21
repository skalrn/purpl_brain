# Our Eval Suite Passed. Our Product Was Broken. Here's What We Got Wrong.

---

By the time we ran our first full-codebase review, purpl_brain had eighteen eval scripts covering extraction precision, citation accuracy, drift recall, cross-session recall, project isolation, latency, MCP smoke tests, security checks, and graph integrity. The eval suite took about twelve minutes to run. Most evals had hard pass thresholds — if they failed, the process exited non-zero.

The review found that the Python SDK, which is one of the two primary ways agents interact with the system, returned a 404 on every query. The demo mode was broken — it 401'd on every authenticated call. The Marketplace metering Lambda reported zero seats to AWS even with active users. A critical rendering issue exposed API keys in browser memory.

None of these were caught by any of the eighteen evals.

This article is about a specific mistake in how we thought about eval coverage, why the mistake is easy to make, and the mental model that prevents it.

---

## 1. 🔍 The Mistake: Testing What You Can Control, Not What Users Experience

Our evals were well-designed for what they tested. The extraction eval seeded labeled GitHub PRs and verified the extractor identified the right decisions. The cross-session eval seeded five agent decisions across five simulated sessions and verified a fresh query recalled at least four of them. The citation eval verified that every `[N]` in a generated answer pointed to a chunk that existed in the retrieved context.

These evals have clear inputs and clear expected outputs. They are easy to write, easy to debug, and they tell you something real about the system.

What they all share: **they test the system from the inside.** They call services directly, seed data directly into the pipeline, query the backend directly. They exercise the logic of the components. They do not exercise the experience of a user connecting to the system for the first time.

The things that were broken were all on the boundary between the system and the outside world: the Python SDK URL that external agents call, the demo auth that new users see, the Marketplace metering that AWS observes, the API key that the browser handles. These boundaries were invisible to every inside-out eval.

---

## 2. 🛑 The Specific Gaps and What Caused Each One

**Gap 1 — Python SDK 404 on every query.**

The Python SDK lived in `packages/python/`, separate from the API in `apps/api/`. The eval suite's test files lived in `apps/api/src/scripts/`. Every eval imported from the API's internal modules. No eval ever imported the Python package and called it.

The root cause is not a failure to write a test. It is that the eval suite's location made the Python SDK invisible as a test target. Nobody on the team thought "I should write a test in `packages/python/` that calls the running API." The SDK had its own `examples/` directory but no test suite.

**Gap 2 — Demo mode auth 401 on every call.**

`docker-compose.demo.yml` set `NODE_ENV: demo`. The auth middleware only activated the dev bypass for `NODE_ENV === "development"`. Demo mode had a `DEV_API_KEY` set but the bypass didn't fire. Every authenticated route 401'd.

We had no eval that started the demo Docker Compose stack and ran any authenticated request through it. Every eval ran against a live development stack with `NODE_ENV=development`. The demo stack was tested by running it manually before releases.

**Gap 3 — Marketplace metering always reporting zero seats.**

The metering Lambda rewrote `http://` to `https://` before calling the API. The ALB only listened on port 80. Connection refused. The Lambda caught the error and returned `seats: 0`. Marketplace was billed zero every hour.

There was no test for the metering Lambda at all. It ran in AWS every hour. Nothing in CI verified it produced a non-zero result against a running stack.

**Gap 4 — API key exposed in browser memory.**

The web client called `/auth/me`, received the raw API key in JSON, stored it in React component state, and sent it as `x-api-key` on every API request. This defeated the httpOnly session cookie.

There was no security eval for the web client. The security eval (`eval-security.ts`) ran against the API. It did not open a browser, log in, and inspect what JavaScript variables were set.

---

## 3. 🧩 The Mental Model: Inside-Out vs. Outside-In

Every test in a system occupies a position on a spectrum:

**Inside-out tests** start from the system's internal components. Unit tests of pure functions, integration tests between services that share a codebase, evals that seed data directly into a queue and verify what comes out the other side. These tests are fast, reliable, and tell you that the logic is correct.

**Outside-in tests** start from a user's entry point. A test that installs the Python SDK in a fresh virtual environment and calls `brain_query`. A test that starts the demo Docker Compose stack and makes an HTTP request. A test that loads the web UI in a real browser and inspects the network tab. These tests are slower, harder to write, and tell you that the product works.

Both types are necessary. The mistake is having only inside-out tests and believing you have good coverage.

The specific pattern that generates this mistake: **teams write tests as they build components.** When you build the extractor, you write an extractor eval. When you build the query engine, you write a query eval. These are inside-out tests written by the people who built the components, from the perspective of those components. The entry points that users actually use — install the SDK, start the demo, connect to the Marketplace — are experienced for the first time at launch, not during development.

---

## 4. 🔧 The Fix: Start With the Promise, Not the Components

The antidote is to write tests from the product promise first, and let the component tests follow.

The promise of purpl_brain is: "a second agent session, with zero shared context, correctly recalls a decision logged by a first agent session in a different tool." Write that test before anything else:

```python
# test_core_promise.py

def test_cross_agent_cross_tool_recall():
    """
    Agent A (LangGraph) logs a decision.
    Agent B (MCP client) queries in a fresh session with no shared context.
    B must recall A's decision with a citation.
    """
    # Agent A: LangGraph tool
    a_tools = langgraph_tools(BrainClient())
    log_result = a_tools[1].invoke({  # brain_log_decision
        "project_id": TEST_PROJECT,
        "decisions": [{
            "id": "test-001",
            "description": "Use Qdrant over pgvector for semantic search",
            "rationale": "Sub-10ms p99 at 2M+ vectors with payload filtering",
            "confidence": "high"
        }],
        "work_completed": "Vector DB evaluation",
        "session_id": f"agent-a-{uuid4()}",
    })
    assert log_result.get("ok"), f"Agent A log failed: {log_result}"
    
    # Agent B: MCP client (completely separate connection, no shared state)
    mcp_response = subprocess.run([
        "node", MCP_SERVER_PATH,
        "--tool", "brain_query",
        "--args", json.dumps({
            "query": "What vector database did we choose and why?",
            "project_id": TEST_PROJECT,
        })
    ], capture_output=True, text=True, timeout=30)
    
    result = json.loads(mcp_response.stdout)
    assert "Qdrant" in result["answer"], "Agent B did not recall the decision"
    assert any(c["source"] == "agent" for c in result["citations"]), \
        "Agent B answer has no agent-source citation"
```

This test fails immediately if the Python SDK has the wrong URL. It fails if the MCP server can't reach the API. It fails if the decision is stored incorrectly. It fails if retrieval doesn't work. It is a single test that exercises the entire product.

Write it first. Run it on every commit. Make it the first check in CI. If it fails, nothing else matters.

---

## 5. 📋 The Coverage Map We Should Have Had

A coverage map for an agent memory system looks different from a coverage map for a library:

**Entry point tests (outside-in — must exist for every supported path):**
- Python SDK: install in fresh venv, call each tool, assert non-error response
- MCP: start MCP server, connect MCP client, call each tool, assert non-error response
- REST API: curl each endpoint with a real API key, assert expected response shape
- Web UI: Playwright test that logs in, queries the brain, sees a cited answer

**Integration path tests:**
- Demo stack: start `docker-compose.demo.yml`, seed data, query it, get a result
- Prod stack: start `docker-compose.prod.yml`, run smoke test
- AWS: synthetic canary that runs in the deployed environment every 5 minutes

**Component tests (inside-out — the ones we already had):**
- Extraction precision and recall
- Citation accuracy
- Drift detection recall and precision
- Cross-session recall
- Project isolation
- Latency budgets

The key insight is that the entry point tests cannot be replaced by any number of component tests. A perfectly working extractor does not prove the Python SDK can reach it. A perfect citation eval does not prove the browser doesn't expose the API key. You need both layers.

---

## 6. 🔑 The Rule

**Write tests from the outside in, not from the inside out.**

Start with the product promise. Write a test that proves it works. Then write tests that prove each component works. Never mistake the second set for coverage of the first.

For any system with multiple client paths: every path needs its own entry point test. A test of the backend is not a test of the client.

For demo and production environments: automated tests that start the actual stack and make real requests are not optional. Manual testing before releases is not sufficient — it is not repeatable, it is not on every commit, and it is the first thing to be skipped when a release is under time pressure.

The eval suite we had was not bad. It was incomplete in a specific way that only appears when you ask "does this test the experience of a user who has never seen our code?" If the answer is no for any supported entry point, that entry point is untested.

---

*This article is part of a series on building production-grade AI systems. The eval gaps described here were found in a full-codebase review of purpl_brain.*
