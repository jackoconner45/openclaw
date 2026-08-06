import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  canonicalizeGatewayNodeCompatEvidence,
  validateGatewayNodeCompatEvidence,
  type GatewayNodeCompatOperation,
} from "../../scripts/gateway-node-compat-evidence.mjs";
import { GATEWAY_NODE_COMPAT_BASELINE_SPEC } from "../../scripts/lib/cross-os-release-checks/config.ts";
import {
  assertGatewayNodeCompatArtifactSafe,
  buildDisjointPackagedClientScript,
  buildGatewayNodeCompatCases,
  buildGatewayNodeCompatEvidence,
  buildGatewayNodeCompatGatewayArgs,
  buildGatewayNodeCompatInvokeArgs,
  buildGatewayNodeCompatNodeArgs,
  fetchGatewayNodeCompatProducerJobs,
  parseGatewayNodeCompatRunParams,
  resolveGatewayNodeCompatAcceptedMin,
  selectExpectedPendingNodeRequest,
  startProtocolObserver,
  validateGatewayNodeCompatArtifactBinding,
  validateGatewayNodeCompatObservation,
  validateGatewayNodeCompatPackageInputs,
  withGatewayNodeCompatCleanup,
  type GatewayNodeCompatPackageSelection,
} from "../../scripts/lib/cross-os-release-checks/gateway-node-compat.ts";
import {
  binDirForPrefix,
  installTarballPackage,
  installedEntryPath,
  npmCommand,
  readInstalledMetadata,
} from "../../scripts/lib/cross-os-release-checks/install.ts";
import { resolveInstalledCliInvocation } from "../../scripts/lib/cross-os-release-checks/installed.ts";
import {
  canConnectToLoopbackPort,
  registerActiveChildProcessTree,
  runCommand,
  stopGateway,
} from "../../scripts/lib/cross-os-release-checks/process.ts";

const SOURCE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const ARTIFACT_SHA = "c".repeat(64);
const IDENTITY_SHA = "d".repeat(64);
const WORKFLOW_SHA = "e".repeat(40);
const STARTED_AT = "2026-08-06T12:00:00.000Z";
const COMPLETED_AT = "2026-08-06T12:00:01.000Z";

const producer = {
  repository: "openclaw/openclaw",
  workflowSha: WORKFLOW_SHA,
  runId: "789",
  runAttempt: 3,
  job: "gateway_node_linux_compat",
};

const actions = {
  apiUrl: "https://api.github.test",
  token: "github-token",
  repository: producer.repository,
  headSha: HEAD_SHA,
  headBranch: "main",
  event: "workflow_dispatch",
  consumerRunAttempt: 3,
  workflowPath: ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
};

function selection(name = "candidate-456-3"): GatewayNodeCompatPackageSelection {
  return {
    tgzPath: "/tmp/openclaw.tgz",
    version: "2026.8.6",
    sourceSha: SOURCE_SHA,
    sha256: ARTIFACT_SHA,
    actionsArtifact: {
      id: 123,
      name,
      digest: `sha256:${ARTIFACT_SHA}`,
      runId: "456",
      runAttempt: 3,
    },
  };
}

function artifactFixture(
  params: {
    jobName?: string;
    runAttempt?: number;
    workflowPath?: string;
  } = {},
) {
  const runAttempt = params.runAttempt ?? 3;
  return {
    artifactMetadata: {
      id: 123,
      name: "candidate-456-3",
      digest: `sha256:${ARTIFACT_SHA}`,
      expired: false,
      size_in_bytes: 1024,
      workflow_run: { id: 456, head_sha: HEAD_SHA },
    },
    workflowRun: {
      id: 456,
      run_attempt: runAttempt,
      head_sha: HEAD_SHA,
      head_branch: "main",
      event: "workflow_dispatch",
      path: params.workflowPath ?? actions.workflowPath,
      status: runAttempt === actions.consumerRunAttempt ? "in_progress" : "completed",
      conclusion: runAttempt === actions.consumerRunAttempt ? null : "failure",
      repository: { full_name: producer.repository },
      head_repository: { full_name: producer.repository },
    },
    workflowJobs: {
      total_count: 1,
      jobs: [
        {
          id: 900,
          name: params.jobName ?? "prepare",
          run_id: 456,
          run_attempt: runAttempt,
          head_sha: HEAD_SHA,
          status: "completed",
          conclusion: "success",
        },
      ],
    },
  };
}

function parseParams(
  params: {
    candidateAttempt?: string;
    baselineAttempt?: string;
    candidateRunId?: string;
    baselineRunId?: string;
    workflowRef?: string;
  } = {},
) {
  return parseGatewayNodeCompatRunParams(
    {
      "output-dir": "./output",
      "candidate-tgz": "./candidate.tgz",
      "candidate-version": "2026.8.6",
      "candidate-source-sha": SOURCE_SHA,
      "candidate-sha256": ARTIFACT_SHA,
      "candidate-artifact-id": "10",
      "candidate-artifact-digest": ARTIFACT_SHA,
      "candidate-artifact-run-id": params.candidateRunId ?? producer.runId,
      "candidate-artifact-run-attempt": params.candidateAttempt ?? "3",
      "compat-baseline-tgz": "./baseline.tgz",
      "compat-baseline-version": "2026.5.7",
      "compat-baseline-source-sha": SOURCE_SHA,
      "compat-baseline-sha256": ARTIFACT_SHA,
      "compat-baseline-artifact-id": "11",
      "compat-baseline-artifact-digest": `sha256:${ARTIFACT_SHA}`,
      "compat-baseline-artifact-run-id": params.baselineRunId ?? producer.runId,
      "compat-baseline-artifact-run-attempt": params.baselineAttempt ?? "3",
    },
    {
      GATEWAY_NODE_COMPAT_WORKFLOW_SHA: WORKFLOW_SHA,
      GITHUB_API_URL: actions.apiUrl,
      GITHUB_EVENT_NAME: actions.event,
      GITHUB_HEAD_REF: "",
      GITHUB_JOB: producer.job,
      GITHUB_REF_NAME: actions.headBranch,
      GITHUB_REPOSITORY: producer.repository,
      GITHUB_RUN_ATTEMPT: "3",
      GITHUB_RUN_ID: producer.runId,
      GITHUB_SHA: actions.headSha,
      GITHUB_TOKEN: actions.token,
      GITHUB_WORKFLOW_REF:
        params.workflowRef ?? `${producer.repository}/${actions.workflowPath}@refs/heads/main`,
    },
  );
}

function createActionsFetcher(params: ReturnType<typeof parseParams>, requests: string[]) {
  return async (path: string) => {
    requests.push(path);
    const artifactId = Number(path.match(/^actions\/artifacts\/(10|11)$/u)?.[1]);
    if (artifactId) {
      const artifactSelection = artifactId === 10 ? params.candidate : params.baseline;
      return {
        id: artifactId,
        name: artifactSelection.actionsArtifact.name,
        digest: artifactSelection.actionsArtifact.digest,
        expired: false,
        size_in_bytes: artifactId === 10 ? 1024 : 2048,
        workflow_run: { id: 789, head_sha: HEAD_SHA },
      };
    }
    const runAttempt = Number(path.match(/^actions\/runs\/789\/attempts\/([1-9][0-9]*)$/u)?.[1]);
    if (runAttempt) {
      return {
        id: 789,
        run_attempt: runAttempt,
        head_sha: HEAD_SHA,
        head_branch: "main",
        event: "workflow_dispatch",
        path: actions.workflowPath,
        status: runAttempt === actions.consumerRunAttempt ? "in_progress" : "completed",
        conclusion: runAttempt === actions.consumerRunAttempt ? null : "failure",
        repository: { full_name: producer.repository },
        head_repository: { full_name: producer.repository },
      };
    }
    const jobsAttempt = Number(
      path.match(/^actions\/runs\/789\/attempts\/([1-9][0-9]*)\/jobs\?per_page=100&page=1$/u)?.[1],
    );
    if (jobsAttempt) {
      return {
        total_count: 1,
        jobs: [
          {
            id: 900 + jobsAttempt,
            name: "prepare",
            run_id: 789,
            run_attempt: jobsAttempt,
            head_sha: HEAD_SHA,
            status: "completed",
            conclusion: "success",
          },
        ],
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };
}

function runtimeBinding(version: string) {
  return {
    packagedArtifact: {
      version,
      sourceSha: SOURCE_SHA,
      name: `openclaw-${version}.tgz`,
      sha256: ARTIFACT_SHA,
      actionsArtifact: {
        id: 123,
        name: "candidate-456-3",
        digest: `sha256:${ARTIFACT_SHA}` as const,
        sizeBytes: 1024,
        runId: "456",
        runAttempt: 3,
      },
    },
    installedRuntime: {
      version,
      sourceSha: SOURCE_SHA,
      identitySha256: IDENTITY_SHA,
    },
  };
}

describe("Gateway/node Linux compatibility producer", () => {
  it("defines four packaged default cases and disjoint proof for both Gateways", () => {
    const cases = buildGatewayNodeCompatCases();
    expect(cases.map(({ caseId, outcome }) => ({ caseId, outcome }))).toEqual([
      { caseId: "linux-x64-candidate-gateway-candidate-node", outcome: "passed" },
      { caseId: "linux-x64-candidate-gateway-baseline-node", outcome: "passed" },
      { caseId: "linux-x64-baseline-gateway-candidate-node", outcome: "passed" },
      { caseId: "linux-x64-baseline-gateway-baseline-node", outcome: "passed" },
      { caseId: "linux-x64-candidate-gateway-disjoint-node", outcome: "protocol-mismatch" },
      { caseId: "linux-x64-baseline-gateway-disjoint-node", outcome: "protocol-mismatch" },
    ]);
    expect(cases.filter((entry) => entry.outcome === "passed")).toHaveLength(4);
    expect(cases.filter((entry) => entry.outcome === "protocol-mismatch")).toHaveLength(2);
  });

  it("uses explicit unconfigured startup and keeps tokens out of every argv", () => {
    expect(buildGatewayNodeCompatGatewayArgs(18789)).toEqual([
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      "18789",
      "--force",
      "--allow-unconfigured",
    ]);
    const nodeArgs = buildGatewayNodeCompatNodeArgs(18789, "linux-case");
    const invokeArgs = buildGatewayNodeCompatInvokeArgs({
      gatewayUrl: "ws://127.0.0.1:18789",
      nodeId: "node-id",
    });
    expect(nodeArgs.join(" ")).not.toMatch(/protocol|token/iu);
    expect(invokeArgs).toContain("system.which");
    expect(invokeArgs.join(" ")).not.toMatch(/token/iu);
  });

  it("reads mismatch auth from env and overrides only the synthetic client", () => {
    const script = buildDisjointPackagedClientScript({
      gatewayRuntimeUrl: "file:///tmp/openclaw/dist/plugin-sdk/gateway-runtime.js",
      gatewayUrl: "ws://127.0.0.1:18789",
    });
    expect(script).toContain("process.env.OPENCLAW_GATEWAY_TOKEN");
    expect(script).toContain("minProtocol: 1");
    expect(script).toContain("maxProtocol: 2");
    expect(script).not.toContain("secret-token");
  });

  it("parses caller provenance and artifact producer attempts independently", () => {
    const params = parseParams({ candidateAttempt: "2" });
    expect(params.candidate.actionsArtifact).toEqual({
      id: 10,
      name: "openclaw-cross-os-release-checks-candidate-789-2",
      digest: `sha256:${ARTIFACT_SHA}`,
      runId: "789",
      runAttempt: 2,
    });
    expect(params.baseline.actionsArtifact.name).toBe(
      "openclaw-gateway-node-compat-baseline-789-3",
    );
    expect(params.producer.workflowSha).toBe(WORKFLOW_SHA);
    expect(params.actions.headSha).toBe(HEAD_SHA);
    expect(params.actions.workflowPath).toBe(actions.workflowPath);
    expect(() => parseParams({ candidateRunId: "788" })).toThrow(/current workflow run/u);
    expect(() => parseParams({ baselineAttempt: "4" })).toThrow(/newer than the consumer/u);
  });

  it("parses direct and called workflow refs without hardcoding a caller", () => {
    expect(parseParams().actions.workflowPath).toBe(actions.workflowPath);
    expect(
      parseParams({
        workflowRef: `${producer.repository}/.github/workflows/openclaw-release-checks.yml@refs/tags/v2026.8.6`,
      }).actions.workflowPath,
    ).toBe(".github/workflows/openclaw-release-checks.yml");
    expect(() =>
      parseParams({ workflowRef: `other/repo/${actions.workflowPath}@refs/heads/main` }),
    ).toThrow(/caller workflow/u);
  });

  it("validates direct and called prepare producers against exact run provenance", () => {
    const fixture = artifactFixture();
    expect(
      validateGatewayNodeCompatArtifactBinding({
        selection: selection(),
        actions,
        ...fixture,
      }),
    ).toMatchObject({ actionsArtifact: { sizeBytes: 1024 } });

    const calledWorkflowPath = ".github/workflows/openclaw-release-checks.yml";
    const calledFixture = artifactFixture({
      jobName: "cross_os_release_checks / prepare",
      workflowPath: calledWorkflowPath,
    });
    expect(
      validateGatewayNodeCompatArtifactBinding({
        selection: selection(),
        actions: { ...actions, workflowPath: calledWorkflowPath },
        ...calledFixture,
      }),
    ).toMatchObject({ actionsArtifact: { sizeBytes: 1024 } });

    calledFixture.workflowJobs.total_count = 2;
    calledFixture.workflowJobs.jobs.push({
      ...calledFixture.workflowJobs.jobs[0]!,
      id: 901,
      name: "other_call / prepare",
    });
    expect(() =>
      validateGatewayNodeCompatArtifactBinding({
        selection: selection(),
        actions: { ...actions, workflowPath: calledWorkflowPath },
        ...calledFixture,
      }),
    ).toThrow(/must be unique/u);

    const wrongSha = structuredClone(fixture);
    wrongSha.workflowRun.head_sha = "f".repeat(40);
    expect(() =>
      validateGatewayNodeCompatArtifactBinding({
        selection: selection(),
        actions,
        ...wrongSha,
      }),
    ).toThrow(/workflow run does not match/u);

    const failedJob = structuredClone(fixture);
    failedJob.workflowJobs.jobs[0]!.conclusion = "failure";
    expect(() =>
      validateGatewayNodeCompatArtifactBinding({
        selection: selection(),
        actions,
        ...failedJob,
      }),
    ).toThrow(/producer job did not complete successfully/u);
  });

  it("validates each producer attempt and deduplicates equal attempts", async () => {
    const distinct = parseParams({ candidateAttempt: "2", baselineAttempt: "3" });
    const distinctRequests: string[] = [];
    await expect(
      validateGatewayNodeCompatPackageInputs(
        distinct,
        createActionsFetcher(distinct, distinctRequests),
      ),
    ).resolves.toHaveLength(2);
    expect(distinctRequests.filter((path) => path.includes("/attempts/2"))).toHaveLength(2);
    expect(distinctRequests.filter((path) => path.includes("/attempts/3"))).toHaveLength(2);

    const shared = parseParams({ candidateAttempt: "2", baselineAttempt: "2" });
    const sharedRequests: string[] = [];
    const result = await validateGatewayNodeCompatPackageInputs(
      shared,
      createActionsFetcher(shared, sharedRequests),
    );
    expect(result.map((entry) => entry.actionsArtifact.runAttempt)).toEqual([2, 2]);
    expect(sharedRequests.filter((path) => path.includes("/attempts/2"))).toHaveLength(2);
  });

  it("combines all bounded job pages and rejects incomplete or duplicate inventories", async () => {
    const jobs = Array.from({ length: 150 }, (_, index) => ({ id: index + 1 }));
    await expect(
      fetchGatewayNodeCompatProducerJobs(async (page) => ({
        total_count: jobs.length,
        jobs: page === 1 ? jobs.slice(0, 100) : jobs.slice(100),
      })),
    ).resolves.toEqual({ total_count: 150, jobs });

    await expect(
      fetchGatewayNodeCompatProducerJobs(async (page) => ({
        total_count: 101,
        jobs: page === 1 ? jobs.slice(0, 100) : [],
      })),
    ).rejects.toThrow(/incomplete/u);

    await expect(
      fetchGatewayNodeCompatProducerJobs(async (page) => ({
        total_count: 101,
        jobs: page === 1 ? jobs.slice(0, 100) : [{ id: 100 }],
      })),
    ).rejects.toThrow(/duplicate/u);
  });

  it("accepts a positive Gateway hello outside the successful node range", () => {
    expect(
      validateGatewayNodeCompatObservation({
        outcome: "passed",
        observation: { clientMin: 3, clientMax: 4, helloProtocol: 4 },
      }),
    ).toEqual({ clientMin: 3, clientMax: 4, helloProtocol: 4 });
    expect(
      validateGatewayNodeCompatObservation({
        outcome: "passed",
        observation: { clientMin: 3, clientMax: 3, helloProtocol: 4 },
      }),
    ).toEqual({ clientMin: 3, clientMax: 3, helloProtocol: 4 });
    expect(() =>
      validateGatewayNodeCompatObservation({
        outcome: "passed",
        observation: { clientMin: 3, clientMax: 3, helloProtocol: 0 },
      }),
    ).toThrow(/positive integer/u);
    expect(() =>
      validateGatewayNodeCompatObservation({
        outcome: "protocol-mismatch",
        observation: { clientMin: 1, clientMax: 2, helloProtocol: null },
        mismatch: {
          code: "PROTOCOL_MISMATCH",
          clientMinProtocol: 2,
          clientMaxProtocol: 2,
          expectedProtocol: 4,
        },
      }),
    ).toThrow(/does not match/u);
  });

  it("proves accepted-min 3 only from a real min-3 success and max-2 mismatch", () => {
    const drafts = buildGatewayNodeCompatCases().map((compatCase) => ({
      compatCase,
      gateway: runtimeBinding(compatCase.gateway === "candidate" ? "2026.8.6" : "2026.5.7"),
      node: runtimeBinding(compatCase.node === "candidate" ? "2026.8.6" : "2026.5.7"),
      observation:
        compatCase.outcome === "passed"
          ? compatCase.node === "baseline"
            ? { clientMin: 3, clientMax: 3, helloProtocol: 4 }
            : { clientMin: 3, clientMax: 4, helloProtocol: 4 }
          : { clientMin: 1, clientMax: 2, helloProtocol: null },
      operation:
        compatCase.outcome === "passed"
          ? ({
              method: "node.invoke",
              command: "system.which",
              params: { bins: ["node"] },
              ok: true,
              result: { bins: { node: "/usr/bin/node" } },
            } satisfies GatewayNodeCompatOperation)
          : undefined,
      mismatch:
        compatCase.outcome === "protocol-mismatch"
          ? {
              code: "PROTOCOL_MISMATCH" as const,
              clientMinProtocol: 1,
              clientMaxProtocol: 2,
              expectedProtocol: 4,
            }
          : undefined,
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
    }));
    expect(
      drafts.find((draft) => draft.compatCase.direction === "candidate-gateway-baseline-node")
        ?.observation,
    ).toEqual({ clientMin: 3, clientMax: 3, helloProtocol: 4 });
    expect(resolveGatewayNodeCompatAcceptedMin(drafts, "candidate")).toBe(3);
    expect(resolveGatewayNodeCompatAcceptedMin(drafts, "baseline")).toBe(3);
    expect(() =>
      resolveGatewayNodeCompatAcceptedMin(
        drafts.filter((draft) => draft.compatCase.direction !== "baseline-gateway-disjoint-node"),
        "baseline",
      ),
    ).toThrow(/max-2 structured mismatch/u);
    const candidateWithoutExactFloor = structuredClone(drafts);
    for (const draft of candidateWithoutExactFloor) {
      if (draft.compatCase.gateway === "candidate" && draft.compatCase.outcome === "passed") {
        draft.observation = { clientMin: 3, clientMax: 4, helloProtocol: 4 };
      }
    }
    expect(() =>
      resolveGatewayNodeCompatAcceptedMin(candidateWithoutExactFloor, "candidate"),
    ).toThrow(/\[3,3\] success/u);
  });

  it("emits canonical observed success and structured mismatch evidence", () => {
    const compatCases = buildGatewayNodeCompatCases();
    const passedCase = compatCases[0];
    const mismatchCase = compatCases[4];
    if (!passedCase || !mismatchCase) {
      throw new Error("Expected compatibility cases.");
    }
    const common = {
      gateway: runtimeBinding("2026.8.6"),
      node: runtimeBinding("2026.8.6"),
      gatewayAcceptedNodeMin: 3,
      producer,
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
    };
    const passed = buildGatewayNodeCompatEvidence({
      ...common,
      compatCase: passedCase,
      observation: { clientMin: 3, clientMax: 4, helloProtocol: 4 },
      operation: {
        method: "node.invoke",
        command: "system.which",
        params: { bins: ["node"] },
        ok: true,
        result: { bins: { node: "/usr/bin/node" } },
      },
    });
    const mismatch = buildGatewayNodeCompatEvidence({
      ...common,
      compatCase: mismatchCase,
      observation: { clientMin: 1, clientMax: 2, helloProtocol: null },
      mismatch: {
        code: "PROTOCOL_MISMATCH",
        clientMinProtocol: 1,
        clientMaxProtocol: 2,
        expectedProtocol: 4,
      },
    });
    expect(validateGatewayNodeCompatEvidence(passed)).toEqual(passed);
    expect(validateGatewayNodeCompatEvidence(mismatch)).toEqual(mismatch);
    expect(canonicalizeGatewayNodeCompatEvidence(passed)).toContain(
      '"schema": "openclaw.gateway-node-compat/v1"',
    );
  });

  it("approves only the exact pending node id and display identity", () => {
    const pending = [
      { requestId: "wrong-id", nodeId: "other", displayName: "linux-case" },
      { requestId: "wrong-name", nodeId: "linux-case", displayName: "other" },
      { requestId: "match", nodeId: "linux-case", displayName: "linux-case" },
    ];
    expect(selectExpectedPendingNodeRequest(pending, "linux-case", "linux-case")).toBe("match");
    expect(selectExpectedPendingNodeRequest(pending, "missing", "missing")).toBeNull();
    expect(() =>
      selectExpectedPendingNodeRequest(
        [...pending, { requestId: "duplicate", nodeId: "linux-case", displayName: "linux-case" }],
        "linux-case",
        "linux-case",
      ),
    ).toThrow(/Multiple pending requests/u);
  });

  it("recursively rejects token leaks and unexpected uploaded files", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-node-artifact-"));
    try {
      for (const compatCase of buildGatewayNodeCompatCases()) {
        writeFileSync(join(root, `${compatCase.caseId}.json`), "{}\n");
      }
      expect(() => assertGatewayNodeCompatArtifactSafe(root, ["secret-token"])).not.toThrow();
      writeFileSync(join(root, `${buildGatewayNodeCompatCases()[0]!.caseId}.json`), "secret-token");
      expect(() => assertGatewayNodeCompatArtifactSafe(root, ["secret-token"])).toThrow(
        /Gateway token leaked/u,
      );
      mkdirSync(join(root, "logs"));
      writeFileSync(join(root, "logs", "gateway.log"), "not uploadable");
      expect(() => assertGatewayNodeCompatArtifactSafe(root, [])).toThrow(/unexpected files/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards frames through the observer, records protocol, and releases its port", async () => {
    const upstreamPort = await reservePort();
    const observerPort = await reservePort();
    await withGatewayNodeCompatCleanup(async (own) => {
      const upstream = new WebSocketServer({
        host: "127.0.0.1",
        port: upstreamPort,
        verifyClient: (_info, done) => setTimeout(() => done(true), 25),
      });
      own(() => closeWebSocketServer(upstream));
      await once(upstream, "listening");
      const upstreamFrame = new Promise<Record<string, unknown>>((resolvePromise) => {
        upstream.once("connection", (socket) => {
          socket.once("message", (data) => {
            const frame = JSON.parse(data.toString()) as Record<string, unknown>;
            resolvePromise(frame);
            socket.send(
              JSON.stringify({
                id: frame.id,
                payload: { type: "hello-ok", protocol: 4 },
              }),
            );
          });
        });
      });
      const observer = await startProtocolObserver({
        packageRoot: process.cwd(),
        port: observerPort,
        upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
        own,
      });
      const client = new WebSocket(`ws://127.0.0.1:${observerPort}`);
      client.on("error", () => {});
      await once(client, "open");
      client.send(
        JSON.stringify({
          id: "connect-1",
          method: "connect",
          params: { minProtocol: 3, maxProtocol: 4 },
        }),
      );
      const [response] = await once(client, "message");
      expect(JSON.parse(response.toString())).toMatchObject({
        id: "connect-1",
        payload: { type: "hello-ok", protocol: 4 },
      });
      await expect(upstreamFrame).resolves.toMatchObject({
        id: "connect-1",
        method: "connect",
      });
      expect(observer.read()).toEqual({ clientMin: 3, clientMax: 4, helloProtocol: 4 });
      client.close();
      await once(client, "close");
    });
    expect(await canConnectToLoopbackPort(observerPort)).toBe(false);
  }, 10_000);

  it("closes the downstream session when the observer cannot reach its upstream", async () => {
    const unavailablePort = await reservePort();
    const observerPort = await reservePort();
    await withGatewayNodeCompatCleanup(async (own) => {
      await startProtocolObserver({
        packageRoot: process.cwd(),
        port: observerPort,
        upstreamUrl: `ws://127.0.0.1:${unavailablePort}`,
        own,
      });
      const client = new WebSocket(`ws://127.0.0.1:${observerPort}`);
      client.on("error", () => {});
      await once(client, "open");
      await once(client, "close");
    });
    expect(await canConnectToLoopbackPort(observerPort)).toBe(false);
  }, 10_000);

  it.each(["install", "startup"])("cleans owned state after %s failure", async (phase) => {
    const root = mkdtempSync(join(tmpdir(), `gateway-node-${phase}-`));
    await expect(
      withGatewayNodeCompatCleanup(async (own) => {
        own(() => rmSync(root, { recursive: true, force: true }));
        throw new Error(`${phase} failed`);
      }),
    ).rejects.toThrow(`${phase} failed`);
    expect(existsSync(root)).toBe(false);
  });

  it("surfaces cleanup failure after a successful body", async () => {
    await expect(
      withGatewayNodeCompatCleanup(async (own) => {
        own(() => {
          throw new Error("cleanup failed");
        });
        return "ok";
      }),
    ).rejects.toThrow(/cleanup failed/u);
  });

  it("preserves the body failure when cleanup also fails", async () => {
    await expect(
      withGatewayNodeCompatCleanup(async (own) => {
        own(() => {
          throw new Error("cleanup failed");
        });
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
  });

  it.skipIf(process.env.OPENCLAW_GATEWAY_NODE_PUBLISHED_SMOKE !== "1")(
    "starts the real published v2026.5.7 Gateway with packaged module paths",
    async () => {
      await withGatewayNodeCompatCleanup(async (own) => {
        const root = mkdtempSync(join(tmpdir(), "gateway-node-published-"));
        own(() => rmSync(root, { recursive: true, force: true }));
        const prefixDir = join(root, "prefix");
        const homeDir = join(root, "home");
        const stateDir = join(homeDir, ".openclaw");
        mkdirSync(prefixDir, { recursive: true });
        mkdirSync(stateDir, { recursive: true });
        const lane = {
          name: "published-v3",
          rootDir: root,
          prefixDir,
          homeDir,
          stateDir,
          appDataDir: stateDir,
          gatewayPort: 0,
          phaseTimings: [],
        };
        const env = {
          ...process.env,
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
          OPENCLAW_GATEWAY_TOKEN: "published-smoke-token",
          OPENCLAW_DISABLE_BONJOUR: "1",
          NPM_CONFIG_PREFIX: prefixDir,
          PATH: `${binDirForPrefix(prefixDir)}:${process.env.PATH ?? ""}`,
        };
        const pack = await runCommand(
          npmCommand(),
          [
            "pack",
            "--ignore-scripts",
            "--json",
            GATEWAY_NODE_COMPAT_BASELINE_SPEC,
            "--pack-destination",
            root,
          ],
          { logPath: join(root, "pack.log"), timeoutMs: 5 * 60_000 },
        );
        const packed = JSON.parse(pack.stdout) as Array<{ filename?: unknown }>;
        const filename = packed[0]?.filename;
        expect(packed).toHaveLength(1);
        expect(typeof filename === "string" && basename(filename) === filename).toBe(true);
        await installTarballPackage({
          lane,
          env,
          tgzPath: join(root, filename as string),
          logPath: join(root, "install.log"),
        });
        expect(readInstalledMetadata(prefixDir).version).toBe("2026.5.7");
        const packageRoot = dirname(installedEntryPath(prefixDir));
        expect(existsSync(join(packageRoot, "dist", "plugin-sdk", "gateway-runtime.js"))).toBe(
          true,
        );
        expect(createRequire(join(packageRoot, "package.json")).resolve("ws")).toContain(
          "node_modules",
        );

        const port = await reservePort();
        const args = buildGatewayNodeCompatGatewayArgs(port);
        expect(args).toContain("--allow-unconfigured");
        const invocation = resolveInstalledCliInvocation(
          join(binDirForPrefix(prefixDir), "openclaw"),
          args,
          { env },
        );
        const logPath = join(root, "gateway.log");
        const logFd = openSync(logPath, "a");
        const child = spawn(invocation.command, invocation.args, {
          cwd: homeDir,
          env,
          detached: true,
          shell: invocation.shell,
          stdio: ["ignore", logFd, logFd],
        });
        const activeTree = registerActiveChildProcessTree(child);
        own(async () => {
          await stopGateway({
            child,
            logPath,
            closeLog: async () => {
              activeTree.unregister();
              closeSync(logFd);
            },
          });
        });
        const deadline = Date.now() + 30_000;
        while (!(await canConnectToLoopbackPort(port)) && Date.now() < deadline) {
          if (child.exitCode !== null) {
            throw new Error(readFileSync(logPath, "utf8"));
          }
          await new Promise((resolvePromise) => {
            setTimeout(resolvePromise, 250);
          });
        }
        expect(await canConnectToLoopbackPort(port)).toBe(true);
      });
    },
    6 * 60_000,
  );
});

async function reservePort() {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("Failed to reserve test port."));
        return;
      }
      server.close((error) => (error ? rejectPromise(error) : resolvePromise(address.port)));
    });
  });
}

async function closeWebSocketServer(server: WebSocketServer) {
  for (const client of server.clients) {
    client.terminate();
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}
