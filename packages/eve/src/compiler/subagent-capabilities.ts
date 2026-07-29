/**
 * Structural input for {@link projectSubagentCapabilities}. Matches the
 * compiled subagent fields needed for inherit/effective projection without
 * depending on the full compiled manifest type graph.
 */
export interface ProjectableSubagentCapabilities {
  readonly agent: {
    readonly config: {
      readonly inherit?: {
        readonly connections?: boolean;
        readonly sandbox?: boolean;
      };
    };
    readonly connections: readonly unknown[];
    readonly sandbox: unknown | null;
    readonly sandboxWorkspaces: readonly unknown[];
  };
}

/**
 * Projected inherit flags and effective capability summary for one compiled
 * subagent. Shared by `eve info` and agent-info HTTP surfaces.
 */
export interface ProjectedSubagentCapabilities {
  readonly effective: {
    readonly connections: {
      readonly inherited: boolean;
      readonly owned: number;
    };
    readonly sandbox: "default" | "inherited" | "owned";
  };
  readonly inherit: {
    readonly connections: boolean;
    readonly sandbox: boolean;
  };
}

/**
 * Derives inherit flags and effective connection/sandbox capability labels
 * for a compiled subagent node.
 */
export function projectSubagentCapabilities(
  subagent: ProjectableSubagentCapabilities,
): ProjectedSubagentCapabilities {
  const inheritsConnections = subagent.agent.config.inherit?.connections === true;
  const inheritsSandbox = subagent.agent.config.inherit?.sandbox === true;

  return {
    effective: {
      connections: {
        inherited: inheritsConnections,
        owned: subagent.agent.connections.length,
      },
      sandbox: inheritsSandbox
        ? "inherited"
        : subagent.agent.sandbox === null && subagent.agent.sandboxWorkspaces.length === 0
          ? "default"
          : "owned",
    },
    inherit: {
      connections: inheritsConnections,
      sandbox: inheritsSandbox,
    },
  };
}
