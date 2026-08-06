import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CONTRACT_PATH = "qa/contracts/gateway-node-platforms.json";
const PLATFORM_ORDER = ["macos", "ios", "watchos", "android", "wearos", "windows"] as const;
const ROW_KEYS = [
  "platform",
  "topology",
  "implementationOwners",
  "availableCoverage",
  "currentRunEvidence",
  "releaseSelection",
] as const;
const COVERAGE_TIER_ORDER = ["source", "unit", "simulator", "server-contract"] as const;
const COVERAGE_TIERS = new Set(COVERAGE_TIER_ORDER);
const MAX_STRING_LENGTH = 180;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  expect(Object.keys(value).toSorted(), `${label} keys`).toEqual([...expected].toSorted());
}

function assertBoundedString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error(`${label} must be a bounded trimmed string.`);
  }
}

function assertOwner(value: unknown, label: string): void {
  const owner = asRecord(value, label);
  assertExactKeys(owner, ["repository", "path"], label);
  assertBoundedString(owner.repository, `${label}.repository`);
  expect(["openclaw/openclaw", "openclaw/openclaw-windows-node"]).toContain(owner.repository);
  if (owner.repository === "openclaw/openclaw-windows-node") {
    expect(owner.path).toBeNull();
    return;
  }
  assertBoundedString(owner.path, `${label}.path`);
  expect(owner.path.startsWith("/")).toBe(false);
  expect(owner.path.includes("\\")).toBe(false);
  expect(owner.path.split("/")).not.toContain("");
  expect(owner.path.split("/")).not.toContain(".");
  expect(owner.path.split("/")).not.toContain("..");
  expect(() => execFileSync("git", ["cat-file", "-e", `HEAD:${owner.path}`])).not.toThrow();
}

function expectedTopology(platform: string): JsonRecord {
  if (platform === "watchos") {
    return {
      kind: "watch-http",
      gatewayNegotiator: "watchos",
      edges: [
        {
          from: "watchos",
          to: "gateway",
          transport: "bounded-https-challenge-connect-poll",
        },
      ],
    };
  }
  if (platform === "wearos") {
    return {
      kind: "wear-two-hop",
      gatewayNegotiator: "android-phone",
      edges: [
        {
          from: "wearos",
          to: "android-phone",
          transport: "wear-message-api-data-layer",
        },
        {
          from: "android-phone",
          to: "gateway",
          transport: "websocket",
        },
      ],
    };
  }
  return {
    kind: "direct-ws",
    gatewayNegotiator: platform,
    edges: [{ from: platform, to: "gateway", transport: "websocket" }],
  };
}

function validateInventory(value: unknown): JsonRecord {
  const inventory = asRecord(value, "platform coverage inventory");
  assertExactKeys(inventory, ["kind", "platforms"], "platform coverage inventory");
  expect(inventory.kind).toBe("openclaw.gateway-node-platform-coverage-inventory");
  expect(Array.isArray(inventory.platforms)).toBe(true);
  const platforms = inventory.platforms as unknown[];
  expect(platforms).toHaveLength(PLATFORM_ORDER.length);

  const seenPlatforms = new Set<string>();
  const seenCoverageNames = new Set<string>();
  platforms.forEach((rowValue, index) => {
    const row = asRecord(rowValue, `platforms[${index}]`);
    assertExactKeys(row, ROW_KEYS, `platforms[${index}]`);
    expect(row.platform).toBe(PLATFORM_ORDER[index]);
    assertBoundedString(row.platform, `platforms[${index}].platform`);
    expect(seenPlatforms.has(row.platform)).toBe(false);
    seenPlatforms.add(row.platform);

    const topology = asRecord(row.topology, `${row.platform}.topology`);
    assertExactKeys(topology, ["kind", "gatewayNegotiator", "edges"], `${row.platform}.topology`);
    expect(topology).toEqual(expectedTopology(row.platform));

    expect(Array.isArray(row.implementationOwners)).toBe(true);
    const owners = row.implementationOwners as unknown[];
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.length).toBeLessThanOrEqual(4);
    owners.forEach((owner, ownerIndex) =>
      assertOwner(owner, `${row.platform}.implementationOwners[${ownerIndex}]`),
    );

    expect(Array.isArray(row.availableCoverage)).toBe(true);
    const coverage = row.availableCoverage as unknown[];
    expect(coverage.length).toBeGreaterThan(0);
    expect(coverage.length).toBeLessThanOrEqual(8);
    let previousTier = -1;
    coverage.forEach((entryValue, coverageIndex) => {
      const entry = asRecord(entryValue, `${row.platform}.availableCoverage[${coverageIndex}]`);
      assertExactKeys(entry, ["name", "tier", "owner"], `${row.platform}.availableCoverage`);
      assertBoundedString(entry.name, `${row.platform}.availableCoverage.name`);
      expect(entry.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(seenCoverageNames.has(entry.name)).toBe(false);
      seenCoverageNames.add(entry.name);
      assertBoundedString(entry.tier, `${row.platform}.availableCoverage.tier`);
      expect(COVERAGE_TIERS.has(entry.tier as (typeof COVERAGE_TIER_ORDER)[number])).toBe(true);
      const tierIndex = COVERAGE_TIER_ORDER.indexOf(
        entry.tier as (typeof COVERAGE_TIER_ORDER)[number],
      );
      expect(tierIndex).toBeGreaterThanOrEqual(previousTier);
      previousTier = tierIndex;
      assertOwner(entry.owner, `${row.platform}.availableCoverage.owner`);
    });

    expect(row.currentRunEvidence).toEqual([]);
    const releaseSelection = asRecord(row.releaseSelection, `${row.platform}.releaseSelection`);
    assertExactKeys(
      releaseSelection,
      ["scope", "status", "reason"],
      `${row.platform}.releaseSelection`,
    );
    expect(releaseSelection).toEqual({
      scope: "full-release-validation",
      status: "not-selected",
      reason: "no-native-evidence-ingestion",
    });
  });

  const windows = asRecord(platforms[5], "windows");
  expect(windows.implementationOwners).toEqual([
    { repository: "openclaw/openclaw-windows-node", path: null },
  ]);
  return inventory;
}

function readInventory(): { raw: string; value: JsonRecord } {
  const raw = readFileSync(CONTRACT_PATH, "utf8");
  expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(64 * 1024);
  return { raw, value: JSON.parse(raw) as JsonRecord };
}

function cloneInventory(): JsonRecord {
  return structuredClone(readInventory().value);
}

describe("Gateway/node platform coverage inventory", () => {
  it("is canonical JSON with the exact six validated platform rows", () => {
    const { raw, value } = readInventory();
    expect(raw).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(validateInventory(value)).toBe(value);
  });

  it("encodes direct, watch HTTP, and Wear two-hop topology truth", () => {
    const { platforms } = validateInventory(readInventory().value);
    const rows = platforms as JsonRecord[];
    expect(rows.map((row) => ({ platform: row.platform, topology: row.topology }))).toEqual(
      PLATFORM_ORDER.map((platform) => ({ platform, topology: expectedTopology(platform) })),
    );
  });

  it("keeps available coverage separate from empty current-run evidence", () => {
    const { platforms } = validateInventory(readInventory().value);
    for (const row of platforms as JsonRecord[]) {
      expect((row.availableCoverage as unknown[]).length).toBeGreaterThan(0);
      expect(row.currentRunEvidence).toEqual([]);
    }
  });

  it.each([
    [
      "unknown inventory field",
      (value: JsonRecord) => {
        value.proof = true;
      },
    ],
    [
      "missing platform",
      (value: JsonRecord) => {
        (value.platforms as unknown[]).pop();
      },
    ],
    [
      "duplicate platform",
      (value: JsonRecord) => {
        const rows = value.platforms as JsonRecord[];
        rows[1] = structuredClone(rows[0]);
      },
    ],
    [
      "unknown row field",
      (value: JsonRecord) => {
        (value.platforms as JsonRecord[])[0].proofTier = "unit";
      },
    ],
    [
      "unbounded coverage name",
      (value: JsonRecord) => {
        const rows = value.platforms as JsonRecord[];
        const coverage = rows[0].availableCoverage as JsonRecord[];
        coverage[0].name = "x".repeat(MAX_STRING_LENGTH + 1);
      },
    ],
    [
      "current-run evidence claim",
      (value: JsonRecord) => {
        (value.platforms as JsonRecord[])[2].currentRunEvidence = ["simulator"];
      },
    ],
    [
      "selected release status",
      (value: JsonRecord) => {
        const selection = (value.platforms as JsonRecord[])[3].releaseSelection as JsonRecord;
        selection.status = "required";
      },
    ],
    [
      "core-owned Windows implementation",
      (value: JsonRecord) => {
        (value.platforms as JsonRecord[])[5].implementationOwners = [
          { repository: "openclaw/openclaw", path: "src/node-host/runner.ts" },
        ];
      },
    ],
    [
      "Wear negotiating directly with Gateway",
      (value: JsonRecord) => {
        const topology = (value.platforms as JsonRecord[])[4].topology as JsonRecord;
        topology.gatewayNegotiator = "wearos";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = cloneInventory();
    mutate(value);
    expect(() => validateInventory(value)).toThrow();
  });
});
