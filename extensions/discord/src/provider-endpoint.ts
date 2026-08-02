// Discord plugin module owns private alternate-provider endpoint routing.
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  assertBundledPluginRuntimeCapability,
  createPluginRuntimeStore,
} from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import {
  fetchWithSsrFGuard,
  isLoopbackHost,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

export const DISCORD_DEFAULT_REST_API_BASE_URL = "https://discord.com/api/v10";

const DISCORD_PROVIDER_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
// Bundled bootstrap manifests must explicitly request this credential-routing authority.
const DISCORD_PROVIDER_ENDPOINT_RUNTIME_CAPABILITY = "discord.provider-endpoint";

export type DiscordProviderEndpointDescriptor = Readonly<{
  /** Complete versioned base URL for Discord REST routes. */
  restApiBaseUrl: string;
  /** Exact authenticated Gateway metadata URL. */
  gatewayBotUrl: string;
  /** Allowed WebSocket origin for initial and resumed Gateway connections. */
  gatewayOrigin: string;
}>;

type DiscordProviderEndpointRuntime = Readonly<{
  descriptor: DiscordProviderEndpointDescriptor;
  fetch: typeof fetch;
}>;

// Keep the mutable slot module-local. A named SDK runtime-store key is public process
// state and would let unrelated plugins replace the authorized value.
const {
  setRuntime: setProviderEndpointRuntime,
  clearRuntime: clearProviderEndpointRuntime,
  tryGetRuntime: getOptionalProviderEndpointRuntime,
} = createPluginRuntimeStore<DiscordProviderEndpointRuntime>(
  "Discord provider endpoint not initialized",
);
let activeProviderEndpointOwner: PluginRuntime | undefined;

function parseHttpAnchor(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${label} must not contain credentials or a fragment`);
  }
  return url;
}

function normalizeRestApiBaseUrl(value: string): URL {
  const url = parseHttpAnchor(value, "Discord provider REST API base URL");
  if (url.search) {
    throw new Error("Discord provider REST API base URL must not contain a query");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url;
}

function normalizeGatewayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Discord provider Gateway origin must be a valid URL");
  }
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopbackHost(url.hostname))) {
    throw new Error("Discord provider Gateway origin must use WSS or loopback WS");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("Discord provider Gateway origin must not contain credentials or a fragment");
  }
  if (url.pathname !== "/" || url.search) {
    throw new Error("Discord provider Gateway origin must not contain a path or query");
  }
  return url.origin;
}

function normalizeDescriptor(
  descriptor: DiscordProviderEndpointDescriptor,
): DiscordProviderEndpointDescriptor {
  const restApiBaseUrl = normalizeRestApiBaseUrl(descriptor.restApiBaseUrl);
  const gatewayBotUrl = parseHttpAnchor(
    descriptor.gatewayBotUrl,
    "Discord provider Gateway metadata URL",
  );
  return Object.freeze({
    restApiBaseUrl: restApiBaseUrl.toString().replace(/\/$/u, ""),
    gatewayBotUrl: gatewayBotUrl.toString(),
    gatewayOrigin: normalizeGatewayOrigin(descriptor.gatewayOrigin),
  });
}

function isWithinRestApiBase(target: URL, restApiBaseUrl: URL): boolean {
  if (target.origin !== restApiBaseUrl.origin) {
    return false;
  }
  const basePath = restApiBaseUrl.pathname.replace(/\/+$/u, "");
  return (
    basePath === "" || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)
  );
}

function assertProviderHttpTarget(
  target: URL,
  descriptor: DiscordProviderEndpointDescriptor,
): void {
  const restApiBaseUrl = new URL(descriptor.restApiBaseUrl);
  const gatewayBotUrl = new URL(descriptor.gatewayBotUrl);
  if (
    !isWithinRestApiBase(target, restApiBaseUrl) &&
    target.toString() !== gatewayBotUrl.toString()
  ) {
    throw new Error("Discord provider request is outside the configured endpoint boundaries");
  }
}

function requestInitFromRequest(request: Request): RequestInit {
  const duplex = (request as Request & { duplex?: "half" }).duplex;
  return {
    method: request.method,
    headers: request.headers,
    ...(request.body
      ? {
          body: request.body as BodyInit,
          ...(duplex ? { duplex } : {}),
        }
      : {}),
    signal: request.signal,
  };
}

function createProviderFetch(descriptor: DiscordProviderEndpointDescriptor): typeof fetch {
  const allowedOrigins = Array.from(
    new Set([new URL(descriptor.restApiBaseUrl).origin, new URL(descriptor.gatewayBotUrl).origin]),
  );
  return async (input, init) => {
    // Rebuild once so Request inputs and RequestInit overrides retain Fetch semantics.
    const request = new Request(input, init);
    const target = new URL(request.url);
    assertProviderHttpTarget(target, descriptor);
    const guarded = await fetchWithSsrFGuard({
      url: target.toString(),
      init: requestInitFromRequest(request),
      signal: request.signal,
      requireHttps: target.protocol === "https:",
      policy: { allowedOrigins },
      maxRedirects: 0,
      capture: false,
      auditContext: "discord.provider-endpoint",
    });
    try {
      const body = await readResponseWithLimit(
        guarded.response,
        DISCORD_PROVIDER_RESPONSE_MAX_BYTES,
        {
          onOverflow: ({ size, maxBytes }) =>
            new Error(
              `Discord provider response body too large: ${size} bytes (limit: ${maxBytes} bytes)`,
            ),
        },
      );
      return new Response(body.byteLength > 0 ? (body as unknown as BodyInit) : null, {
        status: guarded.response.status,
        statusText: guarded.response.statusText,
        headers: guarded.response.headers,
      });
    } finally {
      await guarded.release();
    }
  };
}

/** Install or clear the process-local private endpoint before Discord channel startup. */
export function setDiscordProviderEndpointDescriptor(
  runtime: PluginRuntime,
  descriptor: DiscordProviderEndpointDescriptor | undefined,
): void {
  assertBundledPluginRuntimeCapability(runtime, DISCORD_PROVIDER_ENDPOINT_RUNTIME_CAPABILITY);
  if (!descriptor) {
    // Registry replacement can leave an older authorized runtime alive. Its cleanup
    // must not clear a newer runtime's credential-routing descriptor.
    if (activeProviderEndpointOwner !== runtime) {
      return;
    }
    clearProviderEndpointRuntime();
    activeProviderEndpointOwner = undefined;
    return;
  }
  const normalized = normalizeDescriptor(descriptor);
  setProviderEndpointRuntime({
    descriptor: normalized,
    fetch: createProviderFetch(normalized),
  });
  activeProviderEndpointOwner = runtime;
}

export function getDiscordProviderEndpointRuntime(): DiscordProviderEndpointRuntime | undefined {
  return getOptionalProviderEndpointRuntime() ?? undefined;
}

export function resolveDiscordProviderAttachmentUploadGuard(uploadUrl: string):
  | Readonly<{
      maxRedirects: 0;
      policy: SsrFPolicy;
      requireHttps: boolean;
    }>
  | undefined {
  const runtime = getOptionalProviderEndpointRuntime();
  if (!runtime) {
    return undefined;
  }
  const target = parseHttpAnchor(uploadUrl, "Discord provider attachment upload URL");
  const restOrigin = new URL(runtime.descriptor.restApiBaseUrl).origin;
  if (target.origin !== restOrigin) {
    throw new Error("Discord provider attachment upload URL is outside the configured REST origin");
  }
  return {
    maxRedirects: 0,
    policy: { allowedOrigins: [restOrigin] },
    requireHttps: target.protocol === "https:",
  };
}

export function resolveDiscordProviderMediaDownloadGuard(mediaUrl: string):
  | Readonly<{
      maxRedirects: 0;
      policy: SsrFPolicy;
    }>
  | undefined {
  const runtime = getOptionalProviderEndpointRuntime();
  if (!runtime) {
    return undefined;
  }
  const target = parseHttpAnchor(mediaUrl, "Discord provider media URL");
  const restOrigin = new URL(runtime.descriptor.restApiBaseUrl).origin;
  if (target.origin !== restOrigin) {
    return undefined;
  }
  return {
    maxRedirects: 0,
    policy: {
      allowedOrigins: [restOrigin],
      hostnameAllowlist: [target.hostname],
    },
  };
}

export function assertDiscordProviderGatewayUrl(url: string, gatewayOrigin?: string): void {
  if (!gatewayOrigin) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Discord provider Gateway returned an invalid WebSocket URL");
  }
  if (parsed.origin !== gatewayOrigin || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Discord provider Gateway URL is outside the configured WebSocket origin");
  }
}
