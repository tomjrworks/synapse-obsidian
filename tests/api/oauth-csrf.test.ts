import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  signAuthorizeRequest,
  verifyAuthorizeRequest,
} from "../../src/oauth.js";

// M1: GET /authorize mints an HMAC token over the request params + an
// issued-at timestamp; POST /authorize re-verifies it before any credential
// check. These tests exercise the sign/verify pair directly.

const PARAMS = {
  clientId: "client-abc",
  redirectUri: "http://localhost/oauth/callback",
  codeChallenge: "challenge-xyz",
  codeChallengeMethod: "S256",
};

describe("OAuth /authorize CSRF binding (M1)", () => {
  beforeEach(() => {
    vi.stubEnv("OAUTH_CSRF_SECRET", "test-csrf-secret");
  });

  it("verifies a freshly signed token", () => {
    const issuedAt = Date.now();
    const token = signAuthorizeRequest({ ...PARAMS, issuedAt });
    expect(verifyAuthorizeRequest(token, issuedAt, PARAMS)).toBe(true);
  });

  it("rejects a tampered client_id", () => {
    const issuedAt = Date.now();
    const token = signAuthorizeRequest({ ...PARAMS, issuedAt });
    expect(
      verifyAuthorizeRequest(token, issuedAt, {
        ...PARAMS,
        clientId: "attacker-client",
      }),
    ).toBe(false);
  });

  it("rejects a tampered code_challenge", () => {
    const issuedAt = Date.now();
    const token = signAuthorizeRequest({ ...PARAMS, issuedAt });
    expect(
      verifyAuthorizeRequest(token, issuedAt, {
        ...PARAMS,
        codeChallenge: "different-challenge",
      }),
    ).toBe(false);
  });

  it("rejects a downgraded code_challenge_method", () => {
    const issuedAt = Date.now();
    const token = signAuthorizeRequest({ ...PARAMS, issuedAt });
    expect(
      verifyAuthorizeRequest(token, issuedAt, {
        ...PARAMS,
        codeChallengeMethod: "plain",
      }),
    ).toBe(false);
  });

  it("rejects an expired token (>10 min old)", () => {
    const issuedAt = Date.now() - 11 * 60 * 1000;
    const token = signAuthorizeRequest({ ...PARAMS, issuedAt });
    expect(verifyAuthorizeRequest(token, issuedAt, PARAMS)).toBe(false);
  });

  it("accepts a token within the 10-min window", () => {
    const issuedAt = Date.now() - 9 * 60 * 1000;
    const token = signAuthorizeRequest({ ...PARAMS, issuedAt });
    expect(verifyAuthorizeRequest(token, issuedAt, PARAMS)).toBe(true);
  });

  it("rejects a future-dated issued_at", () => {
    const issuedAt = Date.now() + 5 * 60 * 1000;
    const token = signAuthorizeRequest({ ...PARAMS, issuedAt });
    expect(verifyAuthorizeRequest(token, issuedAt, PARAMS)).toBe(false);
  });

  it("rejects garbage / missing tokens", () => {
    const issuedAt = Date.now();
    expect(verifyAuthorizeRequest("", issuedAt, PARAMS)).toBe(false);
    expect(verifyAuthorizeRequest("zzz-not-hex", issuedAt, PARAMS)).toBe(false);
    expect(verifyAuthorizeRequest(undefined, issuedAt, PARAMS)).toBe(false);
    expect(verifyAuthorizeRequest("ab", issuedAt, PARAMS)).toBe(false);
  });

  it("rejects a non-finite issued_at", () => {
    const token = signAuthorizeRequest({ ...PARAMS, issuedAt: Date.now() });
    expect(verifyAuthorizeRequest(token, NaN, PARAMS)).toBe(false);
  });
});
