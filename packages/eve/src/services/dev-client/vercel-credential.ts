import type { VerifiedVercelTarget } from "#setup/vercel-deployment.js";

import {
  resolveDevelopmentOidcToken,
  type DevelopmentOidcTokenFailure,
} from "./request-headers.js";

export type VercelCredentialPreparation =
  | { readonly kind: "prepared"; readonly resolveToken: () => Promise<string> }
  | { readonly kind: "failed"; readonly failure: DevelopmentOidcTokenFailure };

/** Prepares a project-scoped OIDC credential and a refresh function for one verified target. */
export async function prepareVercelCredential(
  target: VerifiedVercelTarget,
  resolveOidcToken: typeof resolveDevelopmentOidcToken = resolveDevelopmentOidcToken,
): Promise<VercelCredentialPreparation> {
  const { ownerId, projectId } = target.deployment;
  const initial = await resolveOidcToken({ ownerId, projectId, forceRefresh: true });
  if (initial.kind !== "resolved") return { kind: "failed", failure: initial };

  let token = initial.token.trim();
  return {
    kind: "prepared",
    resolveToken: async () => {
      const refreshed = await resolveOidcToken(target.deployment);
      if (refreshed.kind === "resolved") token = refreshed.token.trim();
      return token;
    },
  };
}
