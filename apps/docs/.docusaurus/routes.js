import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/',
    component: ComponentCreator('/', 'e5f'),
    exact: true
  },
  {
    path: '/',
    component: ComponentCreator('/', '589'),
    routes: [
      {
        path: '/',
        component: ComponentCreator('/', 'abf'),
        routes: [
          {
            path: '/',
            component: ComponentCreator('/', '957'),
            routes: [
              {
                path: '/agent-interface/mcp-server',
                component: ComponentCreator('/agent-interface/mcp-server', 'c9e'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/agent-interface/overview',
                component: ComponentCreator('/agent-interface/overview', 'b67'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/agent-interface/python-sdk',
                component: ComponentCreator('/agent-interface/python-sdk', 'b57'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/agent-interface/write-back',
                component: ComponentCreator('/agent-interface/write-back', '07e'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/decisions/agent-decision-trails',
                component: ComponentCreator('/decisions/agent-decision-trails', '577'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/decisions/event-driven-ingestion',
                component: ComponentCreator('/decisions/event-driven-ingestion', '291'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/decisions/hybrid-brain-store',
                component: ComponentCreator('/decisions/hybrid-brain-store', 'bb5'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/decisions/mcp-server-interface',
                component: ComponentCreator('/decisions/mcp-server-interface', 'b7d'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/how-it-works/brain-store',
                component: ComponentCreator('/how-it-works/brain-store', '79f'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/how-it-works/drift-detection',
                component: ComponentCreator('/how-it-works/drift-detection', 'b9d'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/how-it-works/extraction',
                component: ComponentCreator('/how-it-works/extraction', '861'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/how-it-works/ingestion',
                component: ComponentCreator('/how-it-works/ingestion', '034'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/how-it-works/overview',
                component: ComponentCreator('/how-it-works/overview', '4b9'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/how-it-works/query-layer',
                component: ComponentCreator('/how-it-works/query-layer', 'fdd'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/intro',
                component: ComponentCreator('/intro', '9af'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/operations/cost-controls',
                component: ComponentCreator('/operations/cost-controls', '06f'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/operations/evals',
                component: ComponentCreator('/operations/evals', '57e'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/operations/setup',
                component: ComponentCreator('/operations/setup', 'ea9'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/pitfalls/drift-triage-at-scale',
                component: ComponentCreator('/pitfalls/drift-triage-at-scale', '18f'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/pitfalls/empty-brain',
                component: ComponentCreator('/pitfalls/empty-brain', '30a'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/pitfalls/link-following',
                component: ComponentCreator('/pitfalls/link-following', 'd80'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/pitfalls/temporal-correctness',
                component: ComponentCreator('/pitfalls/temporal-correctness', '6a9'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/pitfalls/write-back-quality',
                component: ComponentCreator('/pitfalls/write-back-quality', '7a1'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/roadmap/beta-setup',
                component: ComponentCreator('/roadmap/beta-setup', '686'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/roadmap/phases',
                component: ComponentCreator('/roadmap/phases', 'bdb'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/roadmap/post-beta',
                component: ComponentCreator('/roadmap/post-beta', '8b1'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/why/bet',
                component: ComponentCreator('/why/bet', '789'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/why/market',
                component: ComponentCreator('/why/market', '4cb'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/why/problem',
                component: ComponentCreator('/why/problem', 'dc4'),
                exact: true,
                sidebar: "mainSidebar"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
