const ANTHROPIC_STREAM_INCOMPLETE_ERROR = "Anthropic stream ended before message_stop";

export function requiresAnthropicMessageStop(params: {
  provider: string;
  endpointClass: string;
}): boolean {
  if (params.endpointClass === "anthropic-public") {
    return true;
  }
  return params.endpointClass === "default" && params.provider.trim().toLowerCase() === "anthropic";
}

export function createAnthropicStreamTerminalCompleteness(params: { requireMessageStop: boolean }) {
  let sawMessageStop = false;
  let sawMappedStopReason = false;

  return {
    observeMessageStop(): void {
      sawMessageStop = true;
    },
    observeMappedStopReason(reason: string): void {
      if (reason.trim().length > 0) {
        sawMappedStopReason = true;
      }
    },
    assertComplete(): void {
      if (sawMessageStop || (!params.requireMessageStop && sawMappedStopReason)) {
        return;
      }
      throw new Error(ANTHROPIC_STREAM_INCOMPLETE_ERROR);
    },
  };
}
