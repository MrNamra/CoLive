/**
 * Token bucket rate limiter.
 */
export class TokenBucket {
  private capacity: number;
  private refillRatePerSec: number;
  private tokens: number;
  private lastRefill: number;

  constructor(capacity: number, refillRatePerSec: number) {
    this.capacity = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  public tryConsume(tokens = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
    this.lastRefill = now;
  }
}

/**
 * Sliding window IP rate limiter.
 */
export class IpRateLimiter {
  private attempts: Map<string, number[]> = new Map();
  private maxAttempts: number;
  private windowMs: number;

  constructor(maxAttempts: number, windowMs: number) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  public isAllowed(ip: string): boolean {
    const now = Date.now();
    const timestamps = this.attempts.get(ip) || [];
    const valid = timestamps.filter((t) => now - t < this.windowMs);

    if (valid.length >= this.maxAttempts) {
      this.attempts.set(ip, valid);
      return false;
    }

    valid.push(now);
    this.attempts.set(ip, valid);
    return true;
  }

  public cleanup(): void {
    const now = Date.now();
    for (const [ip, timestamps] of this.attempts.entries()) {
      const valid = timestamps.filter((t) => now - t < this.windowMs);
      if (valid.length === 0) {
        this.attempts.delete(ip);
      } else {
        this.attempts.set(ip, valid);
      }
    }
  }
}
