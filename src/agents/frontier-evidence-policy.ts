import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const FRONTIER_EVIDENCE_POLICY_VERSION = 1 as const;

export type FrontierEvidencePolicy = {
  version: typeof FRONTIER_EVIDENCE_POLICY_VERSION;
  policySha256: string;
  configSha256: string;
  defaultAgentId: string;
  provider: "openai";
  model: string;
  api: "openai-responses";
  baseUrl: "https://api.openai.com/v1";
  runtime: "openclaw";
  authBindingId: string;
  credentialState: "frozen_in_memory";
  credentialEnvName: "OPENAI_API_KEY";
  fallbacks: "disabled";
  proxy: "disabled";
  tls: "default";
  localService: "disabled";
  endpoint: {
    origin: "https://api.openai.com";
    pathname: "/v1/responses";
    method: "POST";
    transport: "responses-sdk";
  };
  thinking: "high";
  seed: "absent";
  authoredRequestParams: "absent";
  allowedRequestControls: string[];
};

type FrontierEvidenceScope = {
  policy: FrontierEvidencePolicy;
  expectedAuthProfileId: string;
};

const frontierEvidencePolicy = new AsyncLocalStorage<FrontierEvidenceScope>();

export function runWithFrontierEvidencePolicy<T>(
  policy: FrontierEvidencePolicy,
  expectedAuthProfileId: string,
  run: () => T,
): T {
  return frontierEvidencePolicy.run({ policy, expectedAuthProfileId }, run);
}

export function getFrontierEvidencePolicy(): FrontierEvidencePolicy | undefined {
  return frontierEvidencePolicy.getStore()?.policy;
}

export function getFrontierEvidenceExpectedAuthProfileId(): string | undefined {
  return frontierEvidencePolicy.getStore()?.expectedAuthProfileId;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function parseFrontierEvidencePolicy(value: unknown): Omit<FrontierEvidencePolicy, "policySha256"> {
  if (
    !isRecord(value) ||
    value.version !== FRONTIER_EVIDENCE_POLICY_VERSION ||
    !isSha256(value.configSha256) ||
    typeof value.defaultAgentId !== "string" ||
    !value.defaultAgentId.trim() ||
    value.provider !== "openai" ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.api !== "openai-responses" ||
    value.baseUrl !== "https://api.openai.com/v1" ||
    value.runtime !== "openclaw" ||
    typeof value.authBindingId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.authBindingId) ||
    value.credentialState !== "frozen_in_memory" ||
    value.credentialEnvName !== "OPENAI_API_KEY" ||
    value.fallbacks !== "disabled" ||
    value.proxy !== "disabled" ||
    value.tls !== "default" ||
    value.localService !== "disabled" ||
    !isRecord(value.endpoint) ||
    value.endpoint.origin !== "https://api.openai.com" ||
    value.endpoint.pathname !== "/v1/responses" ||
    value.endpoint.method !== "POST" ||
    value.endpoint.transport !== "responses-sdk" ||
    value.thinking !== "high" ||
    value.seed !== "absent" ||
    value.authoredRequestParams !== "absent" ||
    !Array.isArray(value.allowedRequestControls) ||
    value.allowedRequestControls.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("frontier evidence policy schema is invalid");
  }
  return {
    version: FRONTIER_EVIDENCE_POLICY_VERSION,
    configSha256: value.configSha256,
    defaultAgentId: value.defaultAgentId,
    provider: "openai",
    model: value.model,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    runtime: "openclaw",
    authBindingId: value.authBindingId,
    credentialState: "frozen_in_memory",
    credentialEnvName: "OPENAI_API_KEY",
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
    allowedRequestControls: [...new Set(value.allowedRequestControls)].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
}

export async function readFrontierEvidencePolicyFile(params: {
  path: string;
  expectedSha256: string;
}): Promise<FrontierEvidencePolicy> {
  if (!isSha256(params.expectedSha256)) {
    throw new Error("frontier evidence policy SHA-256 is invalid");
  }
  const stat = await fs.stat(params.path);
  if (!stat.isFile()) {
    throw new Error("frontier evidence policy must be a regular file");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error("frontier evidence policy permissions must be 0600");
  }
  const raw = await fs.readFile(params.path);
  const actualSha256 = createHash("sha256").update(raw).digest("hex");
  if (actualSha256 !== params.expectedSha256) {
    throw new Error("frontier evidence policy SHA-256 mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error("frontier evidence policy JSON is invalid", { cause: error });
  }
  return {
    ...parseFrontierEvidencePolicy(parsed),
    policySha256: actualSha256,
  };
}
