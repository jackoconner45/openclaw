import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { createQaPosixCommandSettlement } from "./posix-command-settlement.js";
import { resolveQaWindowsSystem32ExePath } from "./windows-system-tools.js";

export type QaScenarioCommandExecution = {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type QaScenarioCommandResult = {
  cleanupFailure?: string;
  exitCode: number;
  failureMessage?: string;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type QaScenarioCommandTerminalResult = Pick<
  QaScenarioCommandResult,
  "exitCode" | "failureMessage" | "signal"
>;

type QaScenarioTaskkillRunner = typeof spawnSync;

const QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS = 2_000;
const QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS = 500;
let timeoutKillGraceMs = QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS;
let timeoutForceSettleMs = QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS;

export function killQaScenarioWindowsProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  runTaskkill: QaScenarioTaskkillRunner = spawnSync,
) {
  if (pid === undefined) {
    return false;
  }
  const taskkillPath = resolveQaWindowsSystem32ExePath("taskkill.exe");
  const args = ["/pid", String(pid), "/T"];
  const run = (force: boolean) => {
    const result = runTaskkill(taskkillPath, force ? [...args, "/F"] : args, {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  };
  return signal === "SIGKILL" ? run(true) : run(false) || run(true);
}

export function runQaScenarioCommandLifecycle(
  execution: QaScenarioCommandExecution,
): Promise<QaScenarioCommandResult> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const child = spawn(execution.command, execution.args, {
      cwd: execution.cwd,
      detached: !isWindows,
      env: execution.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const commandLabel = path.basename(execution.command);
    createQaPosixCommandSettlement({
      child,
      cleanupFailureMessage: `${commandLabel} left background processes running`,
      forceKillAfterMs: timeoutKillGraceMs,
      ...(isWindows
        ? {
            windowsCleanup: {
              alive: () => child.pid !== undefined,
              signal: (signal: NodeJS.Signals) => {
                try {
                  if (!killQaScenarioWindowsProcessTree(child.pid, signal)) {
                    child.kill(signal);
                  }
                  return undefined;
                } catch (error) {
                  return error instanceof Error ? error : new Error(String(error));
                }
              },
            },
          }
        : {}),
      executionTimeoutMs: execution.timeoutMs,
      forwardParentSignals: true,
      initialSignal: "SIGTERM",
      onSettled: (outcome) => {
        const primary = outcome.primary;
        if (primary.type === "spawn-error" || primary.type === "stream-error") {
          reject(
            outcome.cleanupFailure
              ? new AggregateError(
                  [primary.error, outcome.cleanupFailure],
                  `${commandLabel} failed and cleanup did not complete`,
                )
              : primary.error,
          );
          return;
        }
        const result: QaScenarioCommandTerminalResult =
          primary.type === "exit"
            ? {
                exitCode: primary.exitCode ?? (primary.signal ? 1 : 0),
                signal: primary.signal,
              }
            : primary.type === "parent-signal"
              ? {
                  exitCode: 1,
                  failureMessage: `${commandLabel} interrupted by ${primary.signal}`,
                  signal: primary.signal,
                }
              : {
                  exitCode: 1,
                  failureMessage: `${commandLabel} timed out after ${execution.timeoutMs}ms`,
                  signal: null,
                };
        const cleanupFailure = outcome.cleanupFailure?.message;
        resolve({
          ...result,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          ...(cleanupFailure
            ? result.failureMessage
              ? { cleanupFailure }
              : { failureMessage: cleanupFailure }
            : {}),
        });
      },
      onStderrData: (chunk) => stderr.push(Buffer.from(chunk)),
      onStdoutData: (chunk) => stdout.push(Buffer.from(chunk)),
      processGroupId: isWindows ? undefined : child.pid,
      verifyAfterMs: timeoutForceSettleMs,
    });
  });
}

export function resetQaScenarioCommandCleanupTimings() {
  timeoutKillGraceMs = QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS;
  timeoutForceSettleMs = QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS;
}

export function setQaScenarioCommandCleanupTimings(params: {
  forceSettleMs: number;
  killGraceMs: number;
}) {
  timeoutKillGraceMs = params.killGraceMs;
  timeoutForceSettleMs = params.forceSettleMs;
}
