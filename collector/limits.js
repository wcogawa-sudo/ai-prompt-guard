// Simple in-memory rate limiting (per client address). Enough for one
// collector process; behind a load balancer use the proxy's limits instead.

class RateLimiter {
  // max events per windowMs per key
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  // Returns true if allowed (and records the hit).
  take(key, now) {
    const t = now || Date.now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 10000) this.prune(t);
    return true;
  }
  count(key, now) {
    const t = now || Date.now();
    return (this.hits.get(key) || []).filter((x) => t - x < this.windowMs).length;
  }
  prune(now) {
    for (const [k, list] of this.hits) if (!list.some((x) => now - x < this.windowMs)) this.hits.delete(k);
  }
}

const isLoopback = (host) => ["127.0.0.1", "::1", "localhost"].includes(String(host));

module.exports = { RateLimiter, isLoopback };
