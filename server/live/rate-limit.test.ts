/**
 * The `/api/live/*` burst (burst 30, refill 1 per 3 s) with an injected clock,
 * so the test never sleeps. One user's spent burst must not touch another's.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { AppError } from "@/lib/api/core"
import { TokenBuckets, enforceLiveRateLimit } from "./rate-limit.ts"

test("thirty immediate calls pass, the thirty-first is refused", () => {
  const buckets = new TokenBuckets(30, 3_000, () => 1_000) // frozen: no refill.
  for (let i = 0; i < 30; i++) assert.equal(buckets.take("device-a"), true, `call ${i + 1}`)
  assert.equal(buckets.take("device-a"), false)
  // and the next one too — no refill has happened yet.
  assert.equal(buckets.take("device-a"), false)
})

test("time refills continuously: half a token buys nothing, a full one buys one call", () => {
  let now = 0
  const buckets = new TokenBuckets(30, 3_000, () => now)
  // Spend the whole burst, then keep draining any refill as it arrives.
  for (let i = 0; i < 30; i++) buckets.take("device-b")
  assert.equal(buckets.take("device-b"), false)

  now = 1_500 // half a token accrued.
  assert.equal(buckets.take("device-b"), false)
  now = 3_000 // one whole token now.
  assert.equal(buckets.take("device-b"), true)
  assert.equal(buckets.take("device-b"), false) // and spent immediately again.
})

test("the bucket never grows past the burst, however long it waits", () => {
  let now = 0
  const buckets = new TokenBuckets(2, 3_000, () => now) // tiny burst for focus.
  now = 10_000 // capacity refilled while it idled.
  assert.equal(buckets.take("device-c"), true)
  assert.equal(buckets.take("device-c"), true)
  assert.equal(buckets.take("device-c"), false)
})

test("buckets are per person: a spent burst never blocks a neighbour", () => {
  const buckets = new TokenBuckets(30, 3_000, () => 0) // frozen: no refill.
  for (let i = 0; i < 30; i++) buckets.take("person-1")
  assert.equal(buckets.take("person-1"), false)
  assert.equal(buckets.take("person-2"), true)
})

test("the shared limit throws the contract's 429 (`tooManyAttempts`) when spent", () => {
  const key = `test-${crypto.randomUUID()}` // an unused corner of the singleton.
  for (let i = 0; i < 30; i++) enforceLiveRateLimit(key)
  assert.throws(
    () => enforceLiveRateLimit(key),
    (error: unknown) => error instanceof AppError && error.code === "tooManyAttempts",
  )
})
