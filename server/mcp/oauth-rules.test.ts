import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import {
  CLAUDE_REDIRECT,
  fetchableHost,
  grantedScopes,
  isClientDocumentUrl,
  isLoopbackRedirect,
  isPrivateAddress,
  pkceChallenge,
  pkceMatches,
  readClientDocument,
  redirectAllowed,
  redirectRegistered,
} from "./oauth-rules.ts"

test("PKCE S256 is base64url(SHA-256(verifier))", async () => {
  const verifier = "dBjftJeZ4CVP-mJ92ZbuoxSoGQKbNQb6P9Y0Y9X5Sd0"
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  assert.equal(await pkceChallenge(verifier), challenge)
  assert.equal(await pkceMatches(verifier, challenge), true)
  assert.equal(await pkceMatches(`${verifier}x`, challenge), false)
  assert.equal(await pkceMatches("too-short", await pkceChallenge("too-short")), false)
})

test("only Claude's callback and loopback redirects are allowed", () => {
  assert.equal(redirectAllowed(CLAUDE_REDIRECT), true)
  assert.equal(redirectAllowed("http://localhost:53682/callback"), true)
  assert.equal(redirectAllowed("http://127.0.0.1:9000/callback"), true)
  assert.equal(redirectAllowed("http://[::1]:9000/callback"), true)
  assert.equal(redirectAllowed("https://claude.ai/api/mcp/auth_callback/"), false)
  assert.equal(redirectAllowed("https://evil.example/api/mcp/auth_callback"), false)
  assert.equal(redirectAllowed("https://localhost/callback"), false)
  assert.equal(isLoopbackRedirect("http://localhost.evil.example/callback"), false)
})

test("loopback redirects may change port; others must match exactly", () => {
  const registered = ["http://localhost/callback", CLAUDE_REDIRECT]
  assert.equal(redirectRegistered(registered, "http://localhost:61234/callback"), true)
  assert.equal(redirectRegistered(registered, "http://localhost:61234/other"), false)
  assert.equal(redirectRegistered(registered, "http://127.0.0.1:61234/callback"), false)
  assert.equal(redirectRegistered(registered, CLAUDE_REDIRECT), true)
  assert.equal(redirectRegistered(["http://localhost/callback"], CLAUDE_REDIRECT), false)
})

test("scopes: all by default, unknown ones dropped", () => {
  assert.deepEqual(grantedScopes(undefined), ["taskly.read", "taskly.write"])
  assert.deepEqual(grantedScopes(""), ["taskly.read", "taskly.write"])
  assert.deepEqual(grantedScopes("taskly.read offline_access"), ["taskly.read"])
  assert.equal(grantedScopes("admin"), null)
})

test("client metadata documents", () => {
  const url = "https://claude.ai/oauth/claude-code-client-metadata"
  const good = {
    client_id: url,
    client_name: "Claude Code",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    token_endpoint_auth_method: "none",
  }
  assert.deepEqual(readClientDocument(good, url), {
    name: "Claude Code",
    redirectUris: good.redirect_uris,
  })
  assert.equal(typeof readClientDocument({ ...good, client_id: "https://evil.example/x" }, url), "string")
  assert.equal(typeof readClientDocument({ ...good, redirect_uris: [] }, url), "string")
  assert.equal(typeof readClientDocument({ ...good, token_endpoint_auth_method: "client_secret_basic" }, url), "string")
  assert.equal(typeof readClientDocument("nope", url), "string")
  assert.equal(isClientDocumentUrl(url), true)
  assert.equal(isClientDocumentUrl("https://claude.ai/"), false)
  assert.equal(isClientDocumentUrl("http://claude.ai/metadata"), false)
  assert.equal(isClientDocumentUrl("dcr-1234"), false)
})

test("client documents are only fetched from public names", () => {
  assert.equal(fetchableHost("claude.ai"), true)
  assert.equal(fetchableHost("localhost"), false)
  assert.equal(fetchableHost("printer.local"), false)
  assert.equal(fetchableHost("10.0.0.5"), false)
  assert.equal(fetchableHost("8.8.8.8"), false)
  assert.equal(fetchableHost("[::1]"), false)
  assert.equal(fetchableHost("intranet"), false)
})

test("private addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
    assert.equal(isPrivateAddress(ip), true, ip)
  }
  for (const ip of ["8.8.8.8", "160.79.104.10", "2606:4700::1111", "172.32.0.1"]) {
    assert.equal(isPrivateAddress(ip), false, ip)
  }
})
