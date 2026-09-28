#!/usr/bin/env node
// 冒烟测试（Phase 1 控制面 + Phase 2 屏障/强制开始/信令转发）：
//   1. 构建 relay 二进制
//   2. 启动 relay，验证 /healthz 返回 200 且 CORS 生效
//   3. 启动 web dev server，验证首页返回 200
//   4. 房间控制面流程：建房 -> 加入 -> 双 WS 同步 -> 权限/锁房 -> 关房
//   4.5 Phase 2：NEXT_TRACK_PREPARE 广播、快照携带 pendingPrepare、RESYNC 转发、
//       房主强制开始（跳过未就绪成员）、WEBRTC_OFFER/ICE_CANDIDATE 按成员转发
//   5. 关闭两个进程
// 全部通过输出 PASS 行并以退出码 0 结束；任一步失败输出 FAIL 并以非 0 退出。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = path.join(root, "scripts", "tmp");
const relayBin = path.join(tmpDir, `relay-smoke${process.platform === "win32" ? ".exe" : ""}`);

const relayPort = 18080;
const webPort = 15173;
const webOrigin = `http://127.0.0.1:${webPort}`;
const relayHealthUrl = `http://127.0.0.1:${relayPort}/healthz`;
const webUrl = `${webOrigin}/`;

let relayProc = null;
let webProc = null;
let mockOAuthProc = null;
const relayLogs = [];
const webLogs = [];
const mockOAuthLogs = [];

const mockOAuthPort = 18090;

function fail(message) {
  console.error(`FAIL: ${message}`);
  if (relayLogs.length > 0) {
    console.error("---- relay 最近日志（尾部 30 行）----");
    for (const line of relayLogs.join("").trimEnd().split("\n").slice(-30)) console.error(line);
  }
  cleanup();
  process.exit(1);
}

function cleanup() {
  for (const proc of [relayProc, webProc, mockOAuthProc]) {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
    }
  }
}

function capture(proc, sink) {
  proc.stdout?.on("data", (chunk) => sink.push(String(chunk)));
  proc.stderr?.on("data", (chunk) => sink.push(String(chunk)));
}

// 反复请求 url 直到 extract(res) 返回非空错误；返回 extract 的 data。
async function waitFor(desc, url, extract, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const { error, data } = await extract(res);
      if (!error) return data;
      lastError = error;
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`${desc} 等待超时：${lastError}`);
}

async function main() {
  console.log("== Listogether 冒烟测试（含 Phase 1 房间控制面） ==");

  // 1. 构建 relay
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  console.log("[1/5] 构建 relay ...");
  const build = spawnSync(process.execPath, [path.join(root, "scripts", "go.mjs"), "build", "-o", relayBin, "./cmd/relay"], {
    cwd: path.join(root, "apps", "relay"),
    stdio: "inherit",
  });
  if (build.status !== 0) fail("go build 失败");
  console.log(`PASS: relay 构建成功 -> ${path.relative(root, relayBin)}`);

  // 2. 启动 mock OAuth provider（独立进程，标准 AC+PKCE，D-019）与 relay
  console.log("[2/5] 启动 mock OAuth provider + relay 并检查 /healthz ...");
  mockOAuthProc = spawn(process.execPath, [path.join(root, "scripts", "mock-oauth-provider.mjs")], {
    env: { ...process.env, MOCK_OAUTH_PORT: String(mockOAuthPort), MOCK_OAUTH_CLIENT_ID: "smoke-client" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(mockOAuthProc, mockOAuthLogs);
  mockOAuthProc.on("exit", (code) => {
    if (code !== null && code !== 0 && mockOAuthProc?.killed === false) {
      fail(`mock OAuth provider 意外退出（exit ${code}）`);
    }
  });
  const mockBase = `http://127.0.0.1:${mockOAuthPort}`;
  await waitFor("mock OAuth provider", `${mockBase}/stats`, async (res) => {
    if (!res.ok) return { error: `status ${res.status}` };
    return { data: true };
  });
  console.log(`PASS: mock OAuth provider 就绪（${mockBase}）`);

  relayProc = spawn(relayBin, [], {
    cwd: root,
    env: {
      ...process.env,
      LISTO_RELAY_ADDR: `127.0.0.1:${relayPort}`,
      LISTO_RELAY_ALLOWED_ORIGINS: `${webOrigin},http://localhost:5173`,
      // Phase 4：OAuth 全流程（mock provider 端点经环境变量注入，D-019）
      LISTO_RELAY_PUBLIC_BASE_URL: `http://127.0.0.1:${relayPort}`,
      LISTO_OAUTH_SPOTIFY_CLIENT_ID: "smoke-client",
      LISTO_OAUTH_SPOTIFY_SCOPES: "test-scope",
      LISTO_OAUTH_SPOTIFY_AUTHORIZE_URL: `${mockBase}/authorize`,
      LISTO_OAUTH_SPOTIFY_TOKEN_URL: `${mockBase}/token`,
      LISTO_OAUTH_SPOTIFY_USERINFO_URL: `${mockBase}/userinfo`,
      LISTO_OAUTH_SPOTIFY_REVOKE_URL: `${mockBase}/revoke`,
      // Phase 4 后续：TURN 短期凭据（D-018，fake 地址仅验证下发形状）
      LISTO_TURN_URLS: "turn:127.0.0.1:13478?transport=udp",
      LISTO_TURN_SECRET: "smoke-turn-secret",
      LISTO_TURN_TTL_SECONDS: "3600",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(relayProc, relayLogs);
  relayProc.on("exit", (code) => {
    if (code !== null && code !== 0 && relayProc?.killed === false) {
      fail(`relay 意外退出（exit ${code}）：\n${relayLogs.join("")}`);
    }
  });

  const healthBody = await waitFor("relay /healthz", relayHealthUrl, async (res) => {
    if (!res.ok) return { error: `status ${res.status}` };
    const body = await res.json();
    return body.status === "ok" ? { data: body } : { error: `status=${body.status}` };
  });
  console.log(`PASS: /healthz -> ${JSON.stringify(healthBody)}`);

  const corsRes = await fetch(relayHealthUrl, { headers: { Origin: webOrigin } });
  const acao = corsRes.headers.get("access-control-allow-origin");
  if (acao !== webOrigin) fail(`CORS 回显异常：${acao}`);
  console.log(`PASS: CORS 回显来源 ${acao}`);

  // 3. 启动 web dev server 并检查首页
  console.log("[3/5] 启动 web dev server 并检查首页 ...");
  const viteJs = path.join(root, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteJs)) fail("缺少 node_modules，请先运行 npm install");
  webProc = spawn(process.execPath, [viteJs, "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], {
    cwd: path.join(root, "apps", "web"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(webProc, webLogs);

  const html = await waitFor("web 首页", webUrl, async (res) => {
    if (!res.ok) return { error: `status ${res.status}` };
    const text = await res.text();
    return text.includes('id="root"') ? { data: text } : { error: "首页缺少 #root 挂载点" };
  });
  console.log(`PASS: web 首页 -> 200，包含 #root（${html.length} 字节）`);

  // 4. 房间控制面流程：建房 -> 加入 -> 双 WS 播放同步 -> 锁房 -> 关房（Phase 1）
  console.log("[4/5] 房间控制面流程（双 WS 连接）...");
  const api = `http://127.0.0.1:${relayPort}`;

  const post = async (path, body, token) => {
    const res = await fetch(`${api}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };

  const created = await post("/api/rooms", { hostName: "冒烟房主", maxMembers: 8 });
  if (created.status !== 201) fail(`建房失败：${created.status} ${JSON.stringify(created.data)}`);
  const { roomId, inviteToken, sessionToken } = created.data;
  console.log(`PASS: 建房成功 roomId=${roomId}（token 原文不落日志，仅用于本次内存流程）`);

  const joined = await post(`/api/rooms/${roomId}/sessions`, { inviteToken, name: "冒烟成员" });
  if (joined.status !== 201) fail(`加入失败：${joined.status} ${JSON.stringify(joined.data)}`);
  console.log(`PASS: 成员加入成功（role=${joined.data.role}）`);

  const badJoin = await post(`/api/rooms/${roomId}/sessions`, { inviteToken: "wrong-token", name: "坏人" });
  if (badJoin.status !== 401 || badJoin.data.code !== "INVALID_TOKEN") fail(`错误邀请 token 应 401/INVALID_TOKEN：${JSON.stringify(badJoin)}`);
  console.log("PASS: 错误邀请 token 被拒绝（401 INVALID_TOKEN）");

  const wsUrlBase = `ws://127.0.0.1:${relayPort}/ws`;
  function connectWs(session) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsUrlBase}?roomId=${roomId}&sessionToken=${session}`);
      const queue = [];
      const waiters = [];
      let maxRev = 0;
      ws.onmessage = (ev) => {
        const env = JSON.parse(ev.data);
        if (typeof env.roomRevision === "number" && env.roomRevision > maxRev) maxRev = env.roomRevision;
        const waiter = waiters.shift();
        if (waiter) waiter(env);
        else queue.push(env);
      };
      ws.onerror = () => reject(new Error("ws 连接失败"));
      ws.onopen = () => resolve({
        send: (type, payload, revision) =>
          ws.send(JSON.stringify({ v: 1, type, eventId: `smoke-${Math.random().toString(16).slice(2)}`, roomRevision: revision, senderId: "smoke", sentAtMs: 0, payload })),
        next: (timeoutMs = 3000) =>
          new Promise((res, rej) => {
            if (queue.length) return res(queue.shift());
            const waiter = (env) => {
              clearTimeout(timer);
              res(env);
            };
            // 超时把 waiter 从队列移除，避免残留 waiter 吞掉后续消息
            const timer = setTimeout(() => {
              const i = waiters.indexOf(waiter);
              if (i >= 0) waiters.splice(i, 1);
              rej(new Error("等待消息超时"));
            }, timeoutMs);
            waiters.push(waiter);
          }),
        latestRevision: () => maxRev,
        close: () => ws.close(),
      });
    });
  }

  const hostWs = await connectWs(sessionToken);
  const first = await hostWs.next();
  if (first.type !== "ROOM_SNAPSHOT") fail(`房主首条消息应为 ROOM_SNAPSHOT，got ${first.type}`);
  const memberWs = await connectWs(joined.data.sessionToken);
  const memberSnap = await memberWs.next();
  const joinedBroadcast = await hostWs.next();
  if (joinedBroadcast.type !== "MEMBER_JOINED") fail(`房主应收到 MEMBER_JOINED，got ${joinedBroadcast.type}`);
  if (joinedBroadcast.roomRevision !== memberSnap.roomRevision) fail("MEMBER_JOINED 与成员快照 revision 不一致");
  console.log(`PASS: 双 WS 挂载，快照 revision=${memberSnap.roomRevision} 一致`);

  hostWs.send("PLAY", { positionMs: 3000 }, memberSnap.roomRevision);
  const play = await memberWs.next();
  if (play.type !== "PLAY" || play.payload.positionMs !== 3000) fail(`成员应收到 PLAY 广播：${JSON.stringify(play)}`);
  console.log(`PASS: 房主 PLAY 广播到成员（revision=${play.roomRevision}，越权 senderId 已被服务端覆写）`);

  memberWs.send("PLAY", { positionMs: 0 }, play.roomRevision);
  const denied = await memberWs.next();
  if (denied.type !== "ERROR" || denied.payload.code !== "UNAUTHORIZED") fail(`成员 PLAY 应被拒绝：${JSON.stringify(denied)}`);
  console.log("PASS: 成员越权播放被拒绝（UNAUTHORIZED）");

  // 房主此刻仅积压自己 PLAY 的回显；越权 ERROR 只发给越权成员
  const hostEcho = await hostWs.next();
  if (hostEcho.type !== "PLAY") fail(`房主队列应只有 PLAY 回显：${JSON.stringify(hostEcho)}`);
  console.log("PASS: 越权 ERROR 只回给越权成员，不影响房主事件流");

  // ---- Phase 2：屏障元数据快照 + 屏障超时强制开始 + WebRTC 信令转发 ----
  console.log("[4.5/5] Phase 2 流程（屏障 / 强制开始 / 信令转发）...");
  const hostMemberId = created.data.memberId;
  const smokeMemberId = joined.data.memberId;

  // 成员始终不 READY，房主在屏障上强制开始（D-011 超时策略）
  const baseMs = Date.now() + 5_000;
  hostWs.send("NEXT_TRACK_PREPARE", {
    transitionId: "smoke-tr-1",
    track: { trackId: "k1", title: "冒烟测试曲", durationMs: 180000 },
    startPositionMs: 0,
    prepareDeadlineMs: baseMs + 3_000,
    startAtMs: baseMs + 8_000,
  }, hostWs.latestRevision());
  const memberPrepare = await memberWs.next();
  if (memberPrepare.type !== "NEXT_TRACK_PREPARE") fail(`成员应收到 PREPARE：${JSON.stringify(memberPrepare)}`);
  const hostPrepareEcho = await hostWs.next();
  if (hostPrepareEcho.type !== "NEXT_TRACK_PREPARE") fail(`房主应收到 PREPARE 回显：${JSON.stringify(hostPrepareEcho)}`);
  console.log("PASS: NEXT_TRACK_PREPARE 广播（屏障开始）");

  memberWs.send("RESYNC_REQUEST", {}, memberPrepare.roomRevision);
  const resyncSnap = await memberWs.next();
  if (resyncSnap.type !== "ROOM_SNAPSHOT" || resyncSnap.payload.pendingPrepare?.transitionId !== "smoke-tr-1") {
    fail(`重连快照应携带 pendingPrepare：${JSON.stringify(resyncSnap)}`);
  }
  console.log("PASS: 快照携带 pendingPrepare（重连成员可恢复屏障元数据并上报 READY）");

  const resyncForwarded = await hostWs.next();
  if (resyncForwarded.type !== "RESYNC_REQUEST" || resyncForwarded.senderId !== smokeMemberId) {
    fail(`房主应收到转发 RESYNC_REQUEST：${JSON.stringify(resyncForwarded)}`);
  }
  console.log("PASS: RESYNC_REQUEST 转发给房主（senderId 为请求成员，Phase 2 据此重建音频）");

  const forceStartAt = Date.now() + 1_000;
  hostWs.send("NEXT_TRACK_START", { transitionId: "smoke-tr-1", startAtMs: forceStartAt }, hostWs.latestRevision());
  const memberStart = await memberWs.next();
  if (memberStart.type !== "NEXT_TRACK_START" || memberStart.payload.startAtMs !== forceStartAt) {
    fail(`成员应收到强制开始广播：${JSON.stringify(memberStart)}`);
  }
  const hostStartEcho = await hostWs.next();
  if (hostStartEcho.type !== "NEXT_TRACK_START") fail(`房主应收到 START 回显：${JSON.stringify(hostStartEcho)}`);
  console.log("PASS: 房主强制开始广播 NEXT_TRACK_START（房间不被未就绪成员阻塞）");

  memberWs.send("WEBRTC_OFFER", { toMemberId: hostMemberId, sdp: "v=0 smoke-offer" }, memberStart.roomRevision);
  const offerAtHost = await hostWs.next();
  if (offerAtHost.type !== "WEBRTC_OFFER" || offerAtHost.senderId !== smokeMemberId) {
    fail(`房主应收到成员 OFFER：${JSON.stringify(offerAtHost)}`);
  }
  hostWs.send("ICE_CANDIDATE", { toMemberId: smokeMemberId, candidate: "candidate:1 1 udp 1 127.0.0.1 5000 typ host" }, hostWs.latestRevision());
  const candAtMember = await memberWs.next();
  if (candAtMember.type !== "ICE_CANDIDATE" || candAtMember.senderId !== hostMemberId) {
    fail(`成员应收到房主 ICE：${JSON.stringify(candAtMember)}`);
  }
  console.log("PASS: WEBRTC_OFFER / ICE_CANDIDATE 按成员转发（Relay 不解析、不保存 SDP/候选）");

  // ---- Phase 3：曲库 / 点歌审批 / 排序 / 投票跳过 / 历史 / 聊天 ----
  console.log("[4.6/5] Phase 3 流程（曲库 / 点歌 / 审批 / 排序 / 投票 / 聊天）...");

  // 等待两端都收到满足条件的 ROOM_SNAPSHOT（跳过途中的其他消息）
  async function nextSnapshot(ws, cond, desc, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    const skipped = [];
    while (Date.now() < deadline) {
      let env;
      try {
        env = await ws.next(Math.max(100, deadline - Date.now()));
      } catch {
        continue; // 单条等待超时则继续轮询直到总 deadline
      }
      if (env.type === "ROOM_SNAPSHOT" && cond(env.payload)) return env.payload;
      skipped.push(env.type === "ERROR" ? `ERROR(${env.payload?.code}:${env.payload?.message ?? ""})` : env.type);
    }
    fail(`等待快照超时（${desc}）；途中消息：${skipped.join(",") || "（无）"}`);
  }

  // 1) 房主导入曲库（仅元数据）
  hostWs.send("LIBRARY_ADD", {
    tracks: [
      { trackId: "k-lib-1", title: "曲库一", durationMs: 1000 },
      { trackId: "k-lib-2", title: "曲库二", durationMs: 2000 },
    ],
  }, hostWs.latestRevision());
  await nextSnapshot(hostWs, (s) => s.library?.length === 2, "房主曲库快照");
  await nextSnapshot(memberWs, (s) => s.library?.length === 2, "成员曲库快照");
  console.log("PASS: LIBRARY_ADD 建立房间曲库（成员快照可见元数据）");

  // 2) 成员点歌 → 待审批区；重复点同一首 → DUPLICATE_TRACK
  memberWs.send("QUEUE_REQUEST", { trackId: "k-lib-1" }, memberWs.latestRevision());
  await nextSnapshot(hostWs, (s) => s.pendingRequests?.length === 1, "待审批快照");
  const pendingSnap = await nextSnapshot(memberWs, (s) => s.pendingRequests?.length === 1, "成员待审批快照");
  const pendingEntry = pendingSnap.pendingRequests[0];
  if (pendingEntry.requestedByName !== "冒烟成员") fail(`点歌人标记缺失：${JSON.stringify(pendingEntry)}`);
  console.log("PASS: 成员点歌进入待审批区并带点歌人标记");

  memberWs.send("QUEUE_REQUEST", { trackId: "k-lib-1" }, memberWs.latestRevision());
  const dupErr = await memberWs.next();
  if (dupErr.type !== "ERROR" || dupErr.payload.code !== "DUPLICATE_TRACK") {
    fail(`重复点歌应 DUPLICATE_TRACK：${JSON.stringify(dupErr)}`);
  }
  console.log("PASS: 重复点歌被拒绝（DUPLICATE_TRACK）");

  // 3) 房主批准入队；房主自己加一首直接入队
  //    （房主每个动作后先等自己的回显快照，保证发送下一动作时 revision 已同步）
  hostWs.send("QUEUE_APPROVE", { entryId: pendingEntry.entryId }, hostWs.latestRevision());
  await nextSnapshot(hostWs, (s) => s.queue?.length === 1 && (s.pendingRequests?.length ?? 0) === 0, "批准后房主快照");
  await nextSnapshot(memberWs, (s) => s.queue?.length === 1, "成员批准后快照");
  hostWs.send("QUEUE_REQUEST", { trackId: "k-lib-2" }, hostWs.latestRevision());
  await nextSnapshot(hostWs, (s) => s.queue?.length === 2, "房主两首入队快照");
  const bothQueued = await nextSnapshot(memberWs, (s) => s.queue?.length === 2, "两首入队快照");
  console.log("PASS: 审批入队 + 房主免审批直加入队");

  // 4) 房主重排（逆序）：entryIds 用条目 ID 而非曲目 ID
  const entriesBefore = bothQueued.queue;
  const orderBefore = entriesBefore.map((e) => e.track.trackId);
  hostWs.send("QUEUE_REORDER", { entryIds: [...entriesBefore].reverse().map((e) => e.entryId) }, hostWs.latestRevision());
  await nextSnapshot(hostWs, (s) => s.queue?.[0]?.track.trackId === orderBefore[1], "重排后房主快照");
  const reordered = await nextSnapshot(memberWs, (s) => s.queue?.[0]?.track.trackId === orderBefore[1], "重排快照");
  console.log(`PASS: 队列重排生效（${orderBefore.join(" -> ")} 变为 ${reordered.queue.map((e) => e.track.trackId).join(" -> ")}）`);

  // 5) 投票跳过：2 人在线需 2 票；第二票通过
  memberWs.send("SKIP_VOTE", {}, memberWs.latestRevision());
  await nextSnapshot(memberWs, (s) => s.skipVotes?.memberIds?.length === 1, "成员一票快照");
  await nextSnapshot(hostWs, (s) => s.skipVotes?.memberIds?.length === 1, "房主一票快照");
  hostWs.send("SKIP_VOTE", {}, hostWs.latestRevision());
  await nextSnapshot(hostWs, (s) => s.skipVotes?.passed === true, "房主通过快照");
  const passedSnap = await nextSnapshot(memberWs, (s) => s.skipVotes?.passed === true, "投票通过快照");
  if (passedSnap.skipVotes.transitionId !== "smoke-tr-1") fail(`投票应绑定当前曲目：${JSON.stringify(passedSnap.skipVotes)}`);
  console.log("PASS: 投票跳过达到半数即通过并绑定当前 transitionId");

  // 6) 房主上报跳过 → 历史
  hostWs.send("TRACK_FINISHED", { outcome: "skipped" }, hostWs.latestRevision());
  await nextSnapshot(hostWs, (s) => s.history?.length === 1, "房主历史快照");
  const histSnap = await nextSnapshot(memberWs, (s) => s.history?.length === 1, "历史快照");
  if (histSnap.history[0].outcome !== "skipped" || histSnap.history[0].track.trackId !== "k1") {
    fail(`历史记录异常：${JSON.stringify(histSnap.history)}`);
  }
  console.log("PASS: TRACK_FINISHED 记入历史（当前曲目 skipped）");

  // 7) 播放模式
  hostWs.send("PLAY_MODE", { mode: "shuffle" }, hostWs.latestRevision());
  await nextSnapshot(hostWs, (s) => s.playMode === "shuffle", "房主播放模式快照");
  await nextSnapshot(memberWs, (s) => s.playMode === "shuffle", "播放模式快照");
  console.log("PASS: 播放模式随快照同步（shuffle）");

  // 8) 聊天：成员发消息，房主收到带身份的转发
  memberWs.send("CHAT_MESSAGE", { kind: "text", text: "冒烟聊天" }, memberWs.latestRevision());
  const chatAtHost = await hostWs.next();
  if (chatAtHost.type !== "CHAT_MESSAGE" || chatAtHost.payload.text !== "冒烟聊天" || chatAtHost.senderId !== smokeMemberId) {
    fail(`房主应收到聊天转发：${JSON.stringify(chatAtHost)}`);
  }
  await memberWs.next(); // 消费自己的回显
  console.log("PASS: CHAT_MESSAGE 转发并补齐发送者身份");

  // 9) 第三名成员加入 → 收到快照 + CHAT_HISTORY
  const third = await post(`/api/rooms/${roomId}/sessions`, { inviteToken, name: "冒烟新人" });
  if (third.status !== 201) fail(`第三人加入失败：${JSON.stringify(third.data)}`);
  const thirdWs = await connectWs(third.data.sessionToken);
  const thirdSnap = await thirdWs.next();
  if (thirdSnap.type !== "ROOM_SNAPSHOT") fail(`第三人首条应为快照：${thirdSnap.type}`);
  const thirdChat = await thirdWs.next();
  if (thirdChat.type !== "CHAT_HISTORY" || thirdChat.payload.messages?.length !== 1) {
    fail(`第三人应收到聊天历史：${JSON.stringify(thirdChat)}`);
  }
  console.log("PASS: 新成员连接时单发 CHAT_HISTORY（近期聊天恢复）");

  // 房主消费 MEMBER_JOINED（同时确认其 revision 已同步到第三人加入后的状态）
  const joinAtHost = await hostWs.next();
  if (joinAtHost.type !== "MEMBER_JOINED") fail(`房主应收到第三人加入：${JSON.stringify(joinAtHost)}`);

  // 10) 失败自动跳过：TRACK_FINISHED(failed+trackId) 移除队列条目
  hostWs.send("TRACK_FINISHED", { outcome: "failed", trackId: "k-lib-1" }, hostWs.latestRevision());
  const failedSnap = await nextSnapshot(thirdWs, (s) => s.history?.some((h) => h.outcome === "failed" && h.track.trackId === "k-lib-1"), "失败历史快照");
  if (failedSnap.queue.some((e) => e.track.trackId === "k-lib-1")) fail("失败条目应从队列移除");
  console.log("PASS: failed+trackId 移除队列条目（失败自动跳过路径）");
  thirdWs.close();

  // ---- Phase 4：链接解析 / OAuth / 歌词（全部离线可判定） ----
  console.log("[4.7/5] Phase 4 流程（链接解析 / OAuth / 歌词）...");
  // 等待指定类型（跳过途中的快照/加入等残余消息）
  async function nextType(ws, type, desc, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let env;
      try {
        env = await ws.next(Math.max(100, deadline - Date.now()));
      } catch {
        continue;
      }
      if (env.type === type) return env;
    }
    fail(`等待 ${type} 超时（${desc}）`);
  }
  const resolveUrl = (url, token) => post(`/api/rooms/${roomId}/links/resolve`, { url }, token);

  const resolveNoAuth = await post(`/api/rooms/${roomId}/links/resolve`, { url: "https://music.163.com/song?id=1" }, null);
  if (resolveNoAuth.status !== 401) fail(`解析未带会话应 401：${JSON.stringify(resolveNoAuth)}`);
  console.log("PASS: 链接解析需要会话（401）");

  const resolveListener = await resolveUrl("https://music.163.com/song?id=347230", joined.data.sessionToken);
  if (resolveListener.status !== 403) fail(`成员解析应 403：${JSON.stringify(resolveListener)}`);
  console.log("PASS: 链接解析仅房主（403）");

  const unsupported = await resolveUrl("https://unknown-platform.example/song?id=1", sessionToken);
  if (unsupported.status !== 400 || unsupported.data.code !== "PLATFORM_UNSUPPORTED") {
    fail(`不支持平台应 400 PLATFORM_UNSUPPORTED：${JSON.stringify(unsupported)}`);
  }
  console.log("PASS: 不支持的平台 400 PLATFORM_UNSUPPORTED（客户端/服务端双重拒绝）");

  const privateAddr = await resolveUrl("http://192.168.1.1:8080/api", sessionToken);
  if (privateAddr.status !== 400) fail(`私网地址应 400：${JSON.stringify(privateAddr)}`);
  console.log("PASS: 私网地址被拒（SSRF 防护，不发起内网请求）");

  // OAuth（fake 凭证只验证端点行为与 URL 构造；不发起外部请求）
  const oauthListRes = await fetch(`${api}/api/oauth/providers`, { headers: { Authorization: `Bearer ${sessionToken}` } });
  const oauthList = await oauthListRes.json();
  const spotifyStatus = oauthList.providers?.find((p) => p.id === "spotify");
  if (!spotifyStatus?.configured || spotifyStatus.connected) fail(`OAuth 状态异常：${JSON.stringify(spotifyStatus)}`);
  console.log("PASS: /api/oauth/providers 显示已配置未连接（无任何 token 字段）");

  const oauthStart = await post("/api/oauth/spotify/start", {}, sessionToken);
  if (oauthStart.status !== 200) fail(`OAuth start 失败：${JSON.stringify(oauthStart)}`);
  const authorizeUrl = oauthStart.data.authorizeUrl ?? "";
  if (!authorizeUrl.includes("code_challenge_method=S256") || !authorizeUrl.includes("state=") || authorizeUrl.includes("code_verifier")) {
    fail(`授权 URL 缺少 PKCE 要素或泄露 verifier：${authorizeUrl}`);
  }
  console.log("PASS: OAuth start 生成 AC+PKCE(S256) 授权 URL（verifier 不出服务端）");

  const badCallback = await fetch(`${api}/api/oauth/spotify/callback?code=x&state=forged`);
  if (badCallback.status !== 400) fail(`伪造 state 回调应 400：${badCallback.status}`);
  console.log("PASS: 伪造 state 的回调被拒绝（400）");

  const notConfigured = await post("/api/oauth/netease/start", {}, sessionToken);
  if (notConfigured.status !== 503 || notConfigured.data.code !== "OAUTH_NOT_CONFIGURED") {
    fail(`未配置 provider 应 503 OAUTH_NOT_CONFIGURED：${JSON.stringify(notConfigured)}`);
  }
  console.log("PASS: 未配置的 provider 返回 503 OAUTH_NOT_CONFIGURED（可操作提示）");

  // OAuth 全流程（mock provider 独立进程，真实 HTTP，D-019）：
  // start → mock /authorize（302 回回调）→ Relay callback 用自身 verifier 完成 PKCE → 连接 → 刷新 → 断开撤销
  const oauthStartFull = await post("/api/oauth/spotify/start", {}, sessionToken);
  if (oauthStartFull.status !== 200) fail(`OAuth start 失败：${JSON.stringify(oauthStartFull)}`);
  const authorizeUrlFull = oauthStartFull.data.authorizeUrl;
  const authRes = await fetch(authorizeUrlFull, { redirect: "manual" });
  if (authRes.status !== 302) fail(`mock authorize 应 302，got ${authRes.status}`);
  const callbackUrl = authRes.headers.get("location");
  if (!callbackUrl || !callbackUrl.includes("/api/oauth/spotify/callback") || !callbackUrl.includes("code=")) {
    fail(`回调地址异常：${callbackUrl}`);
  }
  const cbRes = await fetch(callbackUrl);
  const cbText = await cbRes.text();
  if (cbRes.status !== 200 || !cbText.includes("授权完成")) fail(`回调页应提示授权完成：${cbRes.status} ${cbText.slice(0, 80)}`);
  const providersAfter = await (await fetch(`${api}/api/oauth/providers`, { headers: { Authorization: `Bearer ${sessionToken}` } })).json();
  const spotifyAfter = providersAfter.providers?.find((p) => p.id === "spotify");
  if (!spotifyAfter?.connected || spotifyAfter.userLabel !== "冒…") {
    fail(`授权后应连接且打码标识为 冒…：${JSON.stringify(spotifyAfter)}`);
  }
  console.log("PASS: OAuth 全流程（authorize→PKCE 回调→连接，用户标识打码 冒…）");
  // expires_in=1：等过期后状态查询驱动真实刷新（mock /stats 校验）
  await new Promise((r) => setTimeout(r, 1300));
  const providersRefreshed = await (await fetch(`${api}/api/oauth/providers`, { headers: { Authorization: `Bearer ${sessionToken}` } })).json();
  if (!providersRefreshed.providers?.find((p) => p.id === "spotify")?.connected) {
    fail("过期后状态查询应触发刷新并保持连接");
  }
  const mockStats1 = await (await fetch(`${mockBase}/stats`)).json();
  if (mockStats1.refreshed < 1) fail(`mock 应收到 refresh 请求：${JSON.stringify(mockStats1)}`);
  console.log("PASS: 过期 token 经 refresh 轮换保持连接（mock 收到 refresh 请求）");
  const disconnectRes = await post("/api/oauth/spotify/disconnect", {}, sessionToken);
  if (disconnectRes.status !== 200) fail(`断开失败：${JSON.stringify(disconnectRes)}`);
  const mockStats2 = await (await fetch(`${mockBase}/stats`)).json();
  if (mockStats2.revoked < 1) fail("断开应调用 provider 撤销端点");
  const providersFinal = await (await fetch(`${api}/api/oauth/providers`, { headers: { Authorization: `Bearer ${sessionToken}` } })).json();
  if (providersFinal.providers?.find((p) => p.id === "spotify")?.connected) fail("断开后应显示未连接");
  console.log("PASS: 断开调用撤销端点并清除本地状态");

  // ICE 端点（D-018）：需要会话；下发 TURN 短期凭据且不泄露 secret
  const iceNoAuth = await fetch(`${api}/api/webrtc/ice`);
  if (iceNoAuth.status !== 401) fail(`ICE 无会话应 401, got ${iceNoAuth.status}`);
  const iceRes = await fetch(`${api}/api/webrtc/ice`, { headers: { Authorization: `Bearer ${sessionToken}` } });
  const iceBody = await iceRes.json();
  if (!iceRes.ok || !iceBody.turnEnabled) fail(`ICE 端点异常：${iceRes.status} ${JSON.stringify(iceBody)}`);
  const iceServer = iceBody.iceServers?.[0];
  if (!iceServer?.username || !iceServer?.credential || !String(iceServer.username).match(/^\d{10}$/)) {
    fail(`TURN 短期凭据形状异常：${JSON.stringify(iceServer)}`);
  }
  if (JSON.stringify(iceBody).includes("smoke-turn-secret")) fail("ICE 响应泄露 secret");
  console.log(`PASS: /api/webrtc/ice 下发 TURN 短期凭据（username=${iceServer.username}，TTL=${iceBody.ttlSeconds}s，secret 不出服务端）`);

  // 歌词（D-017）：发布 → 转发；超限 → LYRICS_TOO_LARGE；越权 → UNAUTHORIZED；新成员补发
  hostWs.send("TRACK_LYRICS", { trackId: "k1", format: "lrc", lyrics: "[00:01.00]冒烟歌词第一行\n[00:03.00]第二行" }, hostWs.latestRevision());
  const lyricsAtMember = await nextType(memberWs, "TRACK_LYRICS", "成员歌词转发");
  if (lyricsAtMember.payload.trackId !== "k1") {
    fail(`成员应收到歌词转发：${JSON.stringify(lyricsAtMember)}`);
  }
  console.log("PASS: 房主发布歌词经 TRACK_LYRICS 转发给成员");

  memberWs.send("TRACK_LYRICS", { trackId: "k1", format: "lrc", lyrics: "[00:01.00]越权" }, memberWs.latestRevision());
  const lyricsDenied = await nextType(memberWs, "ERROR", "成员歌词越权");
  if (lyricsDenied.payload.code !== "UNAUTHORIZED") {
    fail(`成员发布歌词应被拒：${JSON.stringify(lyricsDenied)}`);
  }
  console.log("PASS: 歌词发布仅房主（UNAUTHORIZED）");

  const oversized = "x".repeat(50 * 1024);
  hostWs.send("TRACK_LYRICS", { trackId: "k1", format: "plain", lyrics: oversized }, hostWs.latestRevision());
  const lyricsTooLarge = await nextType(hostWs, "ERROR", "超限歌词");
  if (lyricsTooLarge.payload.code !== "LYRICS_TOO_LARGE") {
    fail(`超限歌词应 LYRICS_TOO_LARGE：${JSON.stringify(lyricsTooLarge)}`);
  }
  console.log("PASS: 超 48KB 歌词被拒（LYRICS_TOO_LARGE，64KB 帧内安全拒绝）");

  const fourth = await post(`/api/rooms/${roomId}/sessions`, { inviteToken, name: "冒烟第四人" });
  if (fourth.status !== 201) fail(`第四人加入失败：${JSON.stringify(fourth.data)}`);
  const fourthWs = await connectWs(fourth.data.sessionToken);
  const fourthSnap = await fourthWs.next();
  if (fourthSnap.type !== "ROOM_SNAPSHOT") fail(`第四人首条应为快照：${fourthSnap.type}`);
  const lyricsBackfill = await nextType(fourthWs, "TRACK_LYRICS", "新成员歌词补发");
  if (lyricsBackfill.payload.trackId !== "k1") {
    fail(`新成员应收到当前曲目歌词补发：${JSON.stringify(lyricsBackfill)}`);
  }
  console.log("PASS: 新成员挂载后补发当前曲目缓存歌词");
  fourthWs.close();
  await nextType(hostWs, "MEMBER_JOINED", "房主确认第四人加入");

  const lockRes = await post(`/api/rooms/${roomId}/lock`, { locked: true }, sessionToken);
  if (lockRes.status !== 200) fail(`锁房失败：${JSON.stringify(lockRes)}`);
  const lockedJoin = await post(`/api/rooms/${roomId}/sessions`, { inviteToken, name: "迟到者" });
  if (lockedJoin.status !== 403 || lockedJoin.data.code !== "ROOM_LOCKED") fail(`锁房后加入应 403/ROOM_LOCKED：${JSON.stringify(lockedJoin)}`);
  console.log("PASS: 锁房后新加入被拒绝（403 ROOM_LOCKED）");

  // 排掉第三人加入与后续广播留下的残余消息，保持关房断言的消息边界
  for (const c of [hostWs, memberWs]) {
    for (let i = 0; i < 4; i++) {
      let env;
      try {
        env = await c.next(400);
      } catch {
        break; // 没有更多残余消息
      }
      if (env.type !== "MEMBER_JOINED" && env.type !== "ROOM_SNAPSHOT") {
        fail(`关房前出现意外消息：${JSON.stringify(env)}`);
      }
    }
  }

  const closeRes = await post(`/api/rooms/${roomId}/close`, {}, sessionToken);
  if (closeRes.status !== 200) fail(`关闭房间失败：${JSON.stringify(closeRes)}`);
  const memberLeft = await memberWs.next();
  if (memberLeft.type !== "MEMBER_LEFT" || memberLeft.payload.reason !== "room_closed") {
    fail(`成员应收到 room_closed：${JSON.stringify(memberLeft)}`);
  }
  const hostLeft = await hostWs.next();
  if (hostLeft.type !== "MEMBER_LEFT" || hostLeft.payload.reason !== "room_closed") {
    fail(`房主应收到 room_closed：${JSON.stringify(hostLeft)}`);
  }
  console.log("PASS: 房主关闭房间后全员收到 MEMBER_LEFT(room_closed)");
  hostWs.close();
  memberWs.close();

  // 5. 关闭进程
  console.log("[5/5] 关闭进程 ...");
  cleanup();
  console.log("== 冒烟测试全部通过 ==");
}

main().catch((err) => fail(err?.stack ?? String(err)));
