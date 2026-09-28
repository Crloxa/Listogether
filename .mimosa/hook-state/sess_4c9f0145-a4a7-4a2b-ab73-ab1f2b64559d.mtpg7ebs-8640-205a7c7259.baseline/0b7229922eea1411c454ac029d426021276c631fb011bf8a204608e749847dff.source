/**
 * 敏感字段脱敏。
 *
 * 规则来自 AGENTS.md：文件路径、Cookie、密码、OAuth token 不得进入日志。
 * 键名匹配为小写全等；分组属性（如 `auth.token`）取最后一个 `.` 之后的段参与匹配。
 * Go Relay 侧在 apps/relay/internal/logging 维护同一份键列表，改动需两侧同步。
 */
export const SENSITIVE_KEYS = [
  "token",
  "access_token",
  "refresh_token",
  "password",
  "passwd",
  "cookie",
  "authorization",
  "secret",
  "filepath",
  "localpath",
  "audiopath",
] as const;

export const REDACTED = "<REDACTED>";

const sensitive = new Set<string>(SENSITIVE_KEYS);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().split(".").pop() ?? key;
  return sensitive.has(normalized);
}

const MAX_DEPTH = 8;

/** 深拷贝并脱敏普通对象/数组；不修改输入。非普通对象（Date、Error 等）原样保留。 */
export function redactRecord<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactRecord(item, depth + 1)) as unknown as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactRecord(item, depth + 1);
  }
  return out as T;
}
