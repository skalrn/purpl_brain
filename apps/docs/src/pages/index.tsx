import type { ReactNode } from "react";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import styles from "./index.module.css";

function HeroSection() {
  return (
    <div className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.badge}>Shared Working Memory for Agent Teams</div>
        <h1 className={styles.heroTitle}>purpl_brain</h1>
        <p className={styles.heroSubtitle}>
          Every AI coding session starts from zero. Decisions made last week die in the transcript.
          The next agent re-derives, re-guesses, and contradicts what the previous session already resolved.
        </p>
        <p className={styles.heroSubtitle}>
          purpl_brain is the persistent memory layer that agents write to at session end and read from at
          session start — grounded in your team's actual signals: GitHub PRs, Slack threads, Jira tickets,
          meeting transcripts, and prior agent runs.
        </p>
        <div className={styles.heroActions}>
          <Link className={styles.primaryButton} to="/intro">
            Read the Docs
          </Link>
          <Link className={styles.secondaryButton} to="/how-it-works/overview">
            How It Works
          </Link>
        </div>
      </div>
    </div>
  );
}

interface FeatureProps {
  title: string;
  description: string;
  detail: string;
}

const features: FeatureProps[] = [
  {
    title: "Cross-agent, cross-tool",
    description: "Claude Code and Cursor read from the same brain, with no manual sync.",
    detail:
      "MCP server for IDE agents. Python SDK for LangGraph and ADK. REST API for anything else. One brain, every agent.",
  },
  {
    title: "Structured decision trails",
    description: "Not unstructured text recall. Every decision carries rationale, alternatives, and a source citation.",
    detail:
      "\"Chose Redis over Postgres for the revocation list (latency budget, TTL-native eviction). Cited: agent-log abc123.\" That's the level of precision.",
  },
  {
    title: "Grounded in your signal history",
    description: "GitHub PRs, Slack threads, Jira tickets, meeting transcripts — all flowing into the same brain.",
    detail:
      "When an agent queries for context, it gets answers grounded in the actual conversations and commits where decisions were made, not a summary someone wrote by hand.",
  },
  {
    title: "Drift detection",
    description: "When a new decision contradicts a prior one, the brain flags it before it lands in production.",
    detail:
      "Two-stage detection: cosine similarity (threshold 0.72) + LLM confirmation. DriftAlert nodes are created and surfaced in the UI and to agents at session start.",
  },
  {
    title: "Auditable by humans",
    description: "The same brain that serves agents serves humans via a web UI.",
    detail:
      "Query: \"what did the agent decide about caching last week, and what PR did that come from?\" Every answer is cited. Nothing is opaque.",
  },
  {
    title: "Write-back compliance built in",
    description: "Stop hooks, callback handlers, quality gates — compliance is engineered, not hoped for.",
    detail:
      "Claude Code Stop hook (85-90% compliance). LangGraph BrainCallbackHandler. Schema validation gate with 422 on missing rationale. The brain fills because the system enforces it.",
  },
];

function FeatureCard({ title, description, detail }: FeatureProps) {
  return (
    <div className={styles.featureCard}>
      <h3 className={styles.featureTitle}>{title}</h3>
      <p className={styles.featureDescription}>{description}</p>
      <p className={styles.featureDetail}>{detail}</p>
    </div>
  );
}

function FeaturesSection() {
  return (
    <div className={styles.featuresSection}>
      <div className={styles.featuresInner}>
        <h2 className={styles.sectionTitle}>What makes it different</h2>
        <div className={styles.featuresGrid}>
          {features.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </div>
    </div>
  );
}

function QuickStartSection() {
  return (
    <div className={styles.quickStart}>
      <div className={styles.quickStartInner}>
        <h2 className={styles.sectionTitle}>Get started in five minutes</h2>
        <div className={styles.steps}>
          <div className={styles.step}>
            <div className={styles.stepNumber}>1</div>
            <div className={styles.stepContent}>
              <h3>Start the brain</h3>
              <pre className={styles.code}>docker compose up -d</pre>
            </div>
          </div>
          <div className={styles.step}>
            <div className={styles.stepNumber}>2</div>
            <div className={styles.stepContent}>
              <h3>Add to Claude Code</h3>
              <pre className={styles.code}>{`// ~/.claude/settings.json
"mcpServers": {
  "purpl-brain": {
    "command": "node",
    "args": ["/path/to/purpl_brain/apps/mcp/dist/index.js"],
    "env": { "BRAIN_API_URL": "http://localhost:3001" }
  }
}`}</pre>
            </div>
          </div>
          <div className={styles.step}>
            <div className={styles.stepNumber}>3</div>
            <div className={styles.stepContent}>
              <h3>Run two agent sessions</h3>
              <p>The second session recalls what the first decided. No manual intervention.</p>
            </div>
          </div>
        </div>
        <Link className={styles.primaryButton} to="/operations/setup">
          Full Setup Guide
        </Link>
      </div>
    </div>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <main>
        <HeroSection />
        <FeaturesSection />
        <QuickStartSection />
      </main>
    </Layout>
  );
}
