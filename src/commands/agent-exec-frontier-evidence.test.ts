import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import {
  getFrontierEvidenceExpectedAuthProfileId,
  getFrontierEvidencePolicy,
} from "../agents/frontier-evidence-policy.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentExecCommand } from "./agent-exec.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function successResult() {
  return {
    payloads: [{ text: "done" }],
    meta: {
      durationMs: 25,
      finalAssistantVisibleText: "done",
      agentMeta: {
        sessionId: "session-result",
        provider: "openai",
        model: "gpt-5.4",
        usage: { input: 10, output: 2, total: 12 },
      },
    },
  };
}

async function writeFrontierEvidenceFixture(params: {
  credentialEnvName: string;
  profileId: string;
}): Promise<{
  configPath: string;
  policyPath: string;
  policySha256: string;
}> {
  const root = await makeTempRoot("openclaw-frontier-evidence-");
  const configPath = path.join(root, "openclaw.json5");
  const config = `{
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4@${params.profileId}", fallbacks: [] },
        models: {
          "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
    auth: {
      profiles: {
        "${params.profileId}": { provider: "openai", mode: "api_key" },
      },
    },
  }\n`;
  await fs.writeFile(configPath, config, "utf8");
  const policy = {
    version: 1,
    configSha256: createHash("sha256").update(config).digest("hex"),
    defaultAgentId: "main",
    provider: "openai",
    model: "gpt-5.4",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    runtime: "openclaw",
    authBindingId: "c".repeat(32),
    credentialState: "frozen_in_memory",
    credentialEnvName: params.credentialEnvName,
    fallbacks: "disabled",
    proxy: "disabled",
    tls: "default",
    localService: "disabled",
    endpoint: {
      origin: "https://api.openai.com",
      pathname: "/v1/responses",
      method: "POST",
      transport: "responses-sdk",
    },
    thinking: "high",
    seed: "absent",
    authoredRequestParams: "absent",
    allowedRequestControls: [],
  };
  const rawPolicy = `${JSON.stringify(policy)}\n`;
  const policyPath = path.join(root, "policy.json");
  await fs.writeFile(policyPath, rawPolicy, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(policyPath, 0o600);
  return {
    configPath,
    policyPath,
    policySha256: createHash("sha256").update(rawPolicy).digest("hex"),
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("agent exec frontier evidence admission", () => {
  it("uses the admitted credential from the in-memory frontier snapshot", async () => {
    const credentialEnvName = "OPENAI_API_KEY";
    const previousCredential = process.env[credentialEnvName];
    process.env[credentialEnvName] = "sk-admitted";
    const fixture = await writeFrontierEvidenceFixture({
      credentialEnvName,
      profileId: "openai:matrix",
    });
    let observedCredential: unknown;
    let observedExpectedProfileId: string | undefined;
    let observedPolicySha256: string | undefined;
    try {
      const result = await agentExecCommand(
        "inspect",
        {
          config: fixture.configPath,
          frontierEvidencePolicy: fixture.policyPath,
          frontierEvidencePolicySha256: fixture.policySha256,
          thinking: "high",
        },
        createRuntime(),
        {
          runAgent: vi.fn(async () => {
            process.env[credentialEnvName] = "sk-mutated-after-admission";
            observedCredential = ensureAuthProfileStore().profiles["openai:matrix"];
            observedExpectedProfileId = getFrontierEvidenceExpectedAuthProfileId();
            observedPolicySha256 = getFrontierEvidencePolicy()?.policySha256;
            return successResult();
          }),
        },
      );
      expect(result.exitCode).toBe(0);
    } finally {
      if (previousCredential === undefined) {
        delete process.env[credentialEnvName];
      } else {
        process.env[credentialEnvName] = previousCredential;
      }
    }

    expect(observedCredential).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-admitted",
    });
    expect(observedExpectedProfileId).toBe("openai:matrix");
    expect(observedPolicySha256).toBe(fixture.policySha256);
    expect(getFrontierEvidencePolicy()).toBeUndefined();
    expect(getFrontierEvidenceExpectedAuthProfileId()).toBeUndefined();
  });

  it("rejects a mismatched frontier policy digest before the agent runs", async () => {
    const credentialEnvName = "OPENAI_API_KEY";
    const previousCredential = process.env[credentialEnvName];
    process.env[credentialEnvName] = "sk-admitted";
    const fixture = await writeFrontierEvidenceFixture({
      credentialEnvName,
      profileId: "openai:matrix",
    });
    const runAgent = vi.fn(async () => successResult());
    try {
      const result = await agentExecCommand(
        "inspect",
        {
          config: fixture.configPath,
          frontierEvidencePolicy: fixture.policyPath,
          frontierEvidencePolicySha256: "0".repeat(64),
          thinking: "high",
        },
        createRuntime(),
        { runAgent },
      );
      expect(result).toMatchObject({
        exitCode: 1,
        envelope: {
          error: {
            kind: "exception",
            message: "frontier evidence policy SHA-256 mismatch",
          },
        },
      });
    } finally {
      if (previousCredential === undefined) {
        delete process.env[credentialEnvName];
      } else {
        process.env[credentialEnvName] = previousCredential;
      }
    }
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects a thinking-level downgrade before the agent runs", async () => {
    const credentialEnvName = "OPENAI_API_KEY";
    const previousCredential = process.env[credentialEnvName];
    process.env[credentialEnvName] = "sk-admitted";
    const fixture = await writeFrontierEvidenceFixture({
      credentialEnvName,
      profileId: "openai:matrix",
    });
    const runAgent = vi.fn(async () => successResult());
    try {
      const result = await agentExecCommand(
        "inspect",
        {
          config: fixture.configPath,
          frontierEvidencePolicy: fixture.policyPath,
          frontierEvidencePolicySha256: fixture.policySha256,
          thinking: "medium",
        },
        createRuntime(),
        { runAgent },
      );
      expect(result).toMatchObject({
        exitCode: 1,
        envelope: {
          error: {
            kind: "exception",
            message: "frontier evidence thinking level mismatch",
          },
        },
      });
    } finally {
      if (previousCredential === undefined) {
        delete process.env[credentialEnvName];
      } else {
        process.env[credentialEnvName] = previousCredential;
      }
    }
    expect(runAgent).not.toHaveBeenCalled();
  });
});
