import type { Model } from "@openclaw/llm-core";
import {
  createModelTransportEventScope,
  type ModelTransportEventScope,
  type ModelTransportOutcome,
  type PendingTransportEvent,
} from "./model-transport-accounting-internal.js";

const OPENAI_SDK_TRANSPORT = "responses-sdk";
const openAISdkTransportScopes = new WeakMap<object, OpenAISdkTransportScope>();

type OpenAISdkTransportScope = {
  events: ModelTransportEventScope;
  callerSignal?: AbortSignal;
  maxRetries: number;
  submissionReason: "initial" | "payload_recovery";
  phaseFetchInvocationCount: number;
  phaseSubmissionCount: number;
  phaseAwaitingSubmission: boolean;
  currentFetchDispatched: boolean;
  activeAttempt?: PendingTransportEvent;
  pendingResponseAttempt?: PendingTransportEvent;
  pendingResponseStatus?: number;
  zeroSubmissionObserved: boolean;
};

function shouldRetryResponse(response: Response): boolean {
  const shouldRetryHeader = response.headers.get("x-should-retry");
  if (shouldRetryHeader === "true") {
    return true;
  }
  if (shouldRetryHeader === "false") {
    return false;
  }
  return response.status === 408 || response.status === 409 || response.status === 429
    ? true
    : response.status >= 500;
}

export function createOpenAISdkAccountingFetch(params: {
  model: Model;
  callId?: string;
  scopeId: string;
  callerSignal?: AbortSignal;
  maxRetries?: number;
}): {
  onFetchDispatch: () => void;
  scope: OpenAISdkTransportScope;
  wrapGuardedFetch: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
} {
  const scope: OpenAISdkTransportScope = {
    events: createModelTransportEventScope(params),
    callerSignal: params.callerSignal,
    maxRetries: params.maxRetries ?? 2,
    submissionReason: "initial",
    phaseFetchInvocationCount: 0,
    phaseSubmissionCount: 0,
    phaseAwaitingSubmission: true,
    currentFetchDispatched: false,
    zeroSubmissionObserved: false,
  };
  return {
    scope,
    onFetchDispatch() {
      scope.phaseAwaitingSubmission = false;
      scope.currentFetchDispatched = true;
      const phaseAttemptIndex = scope.phaseSubmissionCount++;
      scope.activeAttempt = scope.events.startAttempt({
        transport: OPENAI_SDK_TRANSPORT,
        reason: phaseAttemptIndex === 0 ? scope.submissionReason : "retry",
      });
    },
    wrapGuardedFetch(fetch) {
      return async (input, init) => {
        scope.phaseFetchInvocationCount += 1;
        scope.phaseAwaitingSubmission = true;
        scope.currentFetchDispatched = false;
        try {
          const response = await fetch(input, init);
          const pending = scope.activeAttempt;
          scope.activeAttempt = undefined;
          if (pending) {
            if (response.ok) {
              scope.pendingResponseAttempt = pending;
              scope.pendingResponseStatus = response.status;
            } else {
              pending.finish("failed", response.status);
            }
          }
          scope.phaseAwaitingSubmission =
            !response.ok &&
            scope.phaseFetchInvocationCount <= scope.maxRetries &&
            shouldRetryResponse(response);
          scope.currentFetchDispatched = false;
          return response;
        } catch (error) {
          const fetchDispatched = scope.currentFetchDispatched;
          const outcome = scope.callerSignal?.aborted ? "aborted" : "failed";
          scope.activeAttempt?.finish(outcome);
          scope.activeAttempt = undefined;
          scope.pendingResponseAttempt?.finish(outcome, scope.pendingResponseStatus);
          scope.pendingResponseAttempt = undefined;
          scope.pendingResponseStatus = undefined;
          scope.phaseAwaitingSubmission =
            !fetchDispatched ||
            (!scope.callerSignal?.aborted && scope.phaseFetchInvocationCount <= scope.maxRetries);
          scope.currentFetchDispatched = false;
          throw error;
        }
      };
    },
  };
}

export function registerOpenAISdkTransportScope(
  client: object,
  scope: OpenAISdkTransportScope,
): void {
  openAISdkTransportScopes.set(client, scope);
}

export function markOpenAISdkPayloadRecovery(client: object): void {
  const scope = openAISdkTransportScopes.get(client);
  if (!scope) {
    return;
  }
  scope.submissionReason = "payload_recovery";
  scope.phaseFetchInvocationCount = 0;
  scope.phaseSubmissionCount = 0;
  scope.phaseAwaitingSubmission = true;
  scope.currentFetchDispatched = false;
}

export function finishOpenAISdkTransportScope(
  scope: OpenAISdkTransportScope,
  outcome: ModelTransportOutcome,
  statusCode?: number,
): void {
  const pending = scope?.pendingResponseAttempt;
  if (!pending) {
    return;
  }
  scope.pendingResponseAttempt = undefined;
  const responseStatus = scope.pendingResponseStatus;
  scope.pendingResponseStatus = undefined;
  pending.finish(outcome, statusCode ?? responseStatus);
}

export function failOpenAISdkTransportScope(
  scope: OpenAISdkTransportScope,
  outcome: ModelTransportOutcome,
): void {
  const pending = scope.pendingResponseAttempt;
  scope.pendingResponseAttempt = undefined;
  const responseStatus = scope.pendingResponseStatus;
  scope.pendingResponseStatus = undefined;
  if (pending) {
    pending.finish(outcome, responseStatus);
    return;
  }
  if (scope.phaseAwaitingSubmission && !scope.zeroSubmissionObserved) {
    scope.zeroSubmissionObserved = true;
    scope.events.observeZeroSubmission({
      transport: OPENAI_SDK_TRANSPORT,
      outcome: scope.callerSignal?.aborted || outcome === "aborted" ? "aborted" : "failed",
    });
  }
}
