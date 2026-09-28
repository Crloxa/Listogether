/** ICE 配置运行时覆盖（D-018）与静态回退（D-010）单测。 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeIceServers,
  getActiveIceServers,
  runtimeTurnEnabled,
  setRuntimeIceServers,
  validateIceServerArray,
} from "../media/webrtc/ice-config";

afterEach(() => clearRuntimeIceServers());

describe("ICE 配置优先级", () => {
  it("无运行时、无环境变量 → 默认 STUN", () => {
    const r = getActiveIceServers(null);
    expect(r.source).toBe("default");
    expect(r.servers[0]?.urls).toEqual(["stun:stun.l.google.com:19302"]);
  });

  it("有环境变量无运行时 → env", () => {
    const r = getActiveIceServers('[{"urls":["turn:x"],"username":"u","credential":"c"}]');
    expect(r.source).toBe("env");
    expect(r.servers[0]?.username).toBe("u");
  });

  it("运行时优先于环境变量（D-018）", () => {
    setRuntimeIceServers([{ urls: ["turn:relay.example:3478"], username: "1736000000", credential: "sig" }], true);
    const r = getActiveIceServers('[{"urls":["stun:old"]}]');
    expect(r.source).toBe("runtime");
    expect(r.servers[0]?.urls).toEqual(["turn:relay.example:3478"]);
    expect(runtimeTurnEnabled()).toBe(true);
  });

  it("非法运行时数组被忽略（保持回退）", () => {
    // @ts-expect-error 故意传非法形状
    setRuntimeIceServers([{ nope: true }], false);
    const r = getActiveIceServers(null);
    expect(r.source).toBe("default");
    expect(runtimeTurnEnabled()).toBe(false);
  });

  it("环境变量 JSON 损坏回退默认并带原因", () => {
    const r = getActiveIceServers("{broken");
    expect(r.source).toBe("default");
    expect(r.error).toContain("不是合法 JSON");
  });

  it("validateIceServerArray 拒绝空数组与缺 urls 项", () => {
    expect(validateIceServerArray([])).toBeTruthy();
    expect(validateIceServerArray([{ urls: 1 }])).toBeTruthy();
    expect(validateIceServerArray([{ urls: ["stun:x"] }])).toBeNull();
  });
});
