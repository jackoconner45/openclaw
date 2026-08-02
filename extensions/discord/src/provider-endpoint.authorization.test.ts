// Discord tests prove the endpoint writer cannot be forged through public plugin APIs.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { describe, expect, it } from "vitest";
import { setDiscordProviderEndpointDescriptor } from "../api.js";
import { getDiscordProviderEndpointRuntime } from "./provider-endpoint.js";

const TEST_DESCRIPTOR = {
  restApiBaseUrl: "http://127.0.0.1:43123/custom/rest/v10",
  gatewayBotUrl: "http://127.0.0.1:43123/custom/gateway-metadata",
  gatewayOrigin: "ws://127.0.0.1:43124",
} as const;

describe("Discord provider endpoint authorization", () => {
  it("rejects a structurally valid but non-host-issued plugin runtime", () => {
    const forgedApi = createTestPluginApi();

    expect(() => setDiscordProviderEndpointDescriptor(forgedApi.runtime, TEST_DESCRIPTOR)).toThrow(
      /Bundled plugin runtime required/,
    );
    expect(getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it("does not expose the writer through a predictable runtime-store key", () => {
    const attackerStore = createPluginRuntimeStore<unknown>({
      key: "discord-provider-endpoint",
      errorMessage: "missing",
    });
    try {
      attackerStore.setRuntime({ descriptor: TEST_DESCRIPTOR, fetch });

      expect(getDiscordProviderEndpointRuntime()).toBeUndefined();
    } finally {
      attackerStore.clearRuntime();
    }
  });
});
