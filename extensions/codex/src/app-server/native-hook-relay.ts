/**
 * Bridges Codex native hook callbacks into OpenClaw's native hook relay so
 * app-server tool events can still run OpenClaw policy and diagnostics.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  registerNativeHookRelay,
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParams,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  addTimerTimeoutGraceMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import type { JsonObject, JsonValue } from "./protocol.js";

/** Codex hook events that can be registered through OpenClaw's native relay. */
export const CODEX_NATIVE_HOOK_RELAY_EVENTS: readonly NativeHookRelayEvent[] = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS =
  CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
/** Extra relay lifetime after the expected turn budget, preventing late hook drops. */
export const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS = 250;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS = 1_000;
// The relay starts a niced Node subprocess, so busy hosts can exceed the former
// five-second relay timeout before policy and task-mirroring work completes.
const CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC = 10;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS = 10_000;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS = 5_000;

const CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID: Readonly<Record<string, readonly string[]>> = {
  exec: ["Bash", "exec", "exec_command"],
  apply_patch: ["apply_patch", "Write", "Edit"],
  spawn_agent: ["spawn_agent", "Agent"],
};

type CodexHookEventName = "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Stop";

export type CodexNativePreToolUseFailure = {
  toolName: string;
  toolCallId: string;
  disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">;
  durationMs: number;
};

export type CodexNativeHookRelayLease = NativeHookRelayRegistrationHandle & {
  acquireChild: (childThreadId: string) => () => void;
  releaseParent: (options?: { delay?: boolean }) => void;
};

type CodexNativeHookRelayParams = {
  options:
    | {
        enabled?: boolean;
        ttlMs?: number;
        gatewayTimeoutMs?: number;
        hookTimeoutSec?: number;
      }
    | undefined;
  generation?: string;
  generationMismatchGraceMs?: number;
  events: readonly NativeHookRelayEvent[];
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParams["config"];
  runId: string;
  channelId?: string;
  requester?: NonNullable<PluginHookToolContext["requester"]>;
  approvalContext?: Parameters<typeof registerNativeHookRelay>[0]["approvalContext"];
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
  loopDetectionPreToolUseRelay: boolean;
  signal: AbortSignal;
  onPreToolUseFailure: (failure: CodexNativePreToolUseFailure) => void | Promise<void>;
};

/** Defers relay unregister so late native hook subprocesses can still resolve. */
export function scheduleCodexNativeHookRelayUnregister(params: {
  relay: Pick<NativeHookRelayRegistrationHandle, "unregister">;
  hookTimeoutSec?: number;
  beforeUnregister?: () => void;
}): () => void {
  let pending: { timeout: ReturnType<typeof setTimeout>; unregister: () => void } | undefined;
  const unregister = () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (!nativeHookRelayUnregisterQueue.delete(current)) {
      return;
    }
    params.beforeUnregister?.();
    params.relay.unregister();
  };
  const timeout = setTimeout(
    unregister,
    resolveCodexNativeHookRelayUnregisterGraceMs(params.hookTimeoutSec),
  );
  pending = { timeout, unregister };
  nativeHookRelayUnregisterQueue.add(pending);
  timeout.unref();
  return () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (nativeHookRelayUnregisterQueue.delete(current)) {
      clearTimeout(current.timeout);
    }
  };
}

/** Computes the delayed unregister window from Codex's hook timeout. */
function resolveCodexNativeHookRelayUnregisterGraceMs(hookTimeoutSec: number | undefined): number {
  const hookTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 0;
  return Math.max(
    CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS,
    addTimerTimeoutGraceMs(hookTimeoutMs, CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS) ?? 0,
  );
}

/** Records a native pre-tool failure that Codex does not project as a tool item. */
export function emitCodexNativePreToolUseFailureDiagnostic(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  runId: string;
  signal?: AbortSignal;
  failure: CodexNativePreToolUseFailure;
  terminalReason?: CodexNativePreToolUseFailure["disposition"];
  sourceTimestampMs?: number;
}): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.error",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    runId: params.runId,
    toolName: params.failure.toolName,
    toolCallId: params.failure.toolCallId,
    durationMs: params.failure.durationMs,
    errorCategory: "before_tool_call",
    terminalReason:
      params.terminalReason ??
      (params.signal?.aborted
        ? resolveCodexToolAbortTerminalReason(params.signal)
        : params.failure.disposition),
    ...(params.sourceTimestampMs !== undefined
      ? { sourceTimestampMs: params.sourceTimestampMs }
      : {}),
  });
}

/** Registers an OpenClaw native hook relay for a Codex app-server turn. */
export function createCodexNativeHookRelay(
  params: CodexNativeHookRelayParams,
): CodexNativeHookRelayLease | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }
  const generation = params.generation?.trim() || randomUUID();
  const relayId = buildCodexNativeHookRelayId({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    generation,
    routeInstanceId: randomUUID(),
  });
  const route = new CodexNativeHookRelayRoute(
    { ...params, generation },
    relayId,
    params.generationMismatchGraceMs
      ? buildLegacyCodexNativeHookRelayId({
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        })
      : undefined,
  );
  codexNativeHookRelayOwners.set(relayId, route);
  return route.handle;
}

function registerCodexNativeHookRelay(
  params: CodexNativeHookRelayParams & { generation: string },
  relayId: string,
  options: {
    ttlMs: number;
    signal: AbortSignal;
    onPreToolUseFailure: CodexNativeHookRelayParams["onPreToolUseFailure"];
    generationMismatchGraceMs?: number;
  },
): NativeHookRelayRegistrationHandle {
  return registerNativeHookRelay({
    provider: "codex",
    relayId,
    generation: params.generation,
    ...(options.generationMismatchGraceMs
      ? { generationMismatchGraceMs: options.generationMismatchGraceMs }
      : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    runId: params.runId,
    ...(params.channelId ? { channelId: params.channelId } : {}),
    ...(params.requester ? { requester: params.requester } : {}),
    ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
    allowedEvents: params.events,
    preToolUseLoopDetection: params.loopDetectionPreToolUseRelay,
    ttlMs: options.ttlMs,
    signal: options.signal,
    onPreToolUseFailure: options.onPreToolUseFailure,
    command: {
      // Hook relay subprocesses are observational for most tool events; keep
      // them lower priority so they do not compete with the active reply turn.
      nice: 10,
      timeoutMs: params.options?.gatewayTimeoutMs,
    },
  });
}

class CodexNativeHookRelayRoute {
  readonly handle: CodexNativeHookRelayLease;

  private parentActive = true;
  private readonly childThreadIds = new Set<string>();
  private readonly relay: NativeHookRelayRegistrationHandle;
  private readonly legacyAlias: NativeHookRelayRegistrationHandle | undefined;
  private readonly ttlMs: number;
  private readonly hookTimeoutSec: number | undefined;
  private readonly lifetimeAbortController = new AbortController();
  private failureSink: CodexNativeHookRelayParams["onPreToolUseFailure"] | undefined;
  private renewalTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelPendingUnregister: (() => void) | undefined;
  private released = false;

  constructor(
    params: CodexNativeHookRelayParams & { generation: string },
    private readonly relayId: string,
    legacyRelayId: string | undefined,
  ) {
    this.ttlMs = resolveCodexNativeHookRelayTtlMs({
      explicitTtlMs: params.options?.ttlMs,
      attemptTimeoutMs: params.attemptTimeoutMs,
      startupTimeoutMs: params.startupTimeoutMs,
      turnStartTimeoutMs: params.turnStartTimeoutMs,
    });
    this.hookTimeoutSec = params.options?.hookTimeoutSec;
    this.failureSink = params.onPreToolUseFailure;

    const detachedFailureSink = (failure: CodexNativePreToolUseFailure) =>
      emitCodexNativePreToolUseFailureDiagnostic({
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        failure,
      });
    const reportFailure = (failure: CodexNativePreToolUseFailure) =>
      (this.failureSink ?? detachedFailureSink)(failure);
    this.relay = registerCodexNativeHookRelay(params, relayId, {
      ttlMs: this.ttlMs,
      signal: this.lifetimeAbortController.signal,
      onPreToolUseFailure: reportFailure,
    });
    this.legacyAlias = legacyRelayId
      ? registerCodexNativeHookRelay(params, legacyRelayId, {
          ttlMs: this.ttlMs,
          signal: this.lifetimeAbortController.signal,
          onPreToolUseFailure: reportFailure,
          generationMismatchGraceMs: params.generationMismatchGraceMs,
        })
      : undefined;

    this.handle = {
      ...this.relay,
      renew: (ttlMs?: number) => this.renew(ttlMs),
      unregister: () => this.releaseParent(),
      acquireChild: (childThreadId: string) => this.acquireChild(childThreadId),
      releaseParent: (options?: { delay?: boolean }) => this.releaseParent(options),
    };
  }

  private hasClaims(): boolean {
    return this.parentActive || this.childThreadIds.size > 0;
  }

  private renew(ttlMs?: number): void {
    if (this.released || !this.hasClaims()) {
      return;
    }
    this.relay.renew(ttlMs);
    this.handle.expiresAtMs = this.relay.expiresAtMs;
  }

  private acquireChild(childThreadIdInput: string): () => void {
    const childThreadId = childThreadIdInput.trim();
    if (!childThreadId || this.released || this.childThreadIds.has(childThreadId)) {
      return () => undefined;
    }
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.childThreadIds.add(childThreadId);
    this.scheduleRenewal();
    let acquired = true;
    return () => {
      if (!acquired) {
        return;
      }
      acquired = false;
      this.childThreadIds.delete(childThreadId);
      if (this.childThreadIds.size === 0) {
        this.clearRenewal();
        if (!this.parentActive) {
          this.requestFinalRelease(true);
        }
      }
    };
  }

  private releaseParent(options: { delay?: boolean } = {}): void {
    if (!this.parentActive || this.released) {
      return;
    }
    this.parentActive = false;
    // Descendants inherit the hook command, but not the parent's turn lifetime.
    // Drop attempt-local projection; reportFailure falls back to its route-scoped diagnostic.
    this.failureSink = undefined;
    if (this.childThreadIds.size === 0) {
      this.requestFinalRelease(options.delay === true);
    }
  }

  private requestFinalRelease(delay: boolean): void {
    if (this.released || this.hasClaims()) {
      return;
    }
    if (!delay) {
      this.releaseNow("codex_native_hook_relay_released");
      return;
    }
    if (this.cancelPendingUnregister) {
      return;
    }
    this.cancelPendingUnregister = scheduleCodexNativeHookRelayUnregister({
      relay: { unregister: () => this.unregisterRelays() },
      hookTimeoutSec: this.hookTimeoutSec,
      beforeUnregister: () => {
        this.cancelPendingUnregister = undefined;
        this.lifetimeAbortController.abort("codex_native_hook_relay_released");
        this.finalizeState();
      },
    });
  }

  private scheduleRenewal(): void {
    if (this.renewalTimer || this.released || this.childThreadIds.size === 0) {
      return;
    }
    const delayMs = Math.max(1, Math.min(5 * 60_000, Math.floor(this.ttlMs / 2)));
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = undefined;
      if (this.released || this.childThreadIds.size === 0) {
        return;
      }
      this.renew(this.ttlMs);
      this.scheduleRenewal();
    }, delayMs);
    this.renewalTimer.unref();
  }

  private clearRenewal(): void {
    if (!this.renewalTimer) {
      return;
    }
    clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
  }

  private unregisterRelays(): void {
    this.relay.unregister();
    this.legacyAlias?.unregister();
  }

  private releaseNow(reason: string): void {
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.lifetimeAbortController.abort(reason);
    this.unregisterRelays();
    this.finalizeState();
  }

  private finalizeState(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.parentActive = false;
    this.clearRenewal();
    this.failureSink = undefined;
    this.childThreadIds.clear();
    if (codexNativeHookRelayOwners.get(this.relayId) === this) {
      codexNativeHookRelayOwners.delete(this.relayId);
    }
  }

  snapshot() {
    return {
      parentActive: this.parentActive,
      childCount: this.childThreadIds.size,
      renewalScheduled: this.renewalTimer !== undefined,
      unregisterScheduled: this.cancelPendingUnregister !== undefined,
      released: this.released,
      hasLegacyAlias: this.legacyAlias !== undefined,
    };
  }

  dispose(): void {
    if (this.released) {
      return;
    }
    this.releaseNow("codex_native_hook_relay_disposed");
  }
}

const codexNativeHookRelayOwners = new Map<string, CodexNativeHookRelayRoute>();

export function clearCodexNativeHookRelayOwnersForTests(): void {
  for (const owner of codexNativeHookRelayOwners.values()) {
    owner.dispose();
  }
  codexNativeHookRelayOwners.clear();
}

export const codexNativeHookRelayLeaseTesting = {
  buildLegacyRelayId: buildLegacyCodexNativeHookRelayId,
  getRouteSnapshot: (relayId: string) => codexNativeHookRelayOwners.get(relayId)?.snapshot(),
  ownerCount: () => codexNativeHookRelayOwners.size,
};

/** Selects the native hook events Codex should install for the current approval mode. */
export function resolveCodexNativeHookRelayEvents(params: {
  configuredEvents?: readonly NativeHookRelayEvent[];
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy">;
}): readonly NativeHookRelayEvent[] {
  if (params.configuredEvents?.length) {
    return params.configuredEvents;
  }
  // Codex emits PermissionRequest before the app-server approval reviewer has
  // resolved the command. In native approval modes, let Codex's app-server
  // approval bridge own the real escalation instead of surfacing a stale
  // pre-guardian OpenClaw plugin approval prompt.
  return params.appServer.approvalPolicy === "never"
    ? CODEX_NATIVE_HOOK_RELAY_EVENTS
    : CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}

/** Derives the native hook relay TTL from the turn budget unless explicitly configured. */
export function resolveCodexNativeHookRelayTtlMs(params: {
  explicitTtlMs: number | undefined;
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
}): number {
  if (params.explicitTtlMs !== undefined) {
    return params.explicitTtlMs;
  }
  const relayBudgetMs =
    params.attemptTimeoutMs +
    params.startupTimeoutMs +
    params.turnStartTimeoutMs +
    CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
  return Math.max(CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}

/** Builds a stable relay id scoped to one inherited hook generation. */
function buildCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  generation: string;
  routeInstanceId: string;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v2");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  hash.update("\0");
  hash.update(params.generation);
  hash.update("\0");
  hash.update(params.routeInstanceId);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}

function buildLegacyCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v1");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}

const CODEX_HOOK_EVENT_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, CodexHookEventName> = {
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  permission_request: "PermissionRequest",
  before_agent_finalize: "Stop",
};

const CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, string> = {
  pre_tool_use: "pre_tool_use",
  post_tool_use: "post_tool_use",
  permission_request: "permission_request",
  before_agent_finalize: "stop",
};

const CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS = [
  "/<session-flags>/config.toml",
  "<session-flags>/config.toml",
] as const;

/** Builds the Codex config overlay that installs trusted command hooks for relay events. */
export function buildCodexNativeHookRelayConfig(params: {
  relay: NativeHookRelayRegistrationHandle;
  events?: readonly NativeHookRelayEvent[];
  hookTimeoutSec?: number;
  clearOmittedEvents?: boolean;
  loopDetectionPreToolUseRelay: boolean;
}): JsonObject {
  const events = params.events?.length ? params.events : CODEX_NATIVE_HOOK_RELAY_EVENTS;
  const selectedEvents = new Set<NativeHookRelayEvent>(events);
  const config: JsonObject = {
    "features.hooks": true,
  };
  const hookState: JsonObject = {};
  for (const event of CODEX_NATIVE_HOOK_RELAY_EVENTS) {
    const codexEvent = CODEX_HOOK_EVENT_BY_NATIVE_EVENT[event];
    const selected = selectedEvents.has(event);
    const shouldRelay = params.relay.shouldRelayEvent(event);
    // The no-policy marker is part of the shipped Codex fallback contract.
    // Only the Codex-owned loop relay opt-out may omit it.
    const selectedNoopPreToolUse =
      selected && event === "pre_tool_use" && !shouldRelay && params.loopDetectionPreToolUseRelay;
    if (!selected || (!shouldRelay && !selectedNoopPreToolUse)) {
      if (selected || params.clearOmittedEvents) {
        config[`hooks.${codexEvent}`] = [] satisfies JsonValue;
      }
      if (params.clearOmittedEvents) {
        for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
          hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] = {
            enabled: false,
          } satisfies JsonValue;
        }
      }
      continue;
    }
    const timeout = normalizeHookTimeoutSec(params.hookTimeoutSec);
    const command = params.relay.commandForEvent(event, {
      timeoutMs: resolveCodexNativeHookRelayCommandTimeoutMs(timeout),
    });
    const matcher = selectedNoopPreToolUse
      ? undefined
      : buildCodexNativeToolMatcher(params.relay.toolMatcherForEvent(event));
    config[`hooks.${codexEvent}`] = [
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: "command",
            command,
            timeout,
            async: false,
            statusMessage: "OpenClaw native hook relay",
          },
        ],
      },
    ] satisfies JsonValue;
    const state = {
      enabled: true,
      trusted_hash: codexCommandHookTrustedHash({
        event,
        command,
        matcher,
        timeout,
        statusMessage: "OpenClaw native hook relay",
      }),
    };
    for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
      hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] =
        state satisfies JsonValue;
    }
  }
  config["hooks.state"] = hookState;
  return config;
}

/** Builds a Codex config overlay that disables native hooks and clears hook arrays. */
export function buildCodexNativeHookRelayDisabledConfig(): JsonObject {
  return {
    "features.hooks": false,
    "hooks.PreToolUse": [],
    "hooks.PostToolUse": [],
    "hooks.PermissionRequest": [],
    "hooks.Stop": [],
  };
}

function normalizeHookTimeoutSec(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC;
}

function resolveCodexNativeHookRelayCommandTimeoutMs(hookTimeoutSec: number | undefined): number {
  const parentTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 5_000;
  const parentMarginMs = Math.min(
    CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS,
    Math.max(CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS, Math.floor(parentTimeoutMs / 5)),
  );
  return Math.max(1, parentTimeoutMs - parentMarginMs);
}

function buildCodexNativeToolMatcher(toolNames: readonly string[] | undefined): string | undefined {
  if (toolNames === undefined) {
    return undefined;
  }
  if (toolNames.length === 0) {
    throw new TypeError("Codex native hook matcher requires at least one tool name");
  }
  const nativeNames = new Set<string>();
  let hasCustomToolName = false;
  for (const toolName of toolNames) {
    const canonicalToolName = toolName.trim();
    if (!canonicalToolName || canonicalToolName === "*") {
      throw new TypeError("Codex native hook matcher requires canonical OpenClaw tool ids");
    }
    const nativeAliases = CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID[canonicalToolName];
    if (!nativeAliases) {
      hasCustomToolName = true;
    }
    for (const nativeName of nativeAliases ?? [canonicalToolName]) {
      nativeNames.add(nativeName);
    }
  }
  const sortedNames = Array.from(nativeNames).toSorted();
  if (!hasCustomToolName && sortedNames.every((toolName) => /^[A-Za-z0-9_]+$/.test(toolName))) {
    return sortedNames.join("|");
  }
  const escapedNames = sortedNames.map((toolName) =>
    toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `(?i)^(?:${escapedNames.join("|")})$`;
}

function codexCommandHookTrustedHash(params: {
  event: NativeHookRelayEvent;
  command: string;
  matcher?: string;
  timeout: number;
  statusMessage: string;
}): string {
  // Keep the match-all matcher omitted rather than null. Codex app-server
  // converts JSON null to an empty TOML string before hashing, which changes the
  // trust identity even though both forms match all tools.
  const identity = {
    event_name: CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[params.event],
    ...(params.matcher ? { matcher: params.matcher } : {}),
    hooks: [
      {
        async: false,
        command: params.command,
        statusMessage: params.statusMessage,
        timeout: params.timeout,
        type: "command",
      },
    ],
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(sortJsonValue(identity)))
    .digest("hex");
  return `sha256:${hash}`;
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  const sorted: JsonObject = {};
  for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    sorted[key] = sortJsonValue(entry);
  }
  return sorted;
}
