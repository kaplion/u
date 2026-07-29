import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/venues/binance/rate-limiter.js";

describe("RateLimiter", () => {
  it("bütçe içinde izin verir, aşınca pencere sonuna kadar bekletir", () => {
    let now = 0;
    const limiter = new RateLimiter(100, () => now);
    expect(limiter.tryAcquire(60)).toEqual({ ok: true });
    expect(limiter.tryAcquire(40)).toEqual({ ok: true });
    const denied = limiter.tryAcquire(1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryInMs).toBe(60_000);

    now = 60_000; // yeni pencere
    expect(limiter.tryAcquire(50)).toEqual({ ok: true });
  });

  it("429'da exponential backoff uygular ve blokeyi sayar", () => {
    let now = 0;
    const limiter = new RateLimiter(1_000, () => now, 1_000, 300_000);
    expect(limiter.onRateLimited()).toBe(1_000);
    expect(limiter.onRateLimited()).toBe(2_000);
    expect(limiter.onRateLimited()).toBe(4_000);

    const denied = limiter.tryAcquire(1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryInMs).toBe(4_000);

    now = 4_000;
    expect(limiter.tryAcquire(1)).toEqual({ ok: true });
  });

  it("Retry-After verilirse ona uyar", () => {
    let now = 0;
    const limiter = new RateLimiter(1_000, () => now);
    expect(limiter.onRateLimited(30_000)).toBe(30_000);
    const denied = limiter.tryAcquire(1);
    if (!denied.ok) expect(denied.retryInMs).toBe(30_000);
  });

  it("başarı backoff sayacını sıfırlar", () => {
    let now = 0;
    const limiter = new RateLimiter(1_000, () => now, 1_000);
    limiter.onRateLimited();
    limiter.onRateLimited();
    limiter.onSuccess();
    expect(limiter.onRateLimited()).toBe(1_000); // baştan başlar
  });

  it("backoff tavana dayanır", () => {
    const limiter = new RateLimiter(1_000, () => 0, 1_000, 8_000);
    for (let i = 0; i < 10; i++) limiter.onRateLimited();
    expect(limiter.onRateLimited()).toBe(8_000);
  });
});
