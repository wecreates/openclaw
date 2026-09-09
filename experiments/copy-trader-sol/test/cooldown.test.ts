import { beforeEach, describe, expect, it } from "vitest";
import {
  _clearCooldowns,
  leaderOnCooldown,
  markLeaderBought,
  markMintSold,
  mintOnCooldown,
} from "../src/cooldown.js";

const CONFIG = await import("../src/config.js");

describe("cooldown", () => {
  beforeEach(() => _clearCooldowns());

  it("mintOnCooldown false when never sold", () => {
    expect(mintOnCooldown("MintA")).toBe(false);
  });

  it("markMintSold arms cooldown", () => {
    (CONFIG.config as any).mintReentryCooldownMinutes = 60;
    markMintSold("MintB");
    expect(mintOnCooldown("MintB")).toBe(true);
  });

  it("cooldown of 0 minutes is no-op", () => {
    (CONFIG.config as any).mintReentryCooldownMinutes = 0;
    markMintSold("MintC");
    expect(mintOnCooldown("MintC")).toBe(false);
  });

  it("leader cooldown independent of mint", () => {
    (CONFIG.config as any).leaderRebuyCooldownMinutes = 5;
    markLeaderBought("LeaderX");
    expect(leaderOnCooldown("LeaderX")).toBe(true);
    expect(leaderOnCooldown("LeaderY")).toBe(false);
  });
});
