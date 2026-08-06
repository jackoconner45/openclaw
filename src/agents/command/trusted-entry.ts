import type { CliDeps } from "../../cli/deps.types.js";
import { getRuntimeConfig } from "../../config/io.js";
import { withLocalGatewayRequestScope } from "../../gateway/local-request-context.js";
import {
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import type { RuntimeEnv } from "../../runtime.js";
import { runWithAgentCommandRecoveryOwner } from "../agent-command-recovery-owner.js";
import { measureAgentStartup } from "../startup-timing.js";
import { prepareAgentCommandExecution } from "./prepare.js";
import { resolveAgentCommandDeps } from "./runtime-loaders.js";
import type { AgentCommandOpts } from "./types.js";

type PreparedAgentCommandExecution = Awaited<ReturnType<typeof prepareAgentCommandExecution>>;

export async function runTrustedAgentCommandEntry<TResult>(params: {
  opts: AgentCommandOpts;
  runtime: RuntimeEnv;
  deps?: CliDeps;
  run: (prepared: PreparedAgentCommandExecution, resolvedDeps: CliDeps) => Promise<TResult>;
}): Promise<TResult> {
  const resolvedDeps = await measureAgentStartup("command-dependencies", () =>
    resolveAgentCommandDeps(params.deps),
  );
  const lifecycleGeneration =
    params.opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(params.opts.runId ?? "");
  return await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    withLocalGatewayRequestScope(
      {
        deps: resolvedDeps,
        getRuntimeConfig,
      },
      async () =>
        await runWithAgentCommandRecoveryOwner({
          lifecycleGeneration,
          mode: "reject_uncoordinated",
          opts: {
            ...params.opts,
            lifecycleGeneration,
            // Only trusted local/system entrypoints may inherit operator defaults.
            senderIsOwner: params.opts.senderIsOwner ?? true,
            allowModelOverride: params.opts.allowModelOverride ?? true,
          },
          prepare: async (preparedOpts) =>
            await measureAgentStartup("command-prepare", () =>
              prepareAgentCommandExecution(preparedOpts, params.runtime),
            ),
          run: async (prepared) => await params.run(prepared, resolvedDeps),
        }),
    ),
  );
}
