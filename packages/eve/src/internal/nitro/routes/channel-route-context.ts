import type { RouteHandlerArgs } from "#channel/routes.js";
import type { AgentInvocationService } from "#internal/invocation/agent-invocation-service.js";
import type { Agent } from "#public/definitions/channel.js";

type AgentInfoRouteResponse = () => Promise<Response>;

const agentInfoRouteResponseKey = "__eveAgentInfoRouteResponse";
const routeAgentKey = "__eveRouteAgent";
const agentInvocationServiceKey = "__eveAgentInvocationService";

type InternalRouteArgs = RouteHandlerArgs & {
  [agentInfoRouteResponseKey]?: AgentInfoRouteResponse;
  [routeAgentKey]?: Agent;
  [agentInvocationServiceKey]?: AgentInvocationService;
};

export interface InternalRouteContext {
  readonly agent: Agent;
  readonly agentInfoRouteResponse: AgentInfoRouteResponse;
  readonly agentInvocationService: AgentInvocationService;
}

export function attachInternalRouteContext<TArgs extends RouteHandlerArgs>(
  args: TArgs,
  context: InternalRouteContext,
): TArgs {
  const routeArgs: InternalRouteArgs = args;
  routeArgs[agentInfoRouteResponseKey] = context.agentInfoRouteResponse;
  routeArgs[routeAgentKey] = context.agent;
  routeArgs[agentInvocationServiceKey] = context.agentInvocationService;
  return args;
}

export function readAgentInfoRouteResponse(
  args: RouteHandlerArgs,
): AgentInfoRouteResponse | undefined {
  const routeArgs: InternalRouteArgs = args;
  return routeArgs[agentInfoRouteResponseKey];
}

export function attachRouteAgent<TArgs extends RouteHandlerArgs>(args: TArgs, agent: Agent): TArgs {
  const routeArgs: InternalRouteArgs = args;
  routeArgs[routeAgentKey] = agent;
  return args;
}

export function readRouteAgent(args: RouteHandlerArgs<any>): Agent | undefined {
  const routeArgs: InternalRouteArgs = args;
  return routeArgs[routeAgentKey];
}

export function readAgentInvocationService(
  args: RouteHandlerArgs<any>,
): AgentInvocationService | undefined {
  const routeArgs: InternalRouteArgs = args;
  return routeArgs[agentInvocationServiceKey];
}
