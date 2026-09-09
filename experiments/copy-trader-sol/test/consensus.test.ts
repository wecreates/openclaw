import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetConsensusForTest, registerBuyIntent } from "../src/consensus.js";

const CONFIG = await import("../src/config.js");

describe("consensus.registerBuyIntent", () => {
  beforeEach(() => _resetConsensusForTest());

  it("clears with a single leader when threshold is 1", () => {
    (CONFIG.config as any).consensusMinLeaders = 1;
    (CONFIG.config as any).consensusWindowSec = 90;
    const r = registerBuyIntent("MintA", "LeaderA");
    expect(r.cleared).toBe(true);
  });

  it("requires two distinct leaders when threshold is 2", () => {
    (CONFIG.config as any).consensusMinLeaders = 2;
    (CONFIG.config as any).consensusWindowSec = 90;
    expect(registerBuyIntent("MintB", "LeaderA").cleared).toBe(false);
    expect(registerBuyIntent("MintB", "LeaderB").cleared).toBe(true);
  });

  it("does not double-count the same leader", () => {
    (CONFIG.config as any).consensusMinLeaders = 2;
    (CONFIG.config as any).consensusWindowSec = 90;
    expect(registerBuyIntent("MintC", "LeaderA").cleared).toBe(false);
    expect(registerBuyIntent("MintC", "LeaderA").cleared).toBe(false);
  });

  it("drops signals outside the window", () => {
    (CONFIG.config as any).consensusMinLeaders = 2;
    (CONFIG.config as any).consensusWindowSec = 60;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 1, 10, 0, 0));
    expect(registerBuyIntent("MintD", "LeaderA").cleared).toBe(false);
    vi.setSystemTime(new Date(2026, 1, 1, 10, 2, 0));
    // 2 minutes later, LeaderA's signal is stale
    expect(registerBuyIntent("MintD", "LeaderB").cleared).toBe(false);
    vi.useRealTimers();
  });
});
