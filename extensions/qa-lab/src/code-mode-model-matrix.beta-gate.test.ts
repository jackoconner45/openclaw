import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodeModeMatrixBetaGate,
  classifyMatrixCacheStatus,
  resolveCodeModeMatrixExitCode,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
} from "../../../scripts/code-mode-model-matrix.ts";

const frozenConfig = `{
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4@openai:matrix", fallbacks: [] },
      models: {
        "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
      },
    },
  },
  auth: {
    profiles: {
      "openai:matrix": { provider: "openai", mode: "api_key" },
    },
  },
}\n`;

const matrixAuthProfile = async (_params: { profileId: string }) => ({
  credentialEnvName: "OPENAI_API_KEY",
  credentialValue: "sk-matrix-test",
  mode: "api_key",
  present: true,
  provider: "openai",
});

const exact = (value: number) => ({ state: "exact" as const, value });

function result(params: {
  mode: "direct" | "code";
  repetition: number;
  cachedInput: number;
  firstCachedInput?: number;
  effectiveTurns: number;
  tokens: number;
  elapsedMs?: number;
  physicalFetchDispatch?: number;
  wallLatencyMs?: number;
}): CodeModeMatrixCellResult {
  const physicalFetchDispatch = params.physicalFetchDispatch ?? (params.mode === "code" ? 1 : 2);
  const totalToolOperations = params.mode === "code" ? 2 : 1;
  return {
    buildSha256: "build",
    firstLogicalCallCacheStatus: (params.firstCachedInput ?? 0) === 0 ? "cold" : "warm",
    codeModeEngaged: params.mode === "code",
    configSha256: "config",
    elapsedMs: params.elapsedMs ?? 100,
    wallLatencyMs: params.wallLatencyMs ?? params.elapsedMs ?? 100,
    expected: "expected",
    failureCategory: null,
    final: "expected",
    fixtureSha256: "fixture",
    gitSha: "git",
    id: `${params.mode}-${String(params.repetition)}`,
    mode: params.mode,
    model: "openai/gpt-5.4",
    observedModel: "gpt-5.4",
    observedProvider: "openai",
    oracle: {
      answer: true,
      effect: true,
      engagement: true,
      identity: true,
      toolExecution: true,
    },
    passed: true,
    promptSha256: "prompt",
    repetition: params.repetition,
    sourceDirty: false,
    sourcePatchSha256: null,
    status: "ok",
    task: "read",
    timestamp: "2026-08-06T00:00:00.000Z",
    trace: {
      schemaVersion: 4,
      source: "agent-command-accounting",
      route: {
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-responses",
        runtime: "embedded",
      },
      metrics: {
        effectiveTurns: exact(params.effectiveTurns),
        logicalModelCalls: exact(1),
        providerAttempts: {
          total: exact(1),
          initial: exact(1),
          retries: exact(0),
          authRecoveries: exact(0),
          payloadRecoveries: exact(0),
          transportFallbacks: exact(0),
        },
        physicalFetchDispatch: exact(physicalFetchDispatch),
        outerToolCalls: exact(1),
        codeModeBridgeCalls: exact(params.mode === "code" ? 1 : 0),
        totalToolOperations: exact(totalToolOperations),
        underlyingTotalCalls: exact(physicalFetchDispatch + totalToolOperations),
        tokens: {
          input: exact(params.tokens - 10),
          cachedInput: exact(params.cachedInput),
          firstLogicalCallCachedInput: exact(params.firstCachedInput ?? 0),
          output: exact(10),
          reasoning: exact(0),
          total: exact(params.tokens),
        },
        agentDurationMs: exact(50),
        commandExecutionDurationMs: exact(50),
      },
      audit: { state: "valid" },
    },
  };
}

function passingCells(): CodeModeMatrixCellResult[] {
  return [
    result({
      mode: "direct",
      repetition: 1,
      cachedInput: 0,
      effectiveTurns: 4,
      tokens: 100,
    }),
    result({
      mode: "code",
      repetition: 1,
      cachedInput: 0,
      effectiveTurns: 2,
      tokens: 80,
    }),
    result({
      mode: "code",
      repetition: 2,
      cachedInput: 10,
      effectiveTurns: 2,
      tokens: 80,
    }),
    result({
      mode: "direct",
      repetition: 2,
      cachedInput: 10,
      effectiveTurns: 4,
      tokens: 100,
    }),
  ];
}

describe("Code Mode matrix Beta gate", () => {
  it("derives cache state only from exact cached input", () => {
    expect(
      classifyMatrixCacheStatus(
        result({
          mode: "direct",
          repetition: 1,
          cachedInput: 0,
          effectiveTurns: 2,
          tokens: 20,
        }).trace,
      ),
    ).toBe("cold");
    expect(
      classifyMatrixCacheStatus(
        result({
          mode: "code",
          repetition: 1,
          cachedInput: 5,
          firstCachedInput: 5,
          effectiveTurns: 1,
          tokens: 15,
        }).trace,
      ),
    ).toBe("warm");
    const legacy = structuredClone(
      result({
        mode: "direct",
        repetition: 1,
        cachedInput: 0,
        effectiveTurns: 2,
        tokens: 20,
      }).trace,
    ) as unknown as { schemaVersion: number };
    legacy.schemaVersion = 3;
    expect(classifyMatrixCacheStatus(legacy as never)).toBe("unknown");
    const unknown = result({
      mode: "direct",
      repetition: 1,
      cachedInput: 0,
      effectiveTurns: 2,
      tokens: 20,
    }).trace!;
    unknown.metrics.tokens.firstLogicalCallCachedInput = {
      state: "unknown",
      reasons: ["first_logical_call_cached_input_unknown"],
    };
    expect(classifyMatrixCacheStatus(unknown)).toBe("unknown");
    expect(classifyMatrixCacheStatus(undefined)).toBe("unknown");
  });

  it("requires every conjunctive Beta bar and blocks call regressions", () => {
    const cells = passingCells();
    expect(buildCodeModeMatrixBetaGate(cells)).toMatchObject({
      state: "diagnostic_pass",
      bars: {
        accuracyNonRegression: "pass",
        fewerEffectiveTurns: "pass",
        fewerTokens: "pass",
        noRegressionInCallsOrWallLatency: "pass",
        auditableMatchedTraces: "pass",
        coldInitialPerCell: "pass",
      },
      totals: {
        direct: {
          cachedInputTokens: 10,
          providerAttempts: 2,
          retries: 0,
          authRecoveries: 0,
          payloadRecoveries: 0,
          transportFallbacks: 0,
          additionalProviderAttempts: 0,
          physicalFetchDispatch: 4,
          totalToolOperations: 2,
          underlyingTotalCalls: 6,
          wallLatencyMs: 200,
        },
        code: {
          cachedInputTokens: 10,
          providerAttempts: 2,
          retries: 0,
          authRecoveries: 0,
          payloadRecoveries: 0,
          transportFallbacks: 0,
          additionalProviderAttempts: 0,
          physicalFetchDispatch: 2,
          totalToolOperations: 4,
          underlyingTotalCalls: 6,
          wallLatencyMs: 200,
        },
      },
    });
    const regressed = structuredClone(cells);
    for (const cell of regressed) {
      if (cell.mode === "code" && cell.trace) {
        cell.trace.metrics.physicalFetchDispatch = exact(2);
        cell.trace.metrics.underlyingTotalCalls = exact(4);
      }
    }
    expect(buildCodeModeMatrixBetaGate(regressed)).toMatchObject({
      state: "blocked",
      bars: { noRegressionInCallsOrWallLatency: "fail" },
    });
    const warm = structuredClone(cells);
    for (const cell of warm) {
      if (cell.trace) {
        cell.trace.metrics.tokens.firstLogicalCallCachedInput = exact(1);
        cell.firstLogicalCallCacheStatus = "warm";
      }
    }
    expect(buildCodeModeMatrixBetaGate(warm)).toMatchObject({
      state: "blocked",
      bars: { coldInitialPerCell: "fail" },
    });

    const missingWallLatency = structuredClone(cells);
    delete missingWallLatency[1]!.wallLatencyMs;
    expect(buildCodeModeMatrixBetaGate(missingWallLatency)).toMatchObject({
      state: "inconclusive",
      bars: { noRegressionInCallsOrWallLatency: "unknown" },
      totals: { code: { wallLatencyMs: null } },
    });
  });

  it("keeps every non-initial provider-attempt category distinct", () => {
    const cells = passingCells();
    for (const cell of cells) {
      if (!cell.trace) {
        continue;
      }
      const attempts = cell.trace.metrics.providerAttempts;
      attempts.total = exact(2);
      if (cell.mode === "direct" && cell.repetition === 1) {
        attempts.retries = exact(1);
      } else if (cell.mode === "direct") {
        attempts.authRecoveries = exact(1);
      } else if (cell.repetition === 1) {
        attempts.payloadRecoveries = exact(1);
      } else {
        attempts.transportFallbacks = exact(1);
      }
    }

    expect(buildCodeModeMatrixBetaGate(cells)).toMatchObject({
      totals: {
        direct: {
          providerAttempts: 4,
          retries: 1,
          authRecoveries: 1,
          payloadRecoveries: 0,
          transportFallbacks: 0,
          additionalProviderAttempts: 2,
        },
        code: {
          providerAttempts: 4,
          retries: 0,
          authRecoveries: 0,
          payloadRecoveries: 1,
          transportFallbacks: 1,
          additionalProviderAttempts: 2,
        },
      },
    });
  });

  it("returns nonzero unless every Beta and optional behavior gate passes", () => {
    const passing = {
      allowFailures: true,
      betaGateState: "diagnostic_pass" as const,
      failed: 0,
      frontierEvidenceValid: true,
    };
    expect(resolveCodeModeMatrixExitCode(passing)).toBe(0);
    expect(resolveCodeModeMatrixExitCode({ ...passing, betaGateState: "blocked" })).toBe(1);
    expect(resolveCodeModeMatrixExitCode({ ...passing, betaGateState: "inconclusive" })).toBe(1);
    expect(resolveCodeModeMatrixExitCode({ ...passing, conversationProofStatus: "fail" })).toBe(1);
  });
});

describe("Code Mode matrix conversation-proof schedule", () => {
  it("dry-runs exactly six planned executions without providers", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-dry-run-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, frozenConfig, "utf8");
      const runCell = vi.fn();
      const matrix = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          config: configPath,
          conversationProof: true,
          dryRun: true,
          keepState: false,
          models: ["openai/gpt-5.4"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          readAuthProfile: matrixAuthProfile,
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
          runCell,
        },
      );

      expect(matrix.exitCode).toBe(0);
      expect(runCell).not.toHaveBeenCalled();
      expect(matrix.summary).toMatchObject({
        status: "dry-run",
        cellsExecuted: 0,
        totalPlanned: 6,
        plannedExecutions: { matrix: 4, conversationProof: 2, total: 6 },
      });
      const manifest = JSON.parse(
        await fs.readFile(path.join(repoRoot, "artifacts", "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        plannedExecutions: { matrix: 4, conversationProof: 2, total: 6 },
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("blocks conversation proof outside the exact paired schedule", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-schedule-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, frozenConfig, "utf8");
      const matrix = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          config: configPath,
          conversationProof: true,
          dryRun: true,
          keepState: false,
          models: ["openai/gpt-5.4"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["read", "dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          readAuthProfile: matrixAuthProfile,
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
        },
      );

      expect(matrix.exitCode).toBe(1);
      expect(matrix.summary).toMatchObject({
        status: "blocked",
        blockedReasons: ["conversation_proof_schedule_invalid"],
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});
