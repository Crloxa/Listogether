/**
 * 平台链接识别与规范化（Phase 4，D-014 web 侧）：
 * 与 Go 侧 apps/relay/internal/providers 保持同一规则，
 * 两端用同一组 fixture 做跨语言一致性测试（normalize 同表见 relay providers_test）。
 *
 * 这里只做「识别 + 规范化」的即时校验（不发网络请求）；
 * 元数据解析在 Relay 端执行（SSRF 防护 + 平台 API）。
 */
import type { Platform } from "@listogether/protocol";

/** 平台链接输入校验失败：unsupported = 平台不认识；invalid = 平台认识但链接不合法。 */
export class LinkFormatError extends Error {
  constructor(
    public reason: "unsupported" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "LinkFormatError";
  }
}

export interface NormalizedLink {
  platform: Platform;
  normalizedUrl: string;
}

const MAX_URL_LEN = 2560;

/** 平台列表（UI 提示用）。 */
export const SUPPORTED_PLATFORM_HINT = "支持：网易云音乐、QQ 音乐、Spotify、YouTube Music 单曲链接";

/** 识别并规范化链接；失败抛 LinkFormatError。 */
export function normalizeLink(raw: string): NormalizedLink {
  const trimmed = raw.trim();
  if (!trimmed) throw new LinkFormatError("invalid", "请粘贴音乐平台链接");
  if (trimmed.length > MAX_URL_LEN) throw new LinkFormatError("invalid", "链接过长");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LinkFormatError("invalid", "链接格式不正确");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LinkFormatError("invalid", "只支持 http(s) 链接");
  }

  const host = url.hostname.toLowerCase();
  const netease = tryNormalizeNetEase(url, host);
  if (netease) return { platform: "netease", normalizedUrl: netease };
  const qq = tryNormalizeQQMusic(url, host);
  if (qq) return { platform: "qqmusic", normalizedUrl: qq };
  const spotify = tryNormalizeSpotify(url, host);
  if (spotify) return { platform: "spotify", normalizedUrl: spotify };
  const yt = tryNormalizeYTMusic(url, host);
  if (yt) return { platform: "ytmusic", normalizedUrl: yt };

  throw new LinkFormatError("unsupported", "暂不支持该平台。" + SUPPORTED_PLATFORM_HINT);
}

function digitsOnly(s: string | null): string | null {
  return s && /^\d{1,20}$/.test(s) ? s : null;
}

function tryNormalizeNetEase(url: URL, host: string): string | null {
  if (host !== "music.163.com") return null;
  if (!url.pathname.startsWith("/song")) return null;
  const id = digitsOnly(url.searchParams.get("id")) ?? pathSegmentAfter(url.pathname, "song");
  if (!id) throw new LinkFormatError("invalid", "网易云链接缺少歌曲 id");
  return "https://music.163.com/song?id=" + id;
}

function tryNormalizeQQMusic(url: URL, host: string): string | null {
  if (host !== "y.qq.com" && host !== "i.y.qq.com") return null;
  const mid =
    validQQMid(url.searchParams.get("songmid")) ??
    validQQMid(url.searchParams.get("mid")) ??
    pathQQMid(url.pathname);
  if (!mid) throw new LinkFormatError("invalid", "QQ 音乐链接缺少歌曲 mid");
  return "https://y.qq.com/n/yqq/song/" + mid + ".html";
}

function validQQMid(s: string | null | undefined): string | null {
  return s && /^[0-9A-Za-z]{6,20}$/.test(s) ? s : null;
}

function pathQQMid(path: string): string | null {
  // 用 match 而非 exec：静态扫描会把 RegExp.exec 误判为命令执行
  const m = path.match(/\/yqq\/song\/([0-9A-Za-z]+)\.html/);
  return m ? validQQMid(m[1]) : null;
}

function tryNormalizeSpotify(url: URL, host: string): string | null {
  if (host !== "open.spotify.com" && host !== "spotify.com") return null;
  const id = spotifyTrackId(url.pathname);
  if (!id) throw new LinkFormatError("invalid", "目前只支持 Spotify 单曲链接（/track/<id>）");
  return "https://open.spotify.com/track/" + id;
}

/** 兼容 /track/<id>、/intl-<lang>/track/<id>、/embed/track/<id>。 */
function spotifyTrackId(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "track" && /^[0-9A-Za-z]{22}$/.test(parts[i + 1] ?? "")) {
      return parts[i + 1] ?? null;
    }
  }
  return null;
}

function tryNormalizeYTMusic(url: URL, host: string): string | null {
  const watchHosts = ["www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube.com"];
  if (!watchHosts.includes(host) && host !== "youtu.be") return null;
  let id = url.searchParams.get("v");
  if (!id && host === "youtu.be") id = url.pathname.replaceAll("/", "");
  if (!id || !/^[0-9A-Za-z_-]{11}$/.test(id)) {
    throw new LinkFormatError("invalid", "链接缺少合法的视频 id");
  }
  return "https://www.youtube.com/watch?v=" + id;
}

function pathSegmentAfter(path: string, segment: string): string | null {
  const parts = path.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === segment) {
      const next = parts[i + 1] ?? "";
      return digitsOnly(next) ?? null;
    }
  }
  return null;
}

/** 播放能力的中文说明（UI 共用）。 */
export function describePlayability(
  playability: string | undefined,
): { label: string; tone: "ok" | "warn" | "bad" } | null {
  switch (playability) {
    case "playable":
      return { label: "平台确认可用", tone: "ok" };
    case "needs_login":
      return { label: "平台需登录/会员确认", tone: "warn" };
    case "preview_only":
      return { label: "平台仅预览可听", tone: "warn" };
    case "region_locked":
      return { label: "平台提示地区限制", tone: "bad" };
    case "unavailable":
      return { label: "平台显示已失效", tone: "bad" };
    case "unknown":
      return { label: "平台可用性未知", tone: "warn" };
    default:
      return null;
  }
}
