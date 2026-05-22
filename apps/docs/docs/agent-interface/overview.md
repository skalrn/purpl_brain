---
sidebar_position: 1
---

# Agent Interface Overview

## Three paths, one brain

Any agent that can call an HTTP endpoint, an MCP tool, or a Python function can read from and write to the brain. There are three integration paths:

**MCP server** — for interactive IDE agents like Claude Code and Cursor. The brain exposes four MCP tools that the agent can call natively. Claude Code users get this with zero configuration beyond adding the server to `~/.claude/settings.json`. Cursor users configure it in `.cursorrules`.

**Python SDK** — for agents built with LangGraph, Google ADK, or any Python orchestration framework. `pip install purpl-brain[langgraph]` or `pip install purpl-brain[adk]`. The SDK wraps the same four operations as the MCP server in framework-native decorators.

**REST API** — the escape hatch. Any HTTP-capable agent can call `POST /brain/query`, `POST /brain/agent-log`, `POST /brain/impact-analysis`, and `POST /brain/signal` directly. The MCP server and Python SDK are thin wrappers over these endpoints — no business logic lives in the adapters.

## The four operations

All three paths expose the same four operations:

| Operation | MCP tool | REST endpoint | When to use |
|---|---|---|---|
| Read context | `brain_query` | `POST /brain/query` | Session start, before design decisions |
| Write decisions | `brain_log_decision` | `POST /brain/agent-log` | When a significant choice is made |
| Check impact | `brain_analyze_impact` | `POST /brain/impact-analysis` | Before a significant change |
| Report a signal | `brain_log_signal` | `POST /brain/signal` | When something contradicts a prior decision |

## Session protocol

The protocol in `CLAUDE.md` defines when to call each operation. This is the discipline that makes the brain useful:

**Session start — required before writing any code.**
Call `brain_query` with the current task description and the project ID. Do not touch any file without loading context first. The brain may have a constraint that changes the approach entirely.

**Before significant implementation — required.**
Before changing ingestion workers, the brain store, query layer, API routes, or data schemas, call `brain_analyze_impact` with a plain-English description of what you are about to change.

**When a decision is made — call immediately, not at session end.**
Call `brain_log_decision` the moment a significant choice is made. Do not batch decisions for the end of the session. By session end, the agent's context may be compressed and the reasoning behind early decisions may be unrecoverable. One decision made = one `brain_log_decision` call.

**When something unexpected surfaces — call immediately.**
If you discover something that contradicts a past decision — a library limitation, API constraint, performance finding, or behavior that conflicts with an ADR — call `brain_log_signal` before continuing.

## Compliance rates by setup

Compliance is the percentage of sessions that successfully write decisions to the brain. This varies significantly by integration type:

| Setup | Write-back compliance |
|---|---|
| Claude Code with Stop hook | 85-90% |
| Claude Code without Stop hook | 60-70% |
| Cursor (instruction-only, no hook system) | 40-60% |
| LangGraph with BrainCallbackHandler | >95% (automated) |
| ADK with BrainSession context manager | >95% (automated) |

The Stop hook and automated handlers close the compliance gap that instruction-only approaches leave open. See [Write-Back](/agent-interface/write-back) for implementation details.
