import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RawData } from "ws";
import type {
  GatewayNodeCompatActionsArtifact,
  GatewayNodeCompatDirection,
  GatewayNodeCompatEvidence,
  GatewayNodeCompatOperation,
  GatewayNodeCompatRuntimeBinding,
} from "../../gateway-node-compat-evidence.mjs";
import { canonicalizeGatewayNodeCompatEvidence } from "../../gateway-node-compat-evidence.mjs";
import {
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
  type ArtifactBinding,
} from "../actions-artifact-archive.mjs";
import type { Cleanup, GatewayHandle, LaneState, ParsedArgs } from "./config.ts";
import { GATEWAY_NODE_COMPAT_BASELINE_VERSION } from "./config.ts";
import {
  binDirForPrefix,
  installTarballPackage,
  installedEntryPath,
  readInstalledMetadata,
} from "./install.ts";
import { resolveInstalledCliInvocation, runInstalledCli } from "./installed.ts";
import { readBoundedCrossOsResponseText } from "./network-smokes.ts";
import {
  canConnectToLoopbackPort,
  registerActiveChildProcessTree,
  runCleanup,
  runCommand,
  stopGateway,
  withAllocatedGatewayPort,
} from "./process.ts";
import { sleep } from "./shared.ts";

const SCHEMA = "openclaw.gateway-node-compat/v1";
const REUSABLE_WORKFLOW_PATH = ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
const TIMEOUT_MS = 2 * 60_000;
const API_JSON_LIMIT = 2 * 1024 * 1024;
const JOBS_PAGE_SIZE = 100;
const MAX_JOB_PAGES = 10;
const DISJOINT_MIN_PROTOCOL = 1;
const DISJOINT_MAX_PROTOCOL = 2;
const PROVEN_GATEWAY_ACCEPTED_NODE_MIN = 3;
const BIN = "node";

type RuntimeId = "baseline" | "candidate";
type Outcome = "passed" | "protocol-mismatch";
type CleanupOwner = (cleanup: Cleanup) => void;

type ArtifactSelection = Omit<GatewayNodeCompatActionsArtifact, "sizeBytes">;

export type GatewayNodeCompatCase = {
  caseId: string;
  direction: GatewayNodeCompatDirection;
  gateway: RuntimeId;
  node: RuntimeId;
  outcome: Outcome;
};

export type GatewayNodeCompatPackageSelection = ReturnType<typeof parsePackageSelection>;

type GatewayNodeCompatPackageInput = Omit<GatewayNodeCompatPackageSelection, "actionsArtifact"> & {
  actionsArtifact: GatewayNodeCompatActionsArtifact;
};

export type GatewayNodeCompatRunParams = ReturnType<typeof parseGatewayNodeCompatRunParams>;
type ActionsContext = GatewayNodeCompatRunParams["actions"];

type InstalledCompatRuntime = {
  prefixDir: string;
  packageRoot: string;
  cliPath: string;
  binding: GatewayNodeCompatRuntimeBinding;
};

type ProtocolObservation = { clientMin: number; clientMax: number; helloProtocol: number | null };

type ProtocolMismatch = {
  code: "PROTOCOL_MISMATCH";
  clientMinProtocol: number;
  clientMaxProtocol: number;
  expectedProtocol: number;
};

type CaseDraft = {
  compatCase: GatewayNodeCompatCase;
  gateway: GatewayNodeCompatRuntimeBinding;
  node: GatewayNodeCompatRuntimeBinding;
  observation: ProtocolObservation;
  operation?: GatewayNodeCompatOperation;
  mismatch?: ProtocolMismatch;
  startedAt: string;
  completedAt: string;
};
type CaseRunParams = {
  compatCase: GatewayNodeCompatCase;
  gateway: InstalledCompatRuntime;
  node: InstalledCompatRuntime;
  logsDir: string;
  own: CleanupOwner;
  token: string;
};

type PendingNodeRequest = { requestId?: unknown; nodeId?: unknown; displayName?: unknown };

export function buildGatewayNodeCompatCases(): GatewayNodeCompatCase[] {
  const cases = [
    ["candidate-gateway-candidate-node", "candidate", "candidate", "passed"],
    ["candidate-gateway-baseline-node", "candidate", "baseline", "passed"],
    ["baseline-gateway-candidate-node", "baseline", "candidate", "passed"],
    ["baseline-gateway-baseline-node", "baseline", "baseline", "passed"],
    ["candidate-gateway-disjoint-node", "candidate", "candidate", "protocol-mismatch"],
    ["baseline-gateway-disjoint-node", "baseline", "candidate", "protocol-mismatch"],
  ] as const;
  return cases.map(([direction, gateway, node, outcome]) => ({
    caseId: `linux-x64-${direction}`,
    direction,
    gateway,
    node,
    outcome,
  })) as GatewayNodeCompatCase[];
}

export function buildGatewayNodeCompatGatewayArgs(port: number) {
  return ["gateway", "run", "--bind", "loopback", "--port", String(port)].concat(
    "--force",
    "--allow-unconfigured",
  );
}

export function buildGatewayNodeCompatNodeArgs(port: number, caseId: string) {
  return ["node", "run", "--host", "127.0.0.1", "--port", String(port)].concat(
    "--node-id",
    caseId,
    "--display-name",
    caseId,
  );
}

export function buildGatewayNodeCompatInvokeArgs(params: { gatewayUrl: string; nodeId: string }) {
  return ["nodes", "invoke", "--node", params.nodeId, "--command", "system.which"].concat(
    "--params",
    JSON.stringify({ bins: [BIN] }),
    "--json",
    "--url",
    params.gatewayUrl,
  );
}

export function parseGatewayNodeCompatRunParams(args: ParsedArgs, env = process.env) {
  const repository = requireValue(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const runId = requirePattern(env.GITHUB_RUN_ID, "GITHUB_RUN_ID", /^[1-9][0-9]*$/u);
  const runAttempt = requirePositiveInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
  const workflowPath = parseGatewayNodeCompatWorkflowPath(
    requireValue(env.GITHUB_WORKFLOW_REF, "GITHUB_WORKFLOW_REF"),
    repository,
  );
  return {
    outputDir: resolveRequiredPath(args, "output-dir"),
    candidate: parsePackageSelection(args, "candidate", runId, runAttempt),
    baseline: parsePackageSelection(args, "compat-baseline", runId, runAttempt),
    producer: {
      repository,
      workflowSha: requirePattern(
        env.GATEWAY_NODE_COMPAT_WORKFLOW_SHA,
        "GATEWAY_NODE_COMPAT_WORKFLOW_SHA",
        /^[a-f0-9]{40}$/u,
      ),
      runId,
      runAttempt,
      job: requireValue(env.GITHUB_JOB, "GITHUB_JOB"),
    },
    actions: {
      apiUrl: requireValue(env.GITHUB_API_URL ?? "https://api.github.com", "GITHUB_API_URL"),
      token: requireValue(env.GITHUB_TOKEN, "GITHUB_TOKEN"),
      repository,
      headSha: requirePattern(env.GITHUB_SHA, "GITHUB_SHA", /^[a-f0-9]{40}$/u),
      headBranch: requireValue(env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME, "GitHub head branch"),
      event: requireValue(env.GITHUB_EVENT_NAME, "GITHUB_EVENT_NAME"),
      consumerRunAttempt: runAttempt,
      workflowPath,
    },
  };
}

function parseGatewayNodeCompatWorkflowPath(workflowRef: string, repository: string) {
  const prefix = `${repository}/`;
  const separator = workflowRef.lastIndexOf("@");
  if (
    !workflowRef.startsWith(prefix) ||
    separator <= prefix.length ||
    separator === workflowRef.length - 1
  ) {
    throw new Error("GITHUB_WORKFLOW_REF must identify the caller workflow and ref.");
  }
  const workflowPath = workflowRef.slice(prefix.length, separator);
  if (!/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9_.-]*\.ya?ml$/u.test(workflowPath)) {
    throw new Error("GITHUB_WORKFLOW_REF contains an invalid caller workflow path.");
  }
  return workflowPath;
}

function parsePackageSelection(
  args: ParsedArgs,
  prefix: "candidate" | "compat-baseline",
  currentRunId: string,
  consumerRunAttempt: number,
) {
  const runId = requirePattern(
    args[`${prefix}-artifact-run-id`],
    `${prefix}-artifact-run-id`,
    /^[1-9][0-9]*$/u,
  );
  const runAttempt = requirePositiveInteger(
    args[`${prefix}-artifact-run-attempt`],
    `${prefix}-artifact-run-attempt`,
  );
  if (runId !== currentRunId) {
    throw new Error(`${prefix} artifact must come from the current workflow run.`);
  }
  if (runAttempt > consumerRunAttempt) {
    throw new Error(`${prefix} artifact attempt must not be newer than the consumer attempt.`);
  }
  const digest = requirePattern(
    args[`${prefix}-artifact-digest`],
    `${prefix}-artifact-digest`,
    /^(?:sha256:)?[a-f0-9]{64}$/u,
  );
  return {
    tgzPath: resolveRequiredPath(args, `${prefix}-tgz`),
    version: requireValue(args[`${prefix}-version`], `${prefix}-version`),
    sourceSha: requirePattern(
      args[`${prefix}-source-sha`],
      `${prefix}-source-sha`,
      /^[a-f0-9]{40}$/u,
    ),
    sha256: requirePattern(args[`${prefix}-sha256`], `${prefix}-sha256`, /^[a-f0-9]{64}$/u),
    actionsArtifact: {
      id: requirePositiveInteger(args[`${prefix}-artifact-id`], `${prefix}-artifact-id`),
      name:
        prefix === "candidate"
          ? `openclaw-cross-os-release-checks-candidate-${runId}-${runAttempt}`
          : `openclaw-gateway-node-compat-baseline-${runId}-${runAttempt}`,
      digest: digest.startsWith("sha256:") ? (digest as `sha256:${string}`) : `sha256:${digest}`,
      runId,
      runAttempt,
    } satisfies ArtifactSelection,
  };
}

export function validateGatewayNodeCompatArtifactBinding(params: {
  selection: GatewayNodeCompatPackageSelection;
  actions: ActionsContext;
  artifactMetadata: unknown;
  workflowRun: unknown;
  workflowJobs: unknown;
}): GatewayNodeCompatPackageInput {
  const sizeBytes = asRecord(params.artifactMetadata).size_in_bytes;
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 1) {
    throw new Error("Actions artifact size_in_bytes must be a positive integer.");
  }
  const artifact = params.selection.actionsArtifact;
  const producerJobName = resolveGatewayNodeCompatProducerJobName({
    workflowPath: params.actions.workflowPath,
    workflowJobs: params.workflowJobs,
  });
  const expected: ArtifactBinding = {
    artifactDigest: artifact.digest,
    artifactId: artifact.id,
    artifactName: artifact.name,
    artifactSizeBytes: sizeBytes as number,
    repository: params.actions.repository,
    runStatePolicy: "same-run-producer-success",
    runAttempt: artifact.runAttempt,
    runId: Number(artifact.runId),
    workflowEvent: params.actions.event,
    workflowHeadBranch: params.actions.headBranch,
    workflowPath: params.actions.workflowPath,
    workflowSha: params.actions.headSha,
    consumerRunAttempt: params.actions.consumerRunAttempt,
    producerJobName,
  };
  validateActionsArtifactBinding({
    artifactMetadata: params.artifactMetadata,
    expected,
    workflowRun: params.workflowRun,
  });
  validateActionsArtifactProducerJob({ expected, workflowJobs: params.workflowJobs });
  return {
    ...params.selection,
    actionsArtifact: { ...artifact, sizeBytes: sizeBytes as number },
  };
}

function resolveGatewayNodeCompatProducerJobName(params: {
  workflowPath: string;
  workflowJobs: unknown;
}) {
  if (params.workflowPath === REUSABLE_WORKFLOW_PATH) {
    return "prepare";
  }
  const jobs = asRecord(params.workflowJobs).jobs;
  if (!Array.isArray(jobs)) {
    throw new Error("Actions workflow jobs inventory is incomplete.");
  }
  const matches = jobs
    .map((job) => asRecord(job).name)
    .filter((name): name is string => typeof name === "string" && /^.+ \/ prepare$/u.test(name));
  if (matches.length !== 1) {
    throw new Error("Called workflow prepare producer job must be unique.");
  }
  return matches[0];
}

export async function runGatewayNodeLinuxCompat(params: GatewayNodeCompatRunParams) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `Gateway/node compatibility producer requires Linux x64, got ${process.platform}/${process.arch}.`,
    );
  }
  if (params.baseline.version !== GATEWAY_NODE_COMPAT_BASELINE_VERSION) {
    throw new Error(
      `Gateway/node compatibility baseline must be ${GATEWAY_NODE_COMPAT_BASELINE_VERSION}.`,
    );
  }

  rmSync(params.outputDir, { recursive: true, force: true });
  mkdirSync(params.outputDir, { recursive: true });
  const tokens: string[] = [];
  await withGatewayNodeCompatCleanup(async (own) => {
    const workDir = createOwnedDirectory("gateway-node-compat", own);
    const logsDir = join(workDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const [candidateInput, baselineInput] = await validateGatewayNodeCompatPackageInputs(params);
    const candidate = await installCompatRuntime("candidate", candidateInput, logsDir, own);
    const baseline = await installCompatRuntime("baseline", baselineInput, logsDir, own);
    const runtimes = { candidate, baseline };
    const drafts: CaseDraft[] = [];

    for (const compatCase of buildGatewayNodeCompatCases()) {
      const token = randomBytes(32).toString("hex");
      tokens.push(token);
      drafts.push(
        await runCompatCase({
          compatCase,
          gateway: runtimes[compatCase.gateway],
          node: runtimes[compatCase.node],
          logsDir,
          own,
          token,
        }),
      );
    }

    for (const draft of drafts) {
      const gatewayAcceptedNodeMin = resolveGatewayNodeCompatAcceptedMin(
        drafts,
        draft.compatCase.gateway,
      );
      const evidence = buildGatewayNodeCompatEvidence({
        ...draft,
        gatewayAcceptedNodeMin,
        producer: params.producer,
      });
      writeFileSync(
        join(params.outputDir, `${evidence.caseId}.json`),
        canonicalizeGatewayNodeCompatEvidence(evidence),
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
    }
  });
  assertGatewayNodeCompatArtifactSafe(params.outputDir, tokens);
}

export async function validateGatewayNodeCompatPackageInputs(
  params: GatewayNodeCompatRunParams,
  fetchJson: (path: string, label: string) => Promise<unknown> = (path, label) =>
    fetchActionsJson(params.actions, path, label),
) {
  const selections = [params.candidate, params.baseline] as const;
  const metadata = await Promise.all(
    selections.map((selection, index) =>
      fetchJson(
        `actions/artifacts/${selection.actionsArtifact.id}`,
        `${index === 0 ? "candidate" : "baseline"} artifact metadata`,
      ),
    ),
  );
  const attempts = new Map(
    selections.map((selection) => [
      selection.actionsArtifact.runAttempt,
      selection.actionsArtifact,
    ]),
  );
  const provenance = new Map(
    await Promise.all(
      [...attempts].map(async ([runAttempt, artifact]) => {
        const runPath = `actions/runs/${artifact.runId}/attempts/${runAttempt}`;
        const [workflowRun, workflowJobs] = await Promise.all([
          fetchJson(runPath, "Actions workflow attempt"),
          fetchGatewayNodeCompatProducerJobs((page) =>
            fetchJson(
              `${runPath}/jobs?per_page=${JOBS_PAGE_SIZE}&page=${page}`,
              `Actions producer jobs page ${page}`,
            ),
          ),
        ]);
        return [runAttempt, { workflowRun, workflowJobs }] as const;
      }),
    ),
  );
  const validate = (selection: GatewayNodeCompatPackageSelection, artifactMetadata: unknown) => {
    const attempt = provenance.get(selection.actionsArtifact.runAttempt);
    if (!attempt) {
      throw new Error("Actions artifact producer attempt metadata is missing.");
    }
    return validateGatewayNodeCompatArtifactBinding({
      selection,
      actions: params.actions,
      artifactMetadata,
      ...attempt,
    });
  };
  return [validate(selections[0], metadata[0]), validate(selections[1], metadata[1])] as const;
}

export async function fetchGatewayNodeCompatProducerJobs(
  fetchPage: (page: number) => Promise<unknown>,
) {
  let totalCount: number | undefined;
  const jobs: unknown[] = [];
  const jobIds = new Set<number>();
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const response = asRecord(await fetchPage(page));
    const pageTotal = response.total_count;
    const pageJobs = response.jobs;
    if (
      !Number.isSafeInteger(pageTotal) ||
      (pageTotal as number) < 0 ||
      !Array.isArray(pageJobs) ||
      pageJobs.length > JOBS_PAGE_SIZE
    ) {
      throw new Error("Actions workflow jobs page is invalid.");
    }
    totalCount ??= pageTotal as number;
    if (pageTotal !== totalCount) {
      throw new Error("Actions workflow jobs total changed during pagination.");
    }
    for (const job of pageJobs) {
      const id = asRecord(job).id;
      if (!Number.isSafeInteger(id) || (id as number) < 1) {
        throw new Error("Actions workflow job id must be a positive integer.");
      }
      if (jobIds.has(id as number)) {
        throw new Error("Actions workflow jobs pagination contains a duplicate job.");
      }
      jobIds.add(id as number);
      jobs.push(job);
    }
    if (jobs.length === totalCount) {
      return { total_count: totalCount, jobs };
    }
    if (jobs.length > totalCount || pageJobs.length < JOBS_PAGE_SIZE) {
      throw new Error("Actions workflow jobs inventory is incomplete.");
    }
  }
  throw new Error("Actions workflow jobs inventory exceeded the pagination limit.");
}

export function resolveGatewayNodeCompatAcceptedMin(drafts: CaseDraft[], gateway: RuntimeId) {
  const successfulRange = drafts.find(
    (entry) =>
      entry.compatCase.gateway === gateway &&
      entry.compatCase.outcome === "passed" &&
      entry.observation.clientMin === PROVEN_GATEWAY_ACCEPTED_NODE_MIN &&
      entry.observation.clientMax === PROVEN_GATEWAY_ACCEPTED_NODE_MIN,
  );
  const rejectedRange = drafts.find(
    (entry) =>
      entry.compatCase.gateway === gateway &&
      entry.compatCase.outcome === "protocol-mismatch" &&
      entry.observation.clientMax === DISJOINT_MAX_PROTOCOL &&
      entry.mismatch?.code === "PROTOCOL_MISMATCH" &&
      entry.mismatch.clientMaxProtocol === DISJOINT_MAX_PROTOCOL,
  );
  if (!successfulRange || !rejectedRange) {
    throw new Error(
      `Gateway ${gateway} accepted-min proof requires a [${PROVEN_GATEWAY_ACCEPTED_NODE_MIN},${PROVEN_GATEWAY_ACCEPTED_NODE_MIN}] success and max-${DISJOINT_MAX_PROTOCOL} structured mismatch.`,
    );
  }
  return PROVEN_GATEWAY_ACCEPTED_NODE_MIN;
}

async function fetchActionsJson(actions: ActionsContext, path: string, label: string) {
  const response = await fetch(`${actions.apiUrl}/repos/${actions.repository}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${actions.token}`,
      "user-agent": "openclaw-gateway-node-compat",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  const body = await readBoundedCrossOsResponseText(response, API_JSON_LIMIT);
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} JSON must be an object.`);
  }
  return value;
}

async function installCompatRuntime(
  id: RuntimeId,
  input: GatewayNodeCompatPackageInput,
  logsDir: string,
  own: CleanupOwner,
): Promise<InstalledCompatRuntime> {
  if (sha256File(input.tgzPath) !== input.sha256) {
    throw new Error(`${id} package SHA-256 mismatch.`);
  }
  const lane = createCompatLane(`gateway-node-${id}-install`, own);
  const env = buildCompatEnv(lane, randomBytes(32).toString("hex"));
  await installTarballPackage({
    lane,
    env,
    tgzPath: input.tgzPath,
    logPath: join(logsDir, `install-${id}.log`),
  });
  const installed = readInstalledMetadata(lane.prefixDir);
  if (installed.version !== input.version || installed.commit !== input.sourceSha) {
    throw new Error(
      `${id} installed runtime identity mismatch: version=${installed.version || "<missing>"} commit=${installed.commit || "<missing>"}.`,
    );
  }
  const entryPath = installedEntryPath(lane.prefixDir);
  const packageRoot = dirname(entryPath);
  return {
    prefixDir: lane.prefixDir,
    packageRoot,
    cliPath: join(binDirForPrefix(lane.prefixDir), "openclaw"),
    binding: {
      packagedArtifact: {
        version: input.version,
        sourceSha: input.sourceSha,
        name: basename(input.tgzPath),
        sha256: input.sha256,
        actionsArtifact: input.actionsArtifact,
      },
      installedRuntime: {
        version: installed.version,
        sourceSha: installed.commit,
        identitySha256: sha256File(entryPath),
      },
    },
  };
}

async function runCompatCase(params: CaseRunParams): Promise<CaseDraft> {
  const startedAt = new Date().toISOString();
  return withObservedGateway(
    params,
    async ({ gatewayEnv, gatewayHome, gatewayUrl, proxy, proxyPort }) => {
      const base = {
        compatCase: params.compatCase,
        gateway: params.gateway.binding,
        node: params.node.binding,
        startedAt,
      };
      if (params.compatCase.outcome === "protocol-mismatch") {
        const clientLane = createCompatLane(`${params.compatCase.caseId}-client`, params.own);
        const mismatch = normalizeProtocolMismatch(
          await runDisjointPackagedClient({
            runtime: params.node,
            gatewayUrl: `ws://127.0.0.1:${proxyPort}`,
            cwd: clientLane.homeDir,
            env: buildCompatEnv(clientLane, params.token, params.node.prefixDir),
            logPath: join(params.logsDir, `${params.compatCase.caseId}-client.log`),
          }),
        );
        return {
          ...base,
          observation: validateGatewayNodeCompatObservation({
            outcome: "protocol-mismatch",
            observation: proxy.read(),
            mismatch,
          }),
          mismatch,
          completedAt: new Date().toISOString(),
        };
      }
      const nodeLane = createCompatLane(`${params.compatCase.caseId}-node`, params.own);
      const node = startCompatProcess({
        runtime: params.node,
        args: buildGatewayNodeCompatNodeArgs(proxyPort, params.compatCase.caseId),
        cwd: nodeLane.homeDir,
        env: buildCompatEnv(nodeLane, params.token, params.node.prefixDir),
        logPath: join(params.logsDir, `${params.compatCase.caseId}-node.log`),
        own: params.own,
      });
      const operation = await approveAndInvokeNode({
        runtime: params.gateway,
        gatewayUrl,
        expectedNodeId: params.compatCase.caseId,
        expectedDisplayName: params.compatCase.caseId,
        env: gatewayEnv,
        cwd: gatewayHome,
        logsDir: params.logsDir,
        child: node.child,
      });
      return {
        ...base,
        observation: validateGatewayNodeCompatObservation({
          outcome: "passed",
          observation: proxy.read(),
        }),
        operation,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    },
  );
}

async function withObservedGateway<T>(
  params: CaseRunParams,
  run: (context: {
    gatewayEnv: NodeJS.ProcessEnv;
    gatewayHome: string;
    gatewayUrl: string;
    proxy: Awaited<ReturnType<typeof startProtocolObserver>>;
    proxyPort: number;
  }) => Promise<T>,
) {
  const gatewayLane = createCompatLane(`${params.compatCase.caseId}-gateway`, params.own);
  const proxyLane = createCompatLane(`${params.compatCase.caseId}-proxy`, params.own);
  const gatewayEnv = buildCompatEnv(gatewayLane, params.token, params.gateway.prefixDir);
  return withAllocatedGatewayPort(gatewayLane, async () => {
    const gateway = startCompatProcess({
      runtime: params.gateway,
      args: buildGatewayNodeCompatGatewayArgs(gatewayLane.gatewayPort),
      cwd: gatewayLane.homeDir,
      env: gatewayEnv,
      logPath: join(params.logsDir, `${params.compatCase.caseId}-gateway.log`),
      own: params.own,
    });
    await waitForGatewayPort(gatewayLane.gatewayPort, gateway.child);
    return withAllocatedGatewayPort(proxyLane, async () => {
      const gatewayUrl = `ws://127.0.0.1:${gatewayLane.gatewayPort}`;
      const proxy = await startProtocolObserver({
        packageRoot: params.node.packageRoot,
        port: proxyLane.gatewayPort,
        upstreamUrl: gatewayUrl,
        own: params.own,
      });
      return run({
        gatewayEnv,
        gatewayHome: gatewayLane.homeDir,
        gatewayUrl,
        proxy,
        proxyPort: proxyLane.gatewayPort,
      });
    });
  });
}

export function validateGatewayNodeCompatObservation(params: {
  outcome: Outcome;
  observation: ProtocolObservation;
  mismatch?: ProtocolMismatch;
}): ProtocolObservation {
  const { clientMin, clientMax, helloProtocol } = params.observation;
  if (
    !Number.isSafeInteger(clientMin) ||
    clientMin < 1 ||
    !Number.isSafeInteger(clientMax) ||
    clientMax < clientMin
  ) {
    throw new Error("Observed node connect frame has an invalid protocol range.");
  }
  if (params.outcome === "passed") {
    if (!Number.isSafeInteger(helloProtocol) || helloProtocol === null || helloProtocol < 1) {
      throw new Error("Observed Gateway hello protocol must be a positive integer.");
    }
    return params.observation;
  }
  const mismatch = params.mismatch;
  if (
    helloProtocol !== null ||
    mismatch?.code !== "PROTOCOL_MISMATCH" ||
    mismatch.clientMinProtocol !== clientMin ||
    mismatch.clientMaxProtocol !== clientMax ||
    mismatch.expectedProtocol < 1
  ) {
    throw new Error("Observed Gateway protocol mismatch does not match the node connect frame.");
  }
  return params.observation;
}

export function buildGatewayNodeCompatEvidence(
  params: CaseDraft & {
    gatewayAcceptedNodeMin: number;
    producer: GatewayNodeCompatRunParams["producer"];
  },
): GatewayNodeCompatEvidence {
  const passed = params.compatCase.outcome === "passed";
  const gatewayProtocolVersion = passed
    ? params.observation.helloProtocol
    : params.mismatch?.expectedProtocol;
  if (!gatewayProtocolVersion) {
    throw new Error(`Missing observed Gateway protocol for ${params.compatCase.caseId}.`);
  }
  if (passed && !params.operation) {
    throw new Error(`Passed compatibility case ${params.compatCase.caseId} is incomplete.`);
  }
  const protocol = {
    gatewayProtocolVersion,
    gatewayAcceptedNodeMin: params.gatewayAcceptedNodeMin,
    protocolClientAdvertisedMin: params.observation.clientMin,
    protocolClientAdvertisedMax: params.observation.clientMax,
    helloProtocol: passed ? params.observation.helloProtocol : null,
  };
  return {
    schema: SCHEMA,
    caseId: params.compatCase.caseId,
    direction: params.compatCase.direction,
    connection: {
      transport: "gateway-websocket",
      role: "node",
      mode: "node",
    },
    gateway: params.gateway,
    node: {
      kind: "linux",
      architecture: "x64",
      protocolClientId: "node-host",
      ...params.node,
    },
    protocol,
    producer: {
      repository: params.producer.repository,
      workflowPath: REUSABLE_WORKFLOW_PATH,
      workflowSha: params.producer.workflowSha,
      runId: params.producer.runId,
      runAttempt: params.producer.runAttempt,
      job: params.producer.job,
    },
    operation: passed ? params.operation : null,
    result: passed
      ? { outcome: "passed", startedAt: params.startedAt, completedAt: params.completedAt }
      : {
          outcome: "protocol-mismatch",
          failureCode: "PROTOCOL_MISMATCH",
          failurePhase: "connect",
          startedAt: params.startedAt,
          completedAt: params.completedAt,
        },
  } as GatewayNodeCompatEvidence;
}

export function selectExpectedPendingNodeRequest(
  pending: PendingNodeRequest[],
  expectedNodeId: string,
  expectedDisplayName: string,
) {
  const matches = pending.filter(
    (request) => request.nodeId === expectedNodeId && request.displayName === expectedDisplayName,
  );
  if (matches.length > 1) {
    throw new Error(`Multiple pending requests matched node ${expectedNodeId}.`);
  }
  const requestId = matches[0]?.requestId;
  return typeof requestId === "string" && requestId ? requestId : null;
}

async function approveAndInvokeNode(params: {
  runtime: InstalledCompatRuntime;
  gatewayUrl: string;
  expectedNodeId: string;
  expectedDisplayName: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  logsDir: string;
  child: ChildProcess;
}) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertChildAlive(params.child, "node");
    const pending = await runCompatCliJson<PendingNodeRequest[]>({
      runtime: params.runtime,
      args: ["nodes", "pending", "--json", "--url", params.gatewayUrl],
      env: params.env,
      cwd: params.cwd,
      logPath: join(params.logsDir, `${params.expectedNodeId}-pending.log`),
      check: false,
    });
    const requestId = selectExpectedPendingNodeRequest(
      pending ?? [],
      params.expectedNodeId,
      params.expectedDisplayName,
    );
    if (requestId) {
      await runCompatCliJson({
        runtime: params.runtime,
        args: ["nodes", "approve", requestId, "--json", "--url", params.gatewayUrl],
        env: params.env,
        cwd: params.cwd,
        logPath: join(params.logsDir, `${params.expectedNodeId}-approve.log`),
      });
    }
    const result = await runCompatCliJson<{
      ok?: unknown;
      command?: unknown;
      payload?: unknown;
    }>({
      runtime: params.runtime,
      args: buildGatewayNodeCompatInvokeArgs({
        gatewayUrl: params.gatewayUrl,
        nodeId: params.expectedNodeId,
      }),
      env: params.env,
      cwd: params.cwd,
      logPath: join(params.logsDir, `${params.expectedNodeId}-invoke.log`),
      check: false,
    });
    const nodePath = asRecord(asRecord(result?.payload).bins)[BIN];
    if (result?.ok === true && result.command === "system.which" && typeof nodePath === "string") {
      return {
        method: "node.invoke",
        command: "system.which",
        params: { bins: [BIN] },
        ok: true,
        result: { bins: { [BIN]: nodePath } },
      } satisfies GatewayNodeCompatOperation;
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out invoking approved node ${params.expectedNodeId}.`);
}

async function runCompatCliJson<T>(params: {
  runtime: InstalledCompatRuntime;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  logPath: string;
  check?: boolean;
}): Promise<T | null> {
  const result = await runInstalledCli({
    cliPath: params.runtime.cliPath,
    args: params.args,
    env: params.env,
    cwd: params.cwd,
    logPath: params.logPath,
    timeoutMs: 30_000,
    check: params.check ?? true,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return null;
  }
  return JSON.parse(result.stdout) as T;
}

async function runDisjointPackagedClient(params: {
  runtime: InstalledCompatRuntime;
  gatewayUrl: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const runtimePath = join(params.runtime.packageRoot, "dist", "plugin-sdk", "gateway-runtime.js");
  const scriptPath = join(params.cwd, "gateway-node-disjoint-client.mjs");
  writeFileSync(
    scriptPath,
    buildDisjointPackagedClientScript({
      gatewayRuntimeUrl: pathToFileURL(runtimePath).href,
      gatewayUrl: params.gatewayUrl,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    const result = await runCommand(process.execPath, [scriptPath], {
      env: params.env,
      cwd: params.cwd,
      logPath: params.logPath,
      timeoutMs: 30_000,
    });
    return JSON.parse(result.stdout) as unknown;
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

export function buildDisjointPackagedClientScript(params: {
  gatewayRuntimeUrl: string;
  gatewayUrl: string;
}) {
  return `
const { GatewayClient } = await import(${JSON.stringify(params.gatewayRuntimeUrl)});
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
if (!token) throw new Error("missing OPENCLAW_GATEWAY_TOKEN");
const timeout = setTimeout(() => process.exit(1), 15000); let settled = false;
const client = new GatewayClient({
  url: ${JSON.stringify(params.gatewayUrl)}, token,
  clientName: "node-host", clientVersion: "gateway-node-compat-disjoint",
  platform: "linux", mode: "node", role: "node",
  scopes: [], caps: [], commands: ["system.which"],
  minProtocol: ${DISJOINT_MIN_PROTOCOL}, maxProtocol: ${DISJOINT_MAX_PROTOCOL},
  onConnectError: (error) => {
    if (settled) return;
    settled = true; clearTimeout(timeout); client.stop();
    process.stdout.write(JSON.stringify({ details: error?.details ?? null }));
  },
  onHelloOk: () => process.exit(1),
});
client.start();
`.trimStart();
}

function normalizeProtocolMismatch(value: unknown): ProtocolMismatch {
  const outer = asRecord(asRecord(value).details);
  const details = Object.hasOwn(outer, "code") ? outer : asRecord(outer.details);
  if (
    details.code !== "PROTOCOL_MISMATCH" ||
    !Number.isSafeInteger(details.clientMinProtocol) ||
    !Number.isSafeInteger(details.clientMaxProtocol) ||
    !Number.isSafeInteger(details.expectedProtocol)
  ) {
    throw new Error(`Packaged client did not return structured PROTOCOL_MISMATCH.`);
  }
  return {
    code: "PROTOCOL_MISMATCH",
    clientMinProtocol: details.clientMinProtocol as number,
    clientMaxProtocol: details.clientMaxProtocol as number,
    expectedProtocol: details.expectedProtocol as number,
  };
}

export async function startProtocolObserver(params: {
  packageRoot: string;
  port: number;
  upstreamUrl: string;
  own: CleanupOwner;
}) {
  const requireFromPackage = createRequire(join(params.packageRoot, "package.json"));
  requireFromPackage.resolve("ws");
  const { WebSocket, WebSocketServer } = requireFromPackage("ws") as typeof import("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: params.port });
  let range: { min: number; max: number } | undefined;
  let helloProtocol: number | null = null;
  let inconsistent = false;
  params.own(async () => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
  });
  server.on("connection", (downstream) => {
    const upstream = new WebSocket(params.upstreamUrl);
    const pending: Array<{ data: RawData; isBinary: boolean }> = [];
    let connectId = "";
    downstream.on("message", (data, isBinary) => {
      const frame = parseJsonFrame(data);
      if (frame.method === "connect" && typeof frame.id === "string") {
        const connect = asRecord(frame.params);
        if (
          Number.isSafeInteger(connect.minProtocol) &&
          Number.isSafeInteger(connect.maxProtocol)
        ) {
          const next = { min: connect.minProtocol as number, max: connect.maxProtocol as number };
          inconsistent ||= Boolean(range && (range.min !== next.min || range.max !== next.max));
          range = next;
          connectId = frame.id;
        }
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else {
        pending.push({ data, isBinary });
      }
    });
    upstream.on("open", () => {
      for (const message of pending.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      const frame = parseJsonFrame(data);
      if (frame.id === connectId) {
        const payload = asRecord(frame.payload);
        if (payload.type === "hello-ok" && Number.isSafeInteger(payload.protocol)) {
          const next = payload.protocol as number;
          inconsistent ||= helloProtocol !== null && helloProtocol !== next;
          helloProtocol = next;
        }
      }
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("close", (code, reason) => {
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.close(code, reason.toString());
      }
    });
    upstream.on("error", () => downstream.terminate());
    downstream.on("close", () => upstream.close());
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.on("listening", () => resolvePromise());
    server.on("error", rejectPromise);
  });
  return {
    read(): ProtocolObservation {
      if (!range || inconsistent) {
        throw new Error("Protocol observer did not capture one consistent node session.");
      }
      return { clientMin: range.min, clientMax: range.max, helloProtocol };
    },
  };
}

function parseJsonFrame(data: unknown) {
  try {
    const value: unknown = JSON.parse(
      Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data.map((part) => Buffer.from(part))).toString("utf8")
          : Buffer.from(data as Uint8Array).toString("utf8"),
    );
    return asRecord(value);
  } catch {
    return {};
  }
}

export function assertGatewayNodeCompatArtifactSafe(outputDir: string, tokens: string[]) {
  const expected = new Set(buildGatewayNodeCompatCases().map((entry) => `${entry.caseId}.json`));
  const files = readdirSync(outputDir, { recursive: true, encoding: "utf8" }).map(
    (relativePath) => ({ path: join(outputDir, relativePath), relativePath }),
  );
  if (
    files.length !== expected.size ||
    files.some(
      (file) =>
        lstatSync(file.path).isSymbolicLink() ||
        !lstatSync(file.path).isFile() ||
        !expected.delete(file.relativePath),
    ) ||
    expected.size !== 0
  ) {
    throw new Error("Gateway/node compatibility artifact contains unexpected files.");
  }
  // oxlint-disable-next-line unicorn/prefer-set-has -- Secret scanning requires byte-substring matching, not whole-buffer identity.
  const bytes = Buffer.concat(files.map((file) => readFileSync(file.path)));
  for (const token of tokens) {
    if (token && bytes.includes(Buffer.from(token))) {
      throw new Error("Gateway token leaked into compatibility artifact.");
    }
  }
}

export async function withGatewayNodeCompatCleanup<T>(
  run: (own: CleanupOwner) => Promise<T>,
): Promise<T> {
  const cleanup: Cleanup[] = [];
  const failures: unknown[] = [];
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = {
      ok: true,
      value: await run((entry) =>
        cleanup.push(async () => {
          try {
            await entry();
          } catch (error) {
            failures.push(error);
            throw error;
          }
        }),
      ),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  await runCleanup(cleanup);
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Gateway/node compatibility cleanup failed.");
  }
  return outcome.value;
}

function createOwnedDirectory(name: string, own: CleanupOwner) {
  const rootDir = mkdtempSync(join(tmpdir(), `openclaw-${name}-`));
  own(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function createCompatLane(name: string, own: CleanupOwner): LaneState {
  const rootDir = createOwnedDirectory(name, own);
  const prefixDir = join(rootDir, "prefix");
  const homeDir = join(rootDir, "home");
  const stateDir = join(homeDir, ".openclaw");
  mkdirSync(prefixDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return {
    name,
    rootDir,
    prefixDir,
    homeDir,
    stateDir,
    appDataDir: stateDir,
    gatewayPort: 0,
    phaseTimings: [],
  };
}

function buildCompatEnv(lane: LaneState, token: string, prefixDir = lane.prefixDir) {
  return {
    ...process.env,
    HOME: lane.homeDir,
    USERPROFILE: lane.homeDir,
    OPENCLAW_HOME: lane.homeDir,
    OPENCLAW_STATE_DIR: lane.stateDir,
    OPENCLAW_CONFIG_PATH: join(lane.stateDir, "openclaw.json"),
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1",
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_NO_PROMPT: "1",
    CI: "1",
    NPM_CONFIG_PREFIX: prefixDir,
    PATH: `${binDirForPrefix(prefixDir)}:${process.env.PATH ?? ""}`,
  };
}

function startCompatProcess(params: {
  runtime: InstalledCompatRuntime;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  own: CleanupOwner;
}): GatewayHandle {
  const invocation = resolveInstalledCliInvocation(params.runtime.cliPath, params.args, {
    env: params.env,
  });
  const log = createWriteStream(params.logPath, { flags: "a" });
  const child = spawn(invocation.command, invocation.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    shell: invocation.shell,
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const activeTree = registerActiveChildProcessTree(child);
  const handle: GatewayHandle = {
    child,
    logPath: params.logPath,
    closeLog: async () => {
      activeTree.unregister();
      await new Promise<void>((resolvePromise) => {
        log.end(resolvePromise);
      });
    },
  };
  params.own(() => stopGateway(handle));
  return handle;
}

async function waitForGatewayPort(port: number, child: ChildProcess) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertChildAlive(child, "gateway");
    if (await canConnectToLoopbackPort(port)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Gateway did not listen on port ${port}.`);
}

function assertChildAlive(child: ChildProcess, label: string) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${label} process exited before compatibility proof completed.`);
  }
}

function sha256File(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireValue(value: string | undefined, label: string) {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new Error(`Missing ${label}.`);
  }
  return normalized;
}

function requirePattern(value: string | undefined, label: string, pattern: RegExp) {
  const normalized = requireValue(value, label);
  if (!pattern.test(normalized)) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function requirePositiveInteger(value: string | undefined, label: string) {
  const normalized = requirePattern(value, label, /^[1-9][0-9]*$/u);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${label}.`);
  }
  return parsed;
}

function resolveRequiredPath(args: ParsedArgs, key: string) {
  return resolve(requireValue(args[key], key));
}
