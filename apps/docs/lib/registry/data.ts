export type RegistryCategory = "Chat" | "Collaboration" | "Example";
export type RegistryIntegration = "HTTP API" | "Slack" | "Web chat";
export type RegistrySource = "GitHub" | "Vercel Templates";

export interface RegistryEntry {
  category: RegistryCategory;
  description: string;
  href: string;
  integrations: RegistryIntegration[];
  source: RegistrySource;
  sourceHref: string;
  title: string;
}

export const registryEntries: RegistryEntry[] = [
  {
    title: "eve Chat Template",
    description:
      "A persisted Next.js chat template for eve, built with shadcn/ui, Tailwind CSS, Streamdown, Better Auth, Drizzle, Neon, and Upstash Redis.",
    href: "https://vercel.com/templates/eve/eve-chat-template",
    sourceHref: "https://github.com/vercel-labs/eve-chat-template",
    category: "Chat",
    integrations: ["Web chat"],
    source: "Vercel Templates",
  },
  {
    title: "eve Slack Agent",
    description:
      "A Slack agent template with webhook handling, Vercel Connect, a starter agent, and an example tool ready to deploy on Vercel.",
    href: "https://vercel.com/templates/eve/eve-slack-agent",
    sourceHref: "https://github.com/vercel-labs/eve-slack-agent-template",
    category: "Collaboration",
    integrations: ["Slack"],
    source: "Vercel Templates",
  },
  {
    title: "Weather Agent Fixture",
    description:
      "A small representative eve app with agent config, instructions, a typed weather tool, and a markdown skill.",
    href: "https://github.com/vercel/eve/tree/main/apps/fixtures/weather-agent",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/fixtures/weather-agent",
    category: "Example",
    integrations: ["HTTP API"],
    source: "GitHub",
  },
];
