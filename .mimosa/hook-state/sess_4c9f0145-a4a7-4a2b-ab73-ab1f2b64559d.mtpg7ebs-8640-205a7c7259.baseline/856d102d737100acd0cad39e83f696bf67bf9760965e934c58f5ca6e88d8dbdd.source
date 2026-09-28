import { describe, expect, it } from "vitest";
import { REDACTED, SENSITIVE_KEYS, isSensitiveKey, redactRecord } from "../src/redact";

describe("redactRecord", () => {
  it("脱敏 token/password/cookie 等敏感键，保留其他字段", () => {
    const input = {
      token: "abc123",
      password: "hunter2",
      cookie: "session=xyz",
      memberId: "m-1",
      count: 3,
    };
    const out = redactRecord(input);
    expect(out.token).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    expect(out.memberId).toBe("m-1");
    expect(out.count).toBe(3);
  });

  it("分组键取最后一段匹配，如 auth.token", () => {
    const out = redactRecord({ auth: { token: "t-1", scheme: "Bearer" } });
    expect(out.auth.token).toBe(REDACTED);
    expect(out.auth.scheme).toBe("Bearer");
  });

  it("递归处理数组和嵌套对象", () => {
    const out = redactRecord({
      members: [{ name: "a", localPath: "D:\\music\\song.mp3" }],
      meta: { access_token: "at" },
    });
    const firstMember = out.members[0];
    expect(firstMember?.localPath).toBe(REDACTED);
    expect(firstMember?.name).toBe("a");
    expect(out.meta.access_token).toBe(REDACTED);
  });

  it("不修改输入对象", () => {
    const input = { token: "keep-me-original" };
    redactRecord(input);
    expect(input.token).toBe("keep-me-original");
  });

  it("文件路径类键（filepath/localpath/audiopath）脱敏", () => {
    expect(redactRecord({ filePath: "C:/Users/x/a.mp3" }).filePath).toBe(REDACTED);
    expect(redactRecord({ audioPath: "/home/x/a.flac" }).audioPath).toBe(REDACTED);
  });

  it("isSensitiveKey 大小写不敏感且覆盖全部声明键", () => {
    expect(isSensitiveKey("TOKEN")).toBe(true);
    for (const key of SENSITIVE_KEYS) {
      expect(isSensitiveKey(key), `键 ${key} 应视为敏感`).toBe(true);
    }
    expect(isSensitiveKey("memberId")).toBe(false);
  });

  it("原样保留 Date/Error 等非普通对象", () => {
    const date = new Date(0);
    const err = new Error("boom");
    const out = redactRecord({ at: date, err, token: "t" });
    expect(out.at).toBe(date);
    expect(out.err).toBe(err);
    expect(out.token).toBe(REDACTED);
  });
});
