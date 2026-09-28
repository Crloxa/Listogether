import { useEffect, useState } from "react";
import { relayBaseUrl } from "./relay-config";

type HealthState =
  | { kind: "checking" }
  | { kind: "ok"; version: string }
  | { kind: "down" };

/** 探测 Relay /healthz，向用户展示后端连接状态。 */
export default function RelayHealth() {
  const [state, setState] = useState<HealthState>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${relayBaseUrl}/healthz`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as { status?: string; version?: string };
        if (body.status !== "ok") throw new Error("unexpected health body");
        if (!cancelled) setState({ kind: "ok", version: body.version ?? "unknown" });
      } catch {
        if (!cancelled) setState({ kind: "down" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <p aria-live="polite" data-testid="relay-health">
      {state.kind === "checking" && "正在检查 Relay 连接…"}
      {state.kind === "ok" && `Relay 已连接（版本 ${state.version}）`}
      {state.kind === "down" && "Relay 无法连接：请确认 apps/relay 已启动"}
    </p>
  );
}
