// Host-owned authorization facts for plugin runtime capabilities.
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRecord } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";

type PluginRuntimeAuthorization = Readonly<{
  pluginId: string;
  origin: PluginOrigin;
  privilegedRuntimeCapabilities: ReadonlySet<string>;
}>;

const authorizationByRuntime = new WeakMap<PluginRuntime, PluginRuntimeAuthorization>();

/** Records loader-owned provenance on the exact runtime object issued to a plugin. */
export function registerPluginRuntimeAuthorization(
  runtime: PluginRuntime,
  record: Pick<PluginRecord, "contracts" | "id" | "origin">,
): void {
  authorizationByRuntime.set(
    runtime,
    Object.freeze({
      pluginId: record.id,
      origin: record.origin,
      privilegedRuntimeCapabilities: new Set(record.contracts?.privilegedRuntimeCapabilities ?? []),
    }),
  );
}

/** Require a host-issued bundled runtime with one manifest-declared privileged capability. */
export function assertBundledPluginRuntimeCapability(
  runtime: PluginRuntime,
  capability: string,
): void {
  const authorization = authorizationByRuntime.get(runtime);
  if (!authorization) {
    throw new Error("Bundled plugin runtime required; the runtime was not issued by OpenClaw");
  }
  if (authorization.origin !== "bundled") {
    throw new Error(
      `Bundled plugin runtime required; plugin "${authorization.pluginId}" loaded with origin "${authorization.origin}"`,
    );
  }
  if (!authorization.privilegedRuntimeCapabilities.has(capability)) {
    throw new Error(
      `Plugin "${authorization.pluginId}" is not granted privileged runtime capability "${capability}"`,
    );
  }
}
