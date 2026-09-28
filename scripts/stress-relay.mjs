#!/usr/bin/env node
// Relay 压测基线（技术设计"性能和容量目标"的验证工具）：
//   场景：R 个房间 × (1 房主 + M 成员) 全部 WebSocket 接入（默认 100×10 = 1000 连接）
//   指标：连接成功率/耗时、空闲期掉线数、房主→成员控制事件（PLAY 广播）延迟 P50/P95/P99、容器内存/CPU
// 用法：
//   node scripts/stress-relay.mjs --url http://127.0.0.1:18080 --rooms 100 --members 9 --soak 60 --samples 300 --rounds 3
//   小规模试跑：--rooms 3 --members 3 --soak 5 --samples 20 --rounds 1
// 依赖：Node >= 22（内置 WebSocket / fetch），无第三方包。
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = arg("url", "http://127.0.0.1:18080");
const ROOMS = Number(arg("rooms", 100));
const MEMBERS = Number(arg("members", 9)); // 每房间成员数（另有 1 房主）
const SOAK_SEC = Number(arg("soak", 60));
const SAMPLES = Number(arg("samples", 300));
const ROUNDS = Number(arg("rounds", 3));
const CONNECT_CONCURRENCY = Number(arg("connect-concurrency", 50));
const REPORT = arg("report", "scripts/tmp/stress-report.json");
const WS_BASE = BASE.replace(/^http/, "ws");
const container = arg("container", "listo-stress-relay");

const log = (msg) => console.log(`[stress ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const percentile = (arr, p) => {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
};

function dockerStats() {
  try {
    const out = execSync(`docker stats --no-stream --format "{{.MemUsage}}|{{.CPUPerc}}" ${container}`, {
      encoding: "utf8",
    }).trim();
    const [mem, cpu] = out.split("|");
    return { mem, cpu };
  } catch {
    return { mem: null, cpu: null };
  }
}

// ---- HTTP：建房 + 成员会话 ----
async function createRoom(i) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostName: `压测房主${i}`, maxMembers: MEMBERS + 1 }),
  });
  if (!res.ok) throw new Error(`create room ${i}: HTTP ${res.status}`);
  return res.json();
}
async function joinSession(roomId, inviteToken, i) {
  const res = await fetch(`${BASE}/api/rooms/${roomId}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteToken, name: `压测成员${i}` }),
  });
  if (!res.ok) throw new Error(`join ${roomId}[${i}]: HTTP ${res.status}`);
  return res.json();
}

// ---- WebSocket 客户端 ----
// 注意：resolve 返回 state 本身（不能展开拷贝）——消息监听器持续在原对象上
// 更新 maxRevision/closed，调用方持有的引用必须能看到这些更新。
function connectWs(roomId, token, { onEnvelope } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const ws = new WebSocket(`${WS_BASE}/ws?roomId=${roomId}&sessionToken=${token}`);
    const state = { ws, roomId, open: false, closed: false, failed: false, maxRevision: 0, connectMs: 0 };
    ws.addEventListener("open", () => {
      state.open = true;
      state.connectMs = Date.now() - started;
      resolve(state);
    });
    ws.addEventListener("message", (ev) => {
      try {
        const env = JSON.parse(ev.data);
        if (typeof env.roomRevision === "number" && env.roomRevision > state.maxRevision) {
          state.maxRevision = env.roomRevision;
        }
        onEnvelope?.(env);
      } catch {
        /* 非 JSON 帧忽略 */
      }
    });
    ws.addEventListener("close", () => {
      state.closed = true;
    });
    ws.addEventListener("error", () => {
      if (!state.open) {
        state.failed = true;
        state.connectMs = Date.now() - started;
        resolve(state);
      }
    });
  });
}

function sendPlay(state) {
  state.ws.send(
    JSON.stringify({
      v: 1,
      type: "PLAY",
      eventId: `stress-${Math.random().toString(16).slice(2)}`,
      roomRevision: state.maxRevision,
      senderId: "stress",
      sentAtMs: Date.now(),
      payload: { positionMs: 0 },
    }),
  );
  state.maxRevision += 1; // 与浏览器客户端一致的乐观递增
}

// ---- 主流程 ----
async function main() {
  const report = { scenario: { rooms: ROOMS, membersPerRoom: MEMBERS, soakSec: SOAK_SEC, samples: SAMPLES }, startedAt: new Date().toISOString() };
  log(`目标 ${BASE}：${ROOMS} 房间 × (1+${MEMBERS}) 连接`);
  report.baseline = dockerStats();
  log(`容器基线内存: ${report.baseline.mem}`);

  // 1. 建 100 个房间（房主+成员会话）
  const rooms = [];
  const t0 = Date.now();
  for (let i = 0; i < ROOMS; i++) {
    const created = await createRoom(i);
    const memberTokens = [];
    for (let m = 0; m < MEMBERS; m++) {
      memberTokens.push((await joinSession(created.roomId, created.inviteToken, i * 100 + m)).sessionToken);
    }
    rooms.push({ roomId: created.roomId, hostToken: created.sessionToken, memberTokens });
    if ((i + 1) % 20 === 0) log(`房间会话 ${i + 1}/${ROOMS}（${Date.now() - t0}ms）`);
  }
  log(`全部会话就绪（${Date.now() - t0}ms）`);

  // 2. 接入全部 WebSocket（worker 池：每个 worker 串行处理房间，池大小 = 并发上限）
  const connections = [];
  const connectTimes = [];
  let connectFails = 0;
  const t1 = Date.now();
  let next = 0;
  const connectTimeoutMs = 20_000;
  const withTimeout = (p, desc) =>
    Promise.race([
      p,
      new Promise((resolve) => setTimeout(() => resolve({ open: false, failed: true, closed: true, ws: { close() {} }, connectMs: connectTimeoutMs }), connectTimeoutMs, desc)),
    ]);
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= rooms.length) return;
      const room = rooms[idx];
      const host = await withTimeout(connectWs(room.roomId, room.hostToken), "host");
      const latencies = [];
      const sampler = await withTimeout(
        connectWs(room.roomId, room.memberTokens[0], {
          onEnvelope: (env) => {
            if (env.type === "PLAY") latencies.push(Date.now() - env.sentAtMs);
          },
        }),
        "sampler",
      );
      const rest = [];
      for (let m = 1; m < room.memberTokens.length; m++) {
        rest.push(await withTimeout(connectWs(room.roomId, room.memberTokens[m]), "member"));
      }
      const all = [host, sampler, ...rest];
      for (const c of all) {
        if (c.failed || !c.open) connectFails += 1;
        else connectTimes.push(c.connectMs);
      }
      connections.push({ room, host, sampler, rest, latencies });
      if (connections.length % 10 === 0) log(`已接入 ${connections.length}/${rooms.length} 房间（失败 ${connectFails}）`);
    }
  };
  await Promise.all(Array.from({ length: CONNECT_CONCURRENCY }, worker));
  const totalConns = connections.length * (MEMBERS + 1);
  log(`连接完成：${totalConns} 个 WS，失败 ${connectFails}，耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  report.connect = {
    total: totalConns,
    failed: connectFails,
    p50: percentile(connectTimes, 50),
    p95: percentile(connectTimes, 95),
    p99: percentile(connectTimes, 99),
    seconds: Number(((Date.now() - t1) / 1000).toFixed(1)),
  };
  report.afterConnect = dockerStats();
  log(`接入后内存: ${report.afterConnect.mem}  CPU: ${report.afterConnect.cpu}`);

  // 3. 空闲浸泡：只有服务端 PING/客户端自动 PONG
  log(`空闲浸泡 ${SOAK_SEC}s ...`);
  await new Promise((r) => setTimeout(r, SOAK_SEC * 1000));
  const closedDuringSoak = connections.flatMap((c) => [c.host, c.sampler, ...c.rest]).filter((c) => c.closed).length;
  report.soak = { seconds: SOAK_SEC, closed: closedDuringSoak };
  report.afterSoak = dockerStats();
  log(`浸泡后掉线 ${closedDuringSoak}，内存: ${report.afterSoak.mem}  CPU: ${report.afterSoak.cpu}`);

  // 4. 控制事件延迟：房主 PLAY → 成员收到广播（跨全部房间采样）
  log(`延迟采样 ${SAMPLES} 次（${ROUNDS} 轮 × ${rooms.length} 房）...`);
  const allLatencies = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const c of connections) {
      sendPlay(c.host);
      if (allLatencies.length >= SAMPLES) break;
    }
    // 等本轮广播送达并记录
    await new Promise((r) => setTimeout(r, 300));
    for (const c of connections) allLatencies.push(...c.latencies.splice(0));
    if (allLatencies.length >= SAMPLES) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  report.latency = {
    samples: allLatencies.length,
    p50: percentile(allLatencies, 50),
    p95: percentile(allLatencies, 95),
    p99: percentile(allLatencies, 99),
    max: allLatencies.length ? Math.max(...allLatencies) : null,
  };
  report.afterLatency = dockerStats();
  log(`延迟样本 ${allLatencies.length}：P50=${report.latency.p50}ms  P95=${report.latency.p95}ms  P99=${report.latency.p99}ms  max=${report.latency.max}ms`);
  log(`压测后内存: ${report.afterLatency.mem}  CPU: ${report.afterLatency.cpu}`);

  // 5. 收尾：全部显式离开（3001），房间即时清空
  for (const c of connections) {
    for (const conn of [c.host, c.sampler, ...c.rest]) {
      try {
        conn.ws.close(3001, "stress done");
      } catch {
        /* 已关闭 */
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  log(`报告已写入 ${REPORT}`);
}

main().catch((err) => {
  console.error("[stress] 失败:", err);
  process.exit(1);
});
