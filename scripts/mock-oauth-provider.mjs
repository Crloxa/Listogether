#!/usr/bin/env node
// 本地 mock OAuth provider（D-019 验收基准）：独立进程实现标准 AC+PKCE 四端点，
// 与 Relay（标准 OAuth 客户端）走真实 HTTP。仅用于测试/联调，不入构建。
//
// 端点：
//   GET  /authorize  —— 校验 client_id/PKCE 参数后签发 code，302 回 redirect_uri（自动同意）
//   POST /token      —— authorization_code（校验 code_verifier 的 S256 challenge）/ refresh_token
//   GET  /userinfo   —— Bearer 认证返回打码友好展示用字段
//   POST /revoke     —— 撤销 token
// 状态仅存内存；日志只打事件，不打 token/code 原文。
import { createHash, createHmac, randomUUID } from "node:crypto";
import http from "node:http";

const port = Number(process.env.MOCK_OAUTH_PORT ?? 18090);
const clientId = process.env.MOCK_OAUTH_CLIENT_ID ?? "mock-client";
const clientSecret = process.env.MOCK_OAUTH_CLIENT_SECRET ?? "";

/** code → {challenge, method, redirectUri, used}；refresh token → {revoked}。 */
const codes = new Map();
const refreshTokens = new Map();
const revoked = new Set();
let issuedCount = 0;
let refreshCount = 0;
let revokedCount = 0;

function log(event) {
  console.log(`[mock-oauth] ${event}`);
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/authorize") {
    if (url.searchParams.get("client_id") !== clientId) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("unknown client_id");
      return;
    }
    const challenge = url.searchParams.get("code_challenge");
    const method = url.searchParams.get("code_challenge_method");
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (method !== "S256" || !challenge || !redirectUri) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("PKCE S256 required");
      return;
    }
    const code = randomUUID().replaceAll("-", "");
    codes.set(code, { challenge, redirectUri, used: false });
    log(`authorize: code issued (state=${state ? "present" : "missing"})`);
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    res.writeHead(302, { location: target.toString() });
    res.end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/token") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const grant = form.get("grant_type");
      const json = (payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (grant === "authorization_code") {
        const code = form.get("code");
        const entry = codes.get(code ?? "");
        if (!entry || entry.used) {
          log("token: invalid_grant (code unknown/reused)");
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const verifier = form.get("code_verifier") ?? "";
        const expect = base64url(createHash("sha256").update(verifier).digest());
        if (expect !== entry.challenge) {
          log("token: PKCE challenge mismatch");
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        entry.used = true;
        issuedCount += 1;
        const accessToken = "mock-at-" + issuedCount;
        const refreshToken = "mock-rt-" + issuedCount;
        refreshTokens.set(refreshToken, { revoked: false });
        log(`token: issued (expires_in=1 to exercise refresh)`);
        json({
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 1, // 1 秒：驱动客户端走真实刷新路径
          scope: "test-scope",
          token_type: "Bearer",
        });
        return;
      }
      if (grant === "refresh_token") {
        const rt = form.get("refresh_token") ?? "";
        const entry = refreshTokens.get(rt);
        if (!entry || entry.revoked || revoked.has(rt)) {
          log("token: refresh rejected (unknown/revoked)");
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        refreshCount += 1;
        const accessToken = "mock-at-r" + refreshCount;
        log("token: refreshed");
        json({ access_token: accessToken, expires_in: 3600, scope: "test-scope", token_type: "Bearer" });
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/userinfo") {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token.startsWith("mock-at-") || revoked.has(token)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "mock-user-42", display_name: "冒烟用户" }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/revoke") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const token = form.get("token") ?? "";
      revoked.add(token);
      const rtEntry = refreshTokens.get(token);
      if (rtEntry) rtEntry.revoked = true;
      revokedCount += 1;
      log(`revoke: done (total=${revokedCount})`);
      res.writeHead(200);
      res.end();
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ issued: issuedCount, refreshed: refreshCount, revoked: revokedCount }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${port} (client_id=${clientId}${clientSecret ? " +secret" : ""})`);
});
