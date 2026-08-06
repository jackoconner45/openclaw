import type { AiModelTransportOutcome } from "../host.js";
import {
  createModelTransportEventScope,
  type PendingTransportEvent,
} from "../transports/model-transport-accounting-internal.js";
import type { Model, StreamOptions } from "../types.js";
import {
  resolveAnthropicFallbackModelIdentity,
  type AnthropicFallbackBoundary,
} from "./anthropic-server-fallback.js";

const ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT = Symbol.for(
  "openclaw.anthropicTransportAccountingContext",
);
const ANTHROPIC_TRANSPORT = "sse";

type AnthropicTransportPhaseReason = "initial" | "payload_recovery";

type AnthropicFallbackTransition = {
  fromModel: string;
  toModel: string;
};

export type AnthropicFallbackResolution = {
  traceValid: boolean;
  transitions: AnthropicFallbackTransition[];
  productTransitions: AnthropicFallbackTransition[];
  servingModel?: string;
};

type AnthropicTransportAccountingState = {
  events: ReturnType<typeof createModelTransportEventScope>;
};

type AnthropicTransportAccountingContext = {
  state?: AnthropicTransportAccountingState;
  reason: AnthropicTransportPhaseReason;
};

type AnthropicTransportOptions = StreamOptions & {
  [ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT]?: AnthropicTransportAccountingContext;
};

type TerminalFallbackUsage =
  | { state: "invalid" }
  | { state: "valid"; declinedModels: string[]; servingModel?: string };

export type AnthropicTransportAccounting = {
  onFetchDispatch: () => void;
  wrapFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch;
  observeFallbackBoundary(boundary: AnthropicFallbackBoundary): void;
  observeTerminalUsage(usage: unknown): void;
  completeSuccess(): AnthropicFallbackResolution;
  fail(error: unknown): void;
};

function resolveTransportOutcome(
  _error: unknown,
  signal: AbortSignal | undefined,
): AiModelTransportOutcome {
  return signal?.aborted ? "aborted" : "failed";
}

function readTerminalFallbackUsage(usage: unknown): TerminalFallbackUsage {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return { state: "invalid" };
  }
  const iterations = (usage as { iterations?: unknown }).iterations;
  if (!Array.isArray(iterations) || iterations.length === 0) {
    return { state: "invalid" };
  }
  const declinedModels: string[] = [];
  let servingModel: string | undefined;
  let hasServingIdentity = false;
  for (const iteration of iterations) {
    if (!iteration || typeof iteration !== "object" || Array.isArray(iteration)) {
      return { state: "invalid" };
    }
    const record = iteration as { type?: unknown; model?: unknown };
    if (typeof record.type !== "string" || !record.type.trim()) {
      return { state: "invalid" };
    }
    switch (record.type) {
      case "message": {
        if (
          servingModel !== undefined ||
          typeof record.model !== "string" ||
          !record.model.trim()
        ) {
          return { state: "invalid" };
        }
        const previousModel = declinedModels.at(-1);
        if (
          !previousModel ||
          resolveAnthropicFallbackModelIdentity(previousModel) !==
            resolveAnthropicFallbackModelIdentity(record.model)
        ) {
          declinedModels.push(record.model);
        }
        hasServingIdentity = true;
        break;
      }
      case "fallback_message": {
        if (
          servingModel !== undefined ||
          typeof record.model !== "string" ||
          !record.model.trim()
        ) {
          return { state: "invalid" };
        }
        servingModel = record.model;
        hasServingIdentity = true;
        break;
      }
      case "advisor_message": {
        if (typeof record.model !== "string" || !record.model.trim()) {
          return { state: "invalid" };
        }
        break;
      }
      case "compaction":
        break;
      default:
        return { state: "invalid" };
    }
  }
  if (!hasServingIdentity) {
    return { state: "invalid" };
  }
  return {
    state: "valid",
    declinedModels,
    ...(servingModel ? { servingModel } : {}),
  };
}

function createAccountingState(params: {
  model: Model<"anthropic-messages">;
  callId?: string;
  scopeId: string;
}): AnthropicTransportAccountingState {
  return {
    events: createModelTransportEventScope({
      model: params.model,
      callId: params.callId,
      scopeId: params.scopeId,
      eventIdPrefix: "anthropic",
    }),
  };
}

function reconcileFallback(params: {
  requestedModel: string;
  boundaries: AnthropicFallbackBoundary[];
  terminalUsage: TerminalFallbackUsage | undefined;
}): AnthropicFallbackResolution {
  const validBoundaries = params.boundaries.filter(
    (boundary): boundary is { fromModel: string; toModel: string } =>
      Boolean(boundary.fromModel?.trim() && boundary.toModel?.trim()),
  );
  const productTransitions = validBoundaries.map((boundary) => ({
    fromModel: boundary.fromModel,
    toModel: boundary.toModel,
  }));
  if (params.terminalUsage?.state === "valid" && params.terminalUsage.servingModel) {
    const servingModel = params.terminalUsage.servingModel;
    const finalProductModel = productTransitions.at(-1)?.toModel;
    if (
      resolveAnthropicFallbackModelIdentity(finalProductModel ?? null) !==
      resolveAnthropicFallbackModelIdentity(servingModel)
    ) {
      productTransitions.push({
        fromModel: finalProductModel ?? params.requestedModel,
        toModel: servingModel,
      });
    }
  }

  if (
    params.terminalUsage?.state !== "valid" ||
    validBoundaries.length !== params.boundaries.length
  ) {
    return {
      traceValid: false,
      transitions: [],
      productTransitions,
      ...(params.terminalUsage?.state === "valid" && params.terminalUsage.servingModel
        ? { servingModel: params.terminalUsage.servingModel }
        : {}),
    };
  }

  const requestedIdentity = resolveAnthropicFallbackModelIdentity(params.requestedModel);
  if (!requestedIdentity) {
    return { traceValid: false, transitions: [], productTransitions };
  }
  const servingModel = params.terminalUsage.servingModel;
  if (!servingModel) {
    const directTraceValid =
      validBoundaries.length === 0 &&
      params.terminalUsage.declinedModels.every(
        (model) => resolveAnthropicFallbackModelIdentity(model) === requestedIdentity,
      );
    return directTraceValid
      ? { traceValid: true, transitions: [], productTransitions: [] }
      : { traceValid: false, transitions: [], productTransitions };
  }
  const servingIdentity = resolveAnthropicFallbackModelIdentity(servingModel);
  if (!servingIdentity || params.terminalUsage.declinedModels.length !== validBoundaries.length) {
    return {
      traceValid: false,
      transitions: [],
      productTransitions,
      servingModel,
    };
  }

  const transitions: AnthropicFallbackTransition[] = [];
  for (const [index, boundary] of validBoundaries.entries()) {
    const fromIdentity = resolveAnthropicFallbackModelIdentity(boundary.fromModel);
    const toIdentity = resolveAnthropicFallbackModelIdentity(boundary.toModel);
    const declinedIdentity = resolveAnthropicFallbackModelIdentity(
      params.terminalUsage.declinedModels[index] ?? null,
    );
    const nextIdentity =
      index + 1 < params.terminalUsage.declinedModels.length
        ? resolveAnthropicFallbackModelIdentity(
            params.terminalUsage.declinedModels[index + 1] ?? null,
          )
        : servingIdentity;
    if (
      !fromIdentity ||
      !toIdentity ||
      !declinedIdentity ||
      !nextIdentity ||
      fromIdentity !== declinedIdentity ||
      toIdentity !== nextIdentity ||
      fromIdentity === toIdentity ||
      (index === 0 && fromIdentity !== requestedIdentity)
    ) {
      return {
        traceValid: false,
        transitions: [],
        productTransitions,
        ...(params.terminalUsage.servingModel
          ? { servingModel: params.terminalUsage.servingModel }
          : {}),
      };
    }
    transitions.push({
      fromModel: index === 0 ? params.requestedModel : boundary.fromModel,
      toModel: boundary.toModel,
    });
  }

  if (validBoundaries.length === 0) {
    if (servingIdentity === requestedIdentity) {
      return {
        traceValid: false,
        transitions: [],
        productTransitions,
        servingModel,
      };
    }
    transitions.push({ fromModel: params.requestedModel, toModel: servingModel });
  }
  return {
    traceValid: true,
    transitions,
    productTransitions: transitions,
    servingModel,
  };
}

export function withAnthropicTransportAccountingPhase<T extends object | undefined>(
  options: T,
  reason: AnthropicTransportPhaseReason,
): T extends object ? T : Record<string, never> {
  const source = options as AnthropicTransportOptions | undefined;
  const context = source?.[ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT];
  return {
    ...options,
    [ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT]: {
      state: context?.state,
      reason,
    },
  } as T extends object ? T : Record<string, never>;
}

export function inheritAnthropicTransportAccountingContext<T extends object>(
  source: unknown,
  target: T,
): T {
  const context = (source as AnthropicTransportOptions | undefined)?.[
    ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT
  ];
  return context
    ? Object.assign(target, { [ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT]: context })
    : target;
}

export function createAnthropicTransportAccounting(params: {
  model: Model<"anthropic-messages">;
  options: StreamOptions | undefined;
  serverFallbackEnabled: boolean;
}): AnthropicTransportAccounting {
  const options = params.options as AnthropicTransportOptions | undefined;
  const context =
    options?.[ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT] ??
    ({ reason: "initial" } satisfies AnthropicTransportAccountingContext);
  const state =
    context.state ??
    createAccountingState({
      model: params.model,
      callId: options?.requestId,
      scopeId: options?.requestId ?? `${Date.now()}:${Math.random()}`,
    });
  context.state = state;

  let phaseSubmissionCount = 0;
  let phaseAwaitingSubmission = true;
  let zeroSubmissionObserved = false;
  let fallbackCoverageObserved = false;
  let activeAttempt: PendingTransportEvent | undefined;
  let pendingResponseAttempt: PendingTransportEvent | undefined;
  let pendingResponseStatus: number | undefined;
  let terminalUsage: TerminalFallbackUsage | undefined;
  const fallbackBoundaries: AnthropicFallbackBoundary[] = [];

  const settlePending = (outcome: AiModelTransportOutcome) => {
    activeAttempt?.finish(outcome);
    activeAttempt = undefined;
    pendingResponseAttempt?.finish(outcome, pendingResponseStatus);
    pendingResponseAttempt = undefined;
    pendingResponseStatus = undefined;
  };
  const takeActiveAttempt = (): PendingTransportEvent | undefined => {
    const attempt = activeAttempt;
    activeAttempt = undefined;
    return attempt;
  };
  const finishPendingResponse = (outcome: AiModelTransportOutcome): void => {
    pendingResponseAttempt?.finish(outcome, pendingResponseStatus);
    pendingResponseAttempt = undefined;
    pendingResponseStatus = undefined;
  };
  const observeFallbackCoverage = (): void => {
    if (fallbackCoverageObserved || !params.serverFallbackEnabled) {
      return;
    }
    fallbackCoverageObserved = true;
    state.events.observeCoverage({
      transport: ANTHROPIC_TRANSPORT,
      scope: "provider_fallbacks",
      state: "lower_bound",
      reason: "terminal_metadata_unavailable",
    });
  };

  return {
    onFetchDispatch: () => {
      phaseAwaitingSubmission = false;
      const phaseAttemptIndex = phaseSubmissionCount++;
      activeAttempt = state.events.startAttempt({
        transport: ANTHROPIC_TRANSPORT,
        reason: phaseAttemptIndex === 0 ? context.reason : "retry",
      });
    },
    wrapFetch(fetch) {
      return async (input, init) => {
        phaseAwaitingSubmission = true;
        activeAttempt = undefined;
        try {
          const response = await fetch(input, init);
          const attempt = takeActiveAttempt();
          if (attempt) {
            if (response.ok) {
              pendingResponseAttempt = attempt;
              pendingResponseStatus = response.status;
            } else {
              attempt.finish("failed", response.status);
            }
          }
          return response;
        } catch (error) {
          const attempt = takeActiveAttempt();
          if (attempt) {
            attempt.finish(resolveTransportOutcome(error, options?.signal));
            observeFallbackCoverage();
          }
          throw error;
        }
      };
    },
    observeFallbackBoundary(boundary) {
      fallbackBoundaries.push(boundary);
    },
    observeTerminalUsage(usage) {
      terminalUsage = readTerminalFallbackUsage(usage);
    },
    completeSuccess() {
      const resolution = params.serverFallbackEnabled
        ? reconcileFallback({
            requestedModel: params.model.id,
            boundaries: fallbackBoundaries,
            terminalUsage,
          })
        : {
            traceValid: true,
            transitions: [],
            productTransitions: [],
          };
      if (!resolution.traceValid) {
        finishPendingResponse("completed");
        observeFallbackCoverage();
        return resolution;
      }
      for (const transition of resolution.transitions) {
        state.events.observeProviderFallback({
          transport: ANTHROPIC_TRANSPORT,
          fromModel: transition.fromModel,
          toModel: transition.toModel,
        });
      }
      finishPendingResponse("completed");
      return resolution;
    },
    fail(error) {
      const hadUnsettledResponse = Boolean(activeAttempt || pendingResponseAttempt);
      settlePending(resolveTransportOutcome(error, options?.signal));
      if (hadUnsettledResponse) {
        observeFallbackCoverage();
      }
      if (phaseAwaitingSubmission && !zeroSubmissionObserved) {
        zeroSubmissionObserved = true;
        state.events.observeZeroSubmission({
          transport: ANTHROPIC_TRANSPORT,
          outcome: options?.signal?.aborted ? "aborted" : "failed",
        });
      }
    },
  };
}
