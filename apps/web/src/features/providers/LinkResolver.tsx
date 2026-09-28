/** 房主的平台链接解析卡片（Phase 4，D-014）：输入 → 解析 → 结果 → 加入曲库。 */
import { useState } from "react";
import type { Track, TrackSource } from "@listogether/protocol";
import { LinkFormatError, describePlayability, normalizeLink } from "./normalize";
import { describeProviderError, providerApi, type ResolveResponse } from "./api";

const PLATFORM_LABEL: Record<string, string> = {
  netease: "网易云音乐",
  qqmusic: "QQ 音乐",
  spotify: "Spotify",
  ytmusic: "YouTube Music",
  other: "其他平台",
};

export interface LinkResolverProps {
  roomId: string;
  sessionToken: string;
  /** 确认后把识别结果加入曲库（调用方为 useHostLibrary.addTracks）。 */
  onAddToLibrary: (track: Track) => void;
}

export default function LinkResolver({ roomId, sessionToken, onAddToLibrary }: LinkResolverProps) {
  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResponse | null>(null);
  const [added, setAdded] = useState(false);

  async function resolve() {
    setResolving(true);
    setError(null);
    setResult(null);
    setAdded(false);
    try {
      // 客户端先做即时校验（平台识别/URL 规范化），失败不发请求
      normalizeLink(url);
    } catch (err) {
      if (err instanceof LinkFormatError) {
        setError(err.message);
        setResolving(false);
        return;
      }
      throw err;
    }
    try {
      const res = await providerApi.resolve(roomId, sessionToken, url);
      setResult(res);
    } catch (err) {
      setError(describeProviderError(err));
    } finally {
      setResolving(false);
    }
  }

  function addResult() {
    if (!result) return;
    const source: TrackSource = {
      platform: result.platform,
      url: result.normalizedUrl,
      externalId: result.externalId,
      playability: result.playability,
      coverUrl: result.coverUrl,
      resolvedAtMs: Date.now(),
    };
    onAddToLibrary({
      // trackId 以平台来源生成（稳定可重复）：platform + externalId
      trackId: sourceExternalTrackId(source),
      title: result.title || "未知标题",
      artist: result.artist,
      durationMs: result.durationMs ?? 0,
      source,
    });
    setAdded(true);
  }

  return (
    <section className="card" data-testid="link-resolver">
      <h2>添加平台链接</h2>
      <p className="hint">
        识别歌曲信息与平台可用性（不做平台音频转发）。播放仍需房主本机对应音频文件，缺失时自动降级跳过。
      </p>
      <div className="controls">
        <input
          type="url"
          value={url}
          placeholder="粘贴单曲链接，如 https://music.163.com/song?id=347230"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void resolve();
          }}
          data-testid="link-input"
          aria-label="音乐平台链接"
        />
        <button type="button" onClick={() => void resolve()} disabled={resolving || url.trim() === ""} data-testid="link-resolve-btn">
          {resolving ? "识别中…" : "识别链接"}
        </button>
      </div>
      {error && (
        <p role="alert" className="banner warn" data-testid="link-error">
          {error}
        </p>
      )}
      {result && (
        <div data-testid="link-result">
          <p>
            <span className="badge">{PLATFORM_LABEL[result.platform] ?? result.platform}</span>{" "}
            <strong>{result.title}</strong>
            {result.artist ? " — " + result.artist : ""}
            {result.durationMs ? " · " + Math.round(result.durationMs / 1000) + " 秒" : ""}
          </p>
          {describePlayability(result.playability) && (
            <p className={"banner " + playabilityClass(result.playability)} data-testid="link-playability">
              {describePlayability(result.playability)?.label}
            </p>
          )}
          {result.message && <p className="hint">{result.message}</p>}
          {added ? (
            <p className="hint" data-testid="link-added">
              已加入曲库。若本机没有对应音频文件，播放到该曲目时会明确跳过。
            </p>
          ) : (
            <button type="button" onClick={addResult} data-testid="link-add-btn">
              加入曲库
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function playabilityClass(playability: string): string {
  switch (playability) {
    case "playable":
      return "info";
    case "unavailable":
    case "region_locked":
      return "warn";
    default:
      return "warn";
  }
}

/** 平台来源曲目的稳定 trackId（同一首歌重复解析不产生重复条目）。 */
export function sourceExternalTrackId(source: TrackSource): string {
  const raw = source.platform + ":" + (source.externalId ?? source.url);
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return "ext-" + source.platform + "-" + (hash >>> 0).toString(16).padStart(8, "0");
}
