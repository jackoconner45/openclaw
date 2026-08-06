import { describe, expect, it } from "vitest";
import { requiresAnthropicMessageStop } from "./anthropic-stream-terminal.js";

describe("Anthropic stream terminal authority", () => {
  it.each([
    {
      provider: "anthropic",
      endpointClass: "anthropic-public",
      expected: true,
    },
    {
      provider: "provider-alias",
      endpointClass: "anthropic-public",
      expected: true,
    },
    {
      provider: " Anthropic ",
      endpointClass: "default",
      expected: true,
    },
    {
      provider: "provider-alias",
      endpointClass: "default",
      expected: false,
    },
    {
      provider: "anthropic",
      endpointClass: "custom",
      expected: false,
    },
    {
      provider: "provider-alias",
      endpointClass: "custom",
      expected: false,
    },
  ])(
    "returns $expected for $provider on $endpointClass",
    ({ provider, endpointClass, expected }) => {
      expect(requiresAnthropicMessageStop({ provider, endpointClass })).toBe(expected);
    },
  );
});
