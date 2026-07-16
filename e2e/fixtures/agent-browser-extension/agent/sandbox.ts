import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defaultBackend, defineSandbox } from "eve/sandbox";

export default defineSandbox({
  backend: defaultBackend(),
  revalidationKey: () => agentBrowserRevalidationKey(),
  async bootstrap({ use }) {
    await installAgentBrowser(await use());
  },
});
