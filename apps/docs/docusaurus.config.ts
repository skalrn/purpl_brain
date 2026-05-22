import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "purpl_brain docs",
  tagline: "Shared working memory for human-agent software teams",
  favicon: "img/logo.svg",

  url: "https://docs.purplbrain.dev",
  baseUrl: "/",

  organizationName: "purpl",
  projectName: "purpl-brain-docs",

  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "dark",
      disableSwitch: false,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: "purpl_brain",
      items: [
        {
          type: "docSidebar",
          sidebarId: "mainSidebar",
          position: "left",
          label: "Docs",
        },
        {
          href: "https://github.com/purpl/purpl_brain",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Documentation",
          items: [
            { label: "Introduction", to: "/" },
            { label: "How It Works", to: "/how-it-works/overview" },
            { label: "Agent Interface", to: "/agent-interface/overview" },
          ],
        },
        {
          title: "Reference",
          items: [
            { label: "Architecture Decisions", to: "/decisions/hybrid-brain-store" },
            { label: "Operations", to: "/operations/setup" },
            { label: "Roadmap", to: "/roadmap/phases" },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} Purpl. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "typescript", "python", "cypher"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
