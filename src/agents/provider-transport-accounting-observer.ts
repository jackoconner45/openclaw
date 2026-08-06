import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AiModelTransportEvent,
  AiModelTransportOutcome,
  CachedInputObservation,
} from "@openclaw/ai";
import type {
  ProviderTransportAccountingObserver,
  ProviderTransportLogicalCallStarted,
} from "./provider-transport-accounting.types.js";

const activeProviderTransportObserver =
  new AsyncLocalStorage<ProviderTransportAccountingObserver>();

export function runWithProviderTransportAccountingObserver<T>(
  observer: ProviderTransportAccountingObserver,
  run: () => T,
): T {
  return activeProviderTransportObserver.run(observer, run);
}

function withActiveProviderTransportObserver(
  visit: (observer: ProviderTransportAccountingObserver) => void,
): void {
  const observer = activeProviderTransportObserver.getStore();
  if (!observer) {
    return;
  }
  try {
    visit(observer);
  } catch {
    // Accounting is observational and must never change provider behavior.
  }
}

export function observeProviderTransportLogicalCallStarted(
  call: ProviderTransportLogicalCallStarted,
): void {
  withActiveProviderTransportObserver((observer) => observer.onLogicalCallStarted(call));
}

export function observeProviderTransportLogicalCallSettled(
  callId: string,
  outcome: AiModelTransportOutcome,
  cachedInput?: CachedInputObservation,
): void {
  withActiveProviderTransportObserver((observer) =>
    observer.onLogicalCallSettled(callId, outcome, cachedInput),
  );
}

export function observeProviderTransportEvent(event: AiModelTransportEvent): void {
  withActiveProviderTransportObserver((observer) => observer.onTransportEvent(event));
}
