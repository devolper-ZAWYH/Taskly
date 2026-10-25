/**
 * Best-effort rate limit for the `/api/live/*` endpoints: a burst of 30 calls
 * per person, refilling at 1 call per 3 seconds. Held in the process's
 * memory, so on Cloudflare it is per pod (per isolate) and resets on deploy —
 * generous by design; its job is to blunt runaway devices, not to meter.
 * Rate limiting per device token is a Phase 5 job (`plan-live-meetings.md` §7).
 */
import { AppError } from "@/lib/api/core"

const CAPACITY = 30
const REFILL_EVERY_MS = 3_000

type Bucket = { tokens: number; at: number }

/** Continuous refill: `tokens` gains `elapsed / 3000` each, capped at the burst. */
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly capacity = CAPACITY,
    private readonly refillEveryMs = REFILL_EVERY_MS,
    private readonly now = Date.now,
  ) {}

  /** One call allowed? (The caller discounts voided attempts by not calling.) */
  take(key: string): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: this.now() }
    const now = this.now()
    const refill = (now - bucket.at) / this.refillEveryMs
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refill)
    bucket.at = now
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    return true
  }
}

export const liveBuckets = new TokenBuckets()

/** Throws `tooManyAttempts` when this person's burst is spent. */
export function enforceLiveRateLimit(userId: string): void {
  // Best-effort per pod: in-memory and reset per isolate (the module comment
  // says why). Fail-open would blur meetings into gaps, so a pod that runs
  // hot blocks locally rather than dropping the cap entirely.
  if (!liveBuckets.take(userId)) throw new AppError("tooManyAttempts")
}
