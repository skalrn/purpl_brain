import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  mainSidebar: [
    {
      type: "doc",
      id: "intro",
      label: "Introduction",
    },
    {
      type: "category",
      label: "Why Build This",
      collapsed: false,
      items: [
        "why/problem",
        "why/market",
        "why/bet",
      ],
    },
    {
      type: "category",
      label: "How It Works",
      collapsed: false,
      items: [
        "how-it-works/overview",
        "how-it-works/ingestion",
        "how-it-works/brain-store",
        "how-it-works/extraction",
        "how-it-works/drift-detection",
        "how-it-works/query-layer",
      ],
    },
    {
      type: "category",
      label: "Agent Interface",
      collapsed: false,
      items: [
        "agent-interface/overview",
        "agent-interface/mcp-server",
        "agent-interface/python-sdk",
        "agent-interface/write-back",
      ],
    },
    {
      type: "category",
      label: "Architecture Decisions",
      collapsed: true,
      items: [
        "decisions/hybrid-brain-store",
        "decisions/mcp-server-interface",
        "decisions/event-driven-ingestion",
        "decisions/agent-decision-trails",
      ],
    },
    {
      type: "category",
      label: "Operations",
      collapsed: true,
      items: [
        "operations/setup",
        "operations/cost-controls",
        "operations/evals",
      ],
    },
    {
      type: "category",
      label: "Pitfalls & Lessons",
      collapsed: true,
      items: [
        "pitfalls/empty-brain",
        "pitfalls/write-back-quality",
        "pitfalls/drift-triage-at-scale",
        "pitfalls/link-following",
        "pitfalls/temporal-correctness",
      ],
    },
    {
      type: "category",
      label: "Roadmap",
      collapsed: true,
      items: [
        "roadmap/phases",
        "roadmap/beta-setup",
        "roadmap/post-beta",
      ],
    },
  ],
};

export default sidebars;
