import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCodeModeModelMatrix } from "../../../scripts/code-mode-model-matrix.ts";
import { validFrontierCellResult } from "./code-mode-model-matrix.test-helpers.js";

const profileId = "openai:matrix";
const credentialEnvName = "OPENAI_API_KEY";

function config(extra = ""): string {
  return `{
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4@${profileId}", fallbacks: [] },
        models: {
          "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
    auth: {
      profiles: {
        "${profileId}": { provider: "openai", mode: "api_key" },
      },
    },
    ${extra}
  }\n`;
}

const sourceIdentity = async () => ({
  gitSha: "abc123",
  sourceDirty: false,
  sourcePatchSha256: null,
});

const validAuthProfile = async () => ({
  credentialEnvName,
  credentialValue: "sk-admitted",
  mode: "api_key" as const,
  present: true,
  provider: "openai",
});

async function runBlocked(params: {
  configText: string;
  modes?: Array<"direct" | "auto" | "code">;
  readAuthProfile?: typeof validAuthProfile;
  thinking?: string;
}): Promise<unknown> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-preflight-"));
  try {
    const configPath = path.join(repoRoot, "matrix.json5");
    await fs.writeFile(configPath, params.configText, "utf8");
    const result = await runCodeModeModelMatrix(
      {
        allowFailures: true,
        config: configPath,
        dryRun: true,
        keepState: false,
        models: ["openai/gpt-5.4"],
        modes: params.modes ?? ["direct", "code"],
        outputDir: "artifacts",
        repetitions: 2,
        repoRoot,
        tasks: ["read"],
        thinking: params.thinking ?? "high",
        timeoutSeconds: 10,
      },
      {
        readAuthProfile: params.readAuthProfile ?? validAuthProfile,
        readSourceIdentity: sourceIdentity,
      },
    );
    expect(await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8")).toBe("");
    return result.summary;
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe("Code Mode frontier matrix preflight", () => {
  it.each(["off", "medium", "xhigh"])(
    "rejects a %s-thinking frontier comparison",
    async (thinking) => {
      await expect(runBlocked({ configText: config(), thinking })).resolves.toMatchObject({
        status: "blocked",
        cellsExecuted: 0,
        blockedReasons: ["thinking_level_not_comparable"],
      });
    },
  );

  it.each([
    ["config_runtime_env_present", config('env: { vars: { OPENAI_BASE_URL: "x" } },')],
    ["config_shell_env_enabled", config("env: { shellEnv: { enabled: true } },")],
    [
      "config_env_substitution_present",
      config('models: { providers: { openai: { baseUrl: "${OPENAI_BASE_URL}" } } },'),
    ],
  ])("blocks %s before any cell", async (code, configText) => {
    await expect(runBlocked({ configText })).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: [code],
    });
  });

  it("rejects a non-ABBA frontier schedule", async () => {
    await expect(
      runBlocked({ configText: config(), modes: ["direct", "auto", "code"] }),
    ).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: ["frontier_schedule_invalid"],
    });
  });

  it("rejects credentials that are not canonical env keyRefs", async () => {
    await expect(
      runBlocked({
        configText: config(),
        readAuthProfile: async () => ({
          mode: "api_key",
          present: true,
          provider: "openai",
        }),
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: ["auth_profile_not_env_keyref", "credential_environment_missing"],
    });
  });

  it("rejects a noncanonical credential environment before any cell", async () => {
    await expect(
      runBlocked({
        configText: config(),
        readAuthProfile: async () => ({
          credentialEnvName: "NODE_OPTIONS",
          credentialValue: "--import=/tmp/not-allowed.mjs",
          mode: "api_key",
          present: true,
          provider: "openai",
        }),
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: ["auth_profile_not_env_keyref"],
    });
  });

  it("keeps auth store failures distinct from config failures", async () => {
    await expect(
      runBlocked({
        configText: config(),
        readAuthProfile: async () => {
          throw new Error("credential store unreadable");
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: ["auth_profile_read_failed"],
    });
  });

  it.each([
    ["provider api key", config('models: { providers: { openai: { apiKey: "secret-marker" } } },')],
    ["provider timeout", config("models: { providers: { openai: { timeoutSeconds: 30 } } },")],
    [
      "provider token metadata",
      config(
        "models: { providers: { openai: { contextWindow: 200000, contextTokens: 180000, maxTokens: 64000 } } },",
      ),
    ],
    [
      "provider model metadata",
      config(
        'models: { providers: { openai: { models: [{ id: "gpt-5.4", name: "custom", contextWindow: 200000, maxTokens: 64000, compat: {} }] } } },',
      ),
    ],
    [
      "agent model streaming",
      config().replace(
        '{ agentRuntime: { id: "openclaw" } }',
        '{ agentRuntime: { id: "openclaw" }, streaming: false }',
      ),
    ],
  ])("rejects authored selected-route metadata: %s", async (_name, configText) => {
    await expect(runBlocked({ configText })).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: expect.arrayContaining(["selected_route_override_present"]),
    });
  });

  it("reuses the admitted credential value for every cell and removes the policy file", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-frozen-env-"));
    let authReads = 0;
    let clock = 0;
    let policyPath: string | undefined;
    let policyText: string | undefined;
    const observedCredentials: Array<string | undefined> = [];
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, config(), "utf8");
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: true,
          config: configPath,
          dryRun: false,
          keepState: false,
          models: ["openai/gpt-5.4"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["read"],
          thinking: "high",
          timeoutSeconds: 10,
        },
        {
          buildCliArtifacts: async () => {},
          nowMs: () => {
            clock += 10;
            return clock;
          },
          readAuthProfile: async () => {
            authReads += 1;
            return {
              credentialEnvName,
              credentialValue: authReads === 1 ? "sk-admitted" : "sk-mutated",
              mode: "api_key",
              present: true,
              provider: "openai",
            };
          },
          readBuildSha256: async () => "build123",
          readSourceIdentity: sourceIdentity,
          runCell: async (params) => {
            observedCredentials.push(params.frozenEnv[credentialEnvName]);
            policyPath = params.frontierEvidencePolicy?.path;
            policyText = policyPath ? await fs.readFile(policyPath, "utf8") : undefined;
            return await validFrontierCellResult(params);
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(observedCredentials).toEqual([
        "sk-admitted",
        "sk-admitted",
        "sk-admitted",
        "sk-admitted",
      ]);
      expect(policyPath).toBeDefined();
      expect(policyText).not.toContain(profileId);
      expect(JSON.parse(policyText ?? "{}")).toMatchObject({
        authBindingId: expect.stringMatching(/^[a-f0-9]{32}$/u),
      });
      await expect(fs.stat(policyPath!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
