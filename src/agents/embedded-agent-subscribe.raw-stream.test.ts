/**
 * Tests for raw-stream write failure handling.
 * Verifies that both synchronous throws and async rejections are contained
 * without crashing the process.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock appendRegularFile before importing the module under test so we
// control whether it resolves, rejects, or throws synchronously.
const mockAppendRegularFile = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock("../infra/fs-safe.js", () => ({
  appendRegularFile: (...args: unknown[]) => mockAppendRegularFile(...args),
}));

// Reload the module with our mock in place.
const { appendRawStream } = await import(
  "./embedded-agent-subscribe.raw-stream.js"
);

describe("appendRawStream", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_RAW_STREAM", "true");
    tmpDir = path.join(
      os.tmpdir(),
      `openclaw-raw-stream-test-${randomUUID()}`,
    );
    vi.stubEnv("OPENCLAW_RAW_STREAM_PATH", path.join(tmpDir, "raw.jsonl"));
    mockAppendRegularFile.mockReset();
  });

  it("survives a rejected write without throwing", async () => {
    mockAppendRegularFile.mockRejectedValue(
      new Error("ENOSPC: no space left on device"),
    );
    expect(() => appendRawStream({ event: "test", ts: 1 })).not.toThrow();
    // Let the microtask queue flush so the rejection reaches the catch handler.
    await vi.waitFor(() => {
      expect(mockAppendRegularFile).toHaveBeenCalledTimes(1);
    });
  });

  it("survives a synchronous throw from the dependency", () => {
    mockAppendRegularFile.mockImplementation(() => {
      throw new Error("synchronous construction failure");
    });
    expect(() => appendRawStream({ event: "test", ts: 1 })).not.toThrow();
    expect(mockAppendRegularFile).toHaveBeenCalledTimes(1);
  });

  it("writes successfully in the normal case", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      mockAppendRegularFile.mockResolvedValue(undefined);
      expect(() => appendRawStream({ event: "test", ts: 1 })).not.toThrow();
      await vi.waitFor(() => {
        expect(mockAppendRegularFile).toHaveBeenCalledTimes(1);
      });
      expect(
        mockAppendRegularFile,
      ).toHaveBeenCalledWith({
        filePath: path.join(tmpDir, "raw.jsonl"),
        content: '{"event":"test","ts":1}\n',
        rejectSymlinkParents: true,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("is a no-op when OPENCLAW_RAW_STREAM is not set", () => {
    vi.stubEnv("OPENCLAW_RAW_STREAM", "");
    appendRawStream({ event: "test", ts: 1 });
    expect(mockAppendRegularFile).not.toHaveBeenCalled();
  });
});
