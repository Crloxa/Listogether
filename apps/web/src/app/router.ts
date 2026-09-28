import { useEffect, useState } from "react";

/**
 * 极简路径路由：不引入 react-router，仅支持 "/"、"/join"、"/room/:roomId"。
 * navigate 通过 pushState + popstate 通知订阅者。
 */
export interface Route {
  path: string;
  search: URLSearchParams;
}

function currentRoute(): Route {
  if (typeof window === "undefined") return { path: "/", search: new URLSearchParams() };
  return { path: window.location.pathname, search: new URLSearchParams(window.location.search) };
}

export function navigate(to: string): void {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return route;
}
