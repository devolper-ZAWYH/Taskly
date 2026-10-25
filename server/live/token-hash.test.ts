/**
 * Device tokens are stored as SHA-256 hex (`tsk_lv_<64 hex>`, hashed like
 * session tokens). The cross-implementation check matters: the same raw token
 * must verify identically on the Cloudflare Worker and on the cPanel Node
 * build (`server/node/d1.ts` runs the same SQL against stored hashes).
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { hashToken, newSessionToken } from "@/server/crypto"

test("device tokens hash to lowercase SHA-256 hex, verifiable across builds", async () => {
  const token = `tsk_lv_${newSessionToken()}`
  const hash = await hashToken(token)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(hash, createHash("sha256").update(token).digest("hex")) // Node sees the same
  assert.equal(hash, await hashToken(token)) // deterministic: the stored row matches next auth
  assert.notEqual(await hashToken(`${token}1`), hash) // and neighbouring tokens differ
})
