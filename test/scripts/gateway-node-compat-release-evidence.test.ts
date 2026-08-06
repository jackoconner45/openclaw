import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_NODE_COMPAT_SCHEMA,
  canonicalizeGatewayNodeCompatEvidence,
} from "../../scripts/gateway-node-compat-evidence.mjs";
import {
  GATEWAY_NODE_COMPAT_BASELINE_VERSION,
  GATEWAY_NODE_COMPAT_EVIDENCE_WORKFLOW,
  GATEWAY_NODE_COMPAT_PRODUCER_JOB,
  GATEWAY_NODE_COMPAT_RELEASE_CHECKS_WORKFLOW,
  GATEWAY_NODE_COMPAT_RELEASE_SCHEMA,
  collectGatewayNodeCompatReleaseEvidence,
  renderGatewayNodeCompatSummary,
  selectGatewayNodeCompatArtifact,
  validateGatewayNodeCompatEvidenceSet,
  validateGatewayNodeCompatManifestEvidence,
} from "../../scripts/gateway-node-compat-release-evidence.mjs";

const REPOSITORY = "openclaw/openclaw";
const RUN_ID = "30710361061";
const RUN_ATTEMPT = 3;
const TARGET_SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const BASELINE_SHA = "c".repeat(40);
const DIRECTIONS = [
  "baseline-gateway-baseline-node",
  "baseline-gateway-candidate-node",
  "baseline-gateway-disjoint-node",
  "candidate-gateway-baseline-node",
  "candidate-gateway-candidate-node",
  "candidate-gateway-disjoint-node",
] as const;

function actionsArtifact(seed: number, name: string) {
  const digestSeed = seed === 11 ? "1" : "2";
  return {
    digest: `sha256:${digestSeed.repeat(64)}`,
    id: seed,
    name,
    runAttempt: RUN_ATTEMPT,
    runId: RUN_ID,
    sizeBytes: 4096,
  };
}

function runtimeBinding(role: "baseline" | "candidate") {
  const candidate = role === "candidate";
  const sourceSha = candidate ? TARGET_SHA : BASELINE_SHA;
  const version = candidate ? "2026.8.6" : GATEWAY_NODE_COMPAT_BASELINE_VERSION;
  return {
    installedRuntime: {
      identitySha256: candidate ? "d".repeat(64) : "e".repeat(64),
      sourceSha,
      version,
    },
    packagedArtifact: {
      actionsArtifact: actionsArtifact(
        candidate ? 11 : 22,
        candidate ? "openclaw-candidate-input" : "openclaw-baseline-input",
      ),
      name: candidate ? "openclaw-candidate.tgz" : "openclaw-baseline.tgz",
      sha256: candidate ? "f".repeat(64) : "1".repeat(64),
      sourceSha,
      version,
    },
  };
}

function directionRoles(direction: (typeof DIRECTIONS)[number]) {
  return {
    gateway: direction.startsWith("candidate-") ? "candidate" : "baseline",
    node: direction.includes("-baseline-node") ? "baseline" : "candidate",
  } as const;
}

function evidence(direction: (typeof DIRECTIONS)[number]) {
  const roles = directionRoles(direction);
  const mismatch = direction.includes("-disjoint-node");
  const candidateGateway = roles.gateway === "candidate";
  const gatewayProtocol = candidateGateway ? 4 : 3;
  return {
    caseId: `linux-x64-${direction}`,
    connection: {
      mode: "node",
      role: "node",
      transport: "gateway-websocket",
    },
    direction,
    gateway: runtimeBinding(roles.gateway),
    node: {
      architecture: "x64",
      kind: "linux",
      protocolClientId: "node-host",
      ...runtimeBinding(roles.node),
    },
    operation: mismatch
      ? null
      : {
          command: "system.which",
          method: "node.invoke",
          ok: true,
          params: { bins: ["node"] },
          result: { bins: { node: "/usr/bin/node" } },
        },
    producer: {
      job: "gateway_node_linux_compat",
      repository: REPOSITORY,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      workflowPath: GATEWAY_NODE_COMPAT_EVIDENCE_WORKFLOW,
      workflowSha: WORKFLOW_SHA,
    },
    protocol: {
      gatewayAcceptedNodeMin: 3,
      gatewayProtocolVersion: gatewayProtocol,
      helloProtocol: mismatch ? null : gatewayProtocol,
      protocolClientAdvertisedMax: mismatch ? 2 : roles.node === "candidate" ? 4 : 3,
      protocolClientAdvertisedMin: mismatch ? 1 : 3,
    },
    result: mismatch
      ? {
          completedAt: "2026-08-06T12:00:01.000Z",
          failureCode: "PROTOCOL_MISMATCH",
          failurePhase: "connect",
          outcome: "protocol-mismatch",
          startedAt: "2026-08-06T12:00:00.000Z",
        }
      : {
          completedAt: "2026-08-06T12:00:05.000Z",
          outcome: "passed",
          startedAt: "2026-08-06T12:00:00.000Z",
        },
    schema: GATEWAY_NODE_COMPAT_SCHEMA,
  };
}

function evidenceFiles() {
  return new Map(
    DIRECTIONS.map((direction) => [
      `linux-x64-${direction}.json`,
      Buffer.from(canonicalizeGatewayNodeCompatEvidence(evidence(direction)), "utf8"),
    ]),
  );
}

function releaseRun(runAttempt = RUN_ATTEMPT, conclusion: "failure" | "success" = "success") {
  return {
    conclusion,
    event: "workflow_dispatch",
    head_branch: "main",
    head_repository: { full_name: REPOSITORY },
    head_sha: WORKFLOW_SHA,
    id: Number(RUN_ID),
    path: GATEWAY_NODE_COMPAT_RELEASE_CHECKS_WORKFLOW,
    repository: { full_name: REPOSITORY },
    run_attempt: runAttempt,
    status: "completed",
  };
}

function producerJob(runAttempt: number, id = 1000 + runAttempt) {
  return {
    conclusion: "success",
    head_sha: WORKFLOW_SHA,
    id,
    name: GATEWAY_NODE_COMPAT_PRODUCER_JOB,
    run_attempt: runAttempt,
    run_id: Number(RUN_ID),
    status: "completed",
  };
}

function artifact(runAttempt: number, id = 2000 + runAttempt) {
  return {
    digest: `sha256:${String(runAttempt).repeat(64)}`,
    expired: false,
    id,
    name: `openclaw-gateway-node-linux-compat-${RUN_ID}-${runAttempt}`,
    size_in_bytes: 48_000,
    workflow_run: {
      head_sha: WORKFLOW_SHA,
      id: Number(RUN_ID),
    },
  };
}

describe("Gateway/node compatibility release evidence", () => {
  it("validates the exact canonical six-row Linux/x64 evidence set", () => {
    const result = validateGatewayNodeCompatEvidenceSet(evidenceFiles(), {
      repository: REPOSITORY,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      targetSha: TARGET_SHA,
      workflowSha: WORKFLOW_SHA,
    });

    expect(result.baselineVersion).toBe(GATEWAY_NODE_COMPAT_BASELINE_VERSION);
    expect(result.targetSha).toBe(TARGET_SHA);
    expect(result.files).toHaveLength(6);
    expect(result.files.map((file) => [file.direction, file.outcome])).toEqual([
      ["baseline-gateway-baseline-node", "passed"],
      ["baseline-gateway-candidate-node", "passed"],
      ["baseline-gateway-disjoint-node", "protocol-mismatch"],
      ["candidate-gateway-baseline-node", "passed"],
      ["candidate-gateway-candidate-node", "passed"],
      ["candidate-gateway-disjoint-node", "protocol-mismatch"],
    ]);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: "linux-x64-candidate-gateway-candidate-node",
          gatewayAcceptedNodeMin: 3,
          gatewayProtocolVersion: 4,
          gatewayVersion: "2026.8.6",
          helloProtocol: 4,
          nodeVersion: "2026.8.6",
          protocolClientAdvertisedMax: 4,
          protocolClientAdvertisedMin: 3,
        }),
        expect.objectContaining({
          caseId: "linux-x64-baseline-gateway-disjoint-node",
          gatewayProtocolVersion: 3,
          helloProtocol: null,
          protocolClientAdvertisedMax: 2,
          protocolClientAdvertisedMin: 1,
        }),
      ]),
    );
    expect(result.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
  });

  it("rejects incomplete, noncanonical, or cross-target evidence sets", () => {
    const missing = evidenceFiles();
    missing.delete("linux-x64-candidate-gateway-candidate-node.json");
    expect(() =>
      validateGatewayNodeCompatEvidenceSet(missing, {
        repository: REPOSITORY,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        targetSha: TARGET_SHA,
        workflowSha: WORKFLOW_SHA,
      }),
    ).toThrow("exact six-row inventory");

    const noncanonical = evidenceFiles();
    const path = "linux-x64-candidate-gateway-candidate-node.json";
    noncanonical.set(path, Buffer.from(JSON.stringify(JSON.parse(String(noncanonical.get(path))))));
    expect(() =>
      validateGatewayNodeCompatEvidenceSet(noncanonical, {
        repository: REPOSITORY,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        targetSha: TARGET_SHA,
        workflowSha: WORKFLOW_SHA,
      }),
    ).toThrow("not canonical");

    const wrongTarget = evidenceFiles();
    expect(() =>
      validateGatewayNodeCompatEvidenceSet(wrongTarget, {
        repository: REPOSITORY,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        targetSha: "9".repeat(40),
        workflowSha: WORKFLOW_SHA,
      }),
    ).toThrow("candidate runtime source SHA");
  });

  it("selects the highest eligible successful producer attempt", () => {
    expect(
      selectGatewayNodeCompatArtifact({
        artifacts: [artifact(1), artifact(2)],
        jobs: [producerJob(1), { ...producerJob(2), conclusion: "failure" }, producerJob(3)],
        required: true,
        run: releaseRun(3),
      }),
    ).toMatchObject({ runAttempt: 1 });

    expect(() =>
      selectGatewayNodeCompatArtifact({
        artifacts: [artifact(2)],
        jobs: [producerJob(2), producerJob(2, 9999)],
        required: true,
        run: releaseRun(2),
      }),
    ).toThrow("producer job is not unique");

    expect(
      selectGatewayNodeCompatArtifact({
        artifacts: [],
        jobs: [],
        required: false,
        run: releaseRun(),
      }),
    ).toBeUndefined();
  });

  it("collects and binds the exact artifact, producer attempt, and six file hashes", async () => {
    const readArtifact = vi.fn(async () => ({ files: evidenceFiles() }));
    const result = await collectGatewayNodeCompatReleaseEvidence(
      {
        mode: "required",
        repository: REPOSITORY,
        runId: RUN_ID,
        targetSha: TARGET_SHA,
        workflowSha: WORKFLOW_SHA,
      },
      {
        getArtifacts: async () => [artifact(RUN_ATTEMPT)],
        getJobs: async () => [producerJob(RUN_ATTEMPT)],
        getRun: async () => releaseRun(),
        readArtifact,
      },
    );

    expect(readArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: 2003,
        producerJobName: GATEWAY_NODE_COMPAT_PRODUCER_JOB,
        runAttempt: RUN_ATTEMPT,
        runStatePolicy: "completed-producer-success",
        workflowPath: GATEWAY_NODE_COMPAT_RELEASE_CHECKS_WORKFLOW,
      }),
    );
    expect(result).toMatchObject({
      architecture: "x64",
      artifact: {
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        workflowSha: WORKFLOW_SHA,
      },
      baselineVersion: GATEWAY_NODE_COMPAT_BASELINE_VERSION,
      platform: "linux",
      schema: GATEWAY_NODE_COMPAT_RELEASE_SCHEMA,
      targetSha: TARGET_SHA,
    });
    if (!result) {
      throw new Error("expected required Gateway/node compatibility evidence");
    }
    expect(validateGatewayNodeCompatManifestEvidence(result)).toBe(result);
    const incompleteSummary = structuredClone(result);
    delete (incompleteSummary.files[0] as Partial<(typeof result.files)[number]>).gatewayVersion;
    expect(() => validateGatewayNodeCompatManifestEvidence(incompleteSummary)).toThrow(
      "invalid shape",
    );
    expect(renderGatewayNodeCompatSummary(result)).toContain(
      "| `candidate-gateway-disjoint-node` | `2026.8.6` | `2026.8.6` | `4` | `3` | `1-2` | `none` | `protocol-mismatch` |",
    );
  });

  it("preserves advisory evidence from a successful producer when the child run failed", async () => {
    const readArtifact = vi.fn(async () => ({ files: evidenceFiles() }));
    const result = await collectGatewayNodeCompatReleaseEvidence(
      {
        mode: "advisory",
        repository: REPOSITORY,
        runId: RUN_ID,
        targetSha: TARGET_SHA,
        workflowSha: WORKFLOW_SHA,
      },
      {
        getArtifacts: async () => [artifact(RUN_ATTEMPT)],
        getJobs: async () => [producerJob(RUN_ATTEMPT)],
        getRun: async () => releaseRun(RUN_ATTEMPT, "failure"),
        readArtifact,
      },
    );

    expect(result).toMatchObject({
      artifact: {
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        workflowSha: WORKFLOW_SHA,
      },
      targetSha: TARGET_SHA,
    });
    expect(readArtifact).toHaveBeenCalledOnce();
  });

  it("keeps a failed overall child run blocking in required mode", async () => {
    await expect(
      collectGatewayNodeCompatReleaseEvidence(
        {
          mode: "required",
          repository: REPOSITORY,
          runId: RUN_ID,
          targetSha: TARGET_SHA,
          workflowSha: WORKFLOW_SHA,
        },
        {
          getArtifacts: async () => [artifact(RUN_ATTEMPT)],
          getJobs: async () => [producerJob(RUN_ATTEMPT)],
          getRun: async () => releaseRun(RUN_ATTEMPT, "failure"),
          readArtifact: vi.fn(),
        },
      ),
    ).rejects.toThrow("immutable compatibility tuple");
  });

  it("warns and returns null when advisory evidence collection fails", async () => {
    const warnings: string[] = [];
    const result = await collectGatewayNodeCompatReleaseEvidence(
      {
        mode: "advisory",
        onWarning: (message) => warnings.push(message),
        repository: REPOSITORY,
        runId: RUN_ID,
        targetSha: TARGET_SHA,
        workflowSha: WORKFLOW_SHA,
      },
      {
        getArtifacts: async () => [artifact(RUN_ATTEMPT)],
        getJobs: async () => [{ ...producerJob(RUN_ATTEMPT), conclusion: "failure" }],
        getRun: async () => releaseRun(RUN_ATTEMPT, "failure"),
        readArtifact: vi.fn(),
      },
    );

    expect(result).toBeNull();
    expect(warnings).toEqual([
      "Gateway/node compatibility evidence has no eligible successful producer",
    ]);
  });

  it("warns and returns null when advisory evidence is malformed", async () => {
    const warnings: string[] = [];
    const files = evidenceFiles();
    files.set(
      "linux-x64-candidate-gateway-candidate-node.json",
      Buffer.from('{"malformed":true}\n'),
    );
    await expect(
      collectGatewayNodeCompatReleaseEvidence(
        {
          mode: "advisory",
          onWarning: (message) => warnings.push(message),
          repository: REPOSITORY,
          runId: RUN_ID,
          targetSha: TARGET_SHA,
          workflowSha: WORKFLOW_SHA,
        },
        {
          getArtifacts: async () => [artifact(RUN_ATTEMPT)],
          getJobs: async () => [producerJob(RUN_ATTEMPT)],
          getRun: async () => releaseRun(),
          readArtifact: async () => ({ files }),
        },
      ),
    ).resolves.toBeNull();
    expect(warnings[0]).toContain("malformed is not allowed");
  });

  it("keeps required evidence failures blocking", async () => {
    await expect(
      collectGatewayNodeCompatReleaseEvidence(
        {
          mode: "required",
          repository: REPOSITORY,
          runId: RUN_ID,
          targetSha: TARGET_SHA,
          workflowSha: WORKFLOW_SHA,
        },
        {
          getArtifacts: async () => [],
          getJobs: async () => [],
          getRun: async () => releaseRun(),
          readArtifact: vi.fn(),
        },
      ),
    ).rejects.toThrow("no eligible successful producer");
  });

  it("does not call GitHub when compatibility evidence is not selected", async () => {
    const getRun = vi.fn();
    await expect(
      collectGatewayNodeCompatReleaseEvidence(
        {
          mode: "not-selected",
          repository: REPOSITORY,
          runId: RUN_ID,
          targetSha: TARGET_SHA,
          workflowSha: WORKFLOW_SHA,
        },
        {
          getArtifacts: vi.fn(),
          getJobs: vi.fn(),
          getRun,
          readArtifact: vi.fn(),
        },
      ),
    ).resolves.toBeNull();
    expect(getRun).not.toHaveBeenCalled();
  });
});
