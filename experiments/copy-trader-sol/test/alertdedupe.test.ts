import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("../src/notify.js", () => ({
  notify: notifyMock,
  fmtSol: (l: number) => (l / 1e9).toFixed(4),
}));

const { notifyDedup, _resetAlertsForTest } = await import("../src/alertdedupe.js");
const CONFIG = await import("../src/config.js");

describe("alertdedupe.notifyDedup", () => {
  beforeEach(() => {
    _resetAlertsForTest();
    notifyMock.mockReset();
  });

  it("passes first alert through", () => {
    (CONFIG.config as any).alertDedupWindowSec = 300;
    notifyDedup("key1", "hello");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith("hello");
  });

  it("suppresses repeats within window", () => {
    (CONFIG.config as any).alertDedupWindowSec = 300;
    notifyDedup("k", "first");
    notifyDedup("k", "second");
    notifyDedup("k", "third");
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("emits summary after window closes and passes the new one", () => {
    (CONFIG.config as any).alertDedupWindowSec = 60;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0));
    notifyDedup("k", "a1");
    notifyDedup("k", "a2");
    notifyDedup("k", "a3");
    vi.setSystemTime(new Date(2026, 5, 1, 12, 2, 0));
    notifyDedup("k", "a4");
    // Calls: a1, summary "(and 2 more k …)", a4 → 3 total
    expect(notifyMock).toHaveBeenCalledTimes(3);
    expect(notifyMock).toHaveBeenNthCalledWith(1, "a1");
    expect(notifyMock.mock.calls[1]![0]).toMatch(/and 2 more k/);
    expect(notifyMock).toHaveBeenNthCalledWith(3, "a4");
    vi.useRealTimers();
  });

  it("different keys are independent", () => {
    (CONFIG.config as any).alertDedupWindowSec = 300;
    notifyDedup("keyA", "a");
    notifyDedup("keyB", "b");
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });
});
