import { BracesIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { linearLogo, notionLogo, sentryLogo, slackLogo, webLogo } from "@/lib/integrations/logos";
import type { RegistryIntegration } from "@/lib/registry/data";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const integrationIcons: Record<RegistryIntegration, IconComponent> = {
  "HTTP API": BracesIcon,
  Linear: linearLogo,
  Notion: notionLogo,
  Sentry: sentryLogo,
  Slack: slackLogo,
  "Web chat": webLogo,
};
