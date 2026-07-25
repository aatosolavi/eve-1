/** Stable framework name for the provider-managed web search tool. */
export const WEB_SEARCH_TOOL_NAME = "web_search";

const UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME: Readonly<Record<string, string>> = {
  web_search_20250305: WEB_SEARCH_TOOL_NAME,
};

/** Maps an upstream provider tool type to the framework tool that injected it. */
export function resolveFrameworkToolFromUpstreamType(type: string): string | null {
  return UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME[type] ?? null;
}
