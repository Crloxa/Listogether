/** 黑夜模式主题：跟随系统偏好为默认，用户切换后经 localStorage 持久化。
 * 主题经 <html data-theme="light|dark"> 生效，样式见 app/styles.css 的变量定义。 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "listo.theme";

/** 初始主题：已保存的用户选择优先，否则跟随系统深色偏好。 */
export function resolveInitialTheme(
  readStored: () => string | null = () => localStorage.getItem(STORAGE_KEY),
  prefersDark: boolean =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches,
): Theme {
  const saved = readStored();
  if (saved === "dark" || saved === "light") return saved;
  return prefersDark ? "dark" : "light";
}

/** 把主题写入文档根元素；在首帧渲染前调用可避免闪白。 */
export function applyTheme(theme: Theme, doc: Document = document): void {
  doc.documentElement.dataset.theme = theme;
  doc.documentElement.style.colorScheme = theme;
}

/** 当前文档主题；未设置过时为 null。 */
export function currentTheme(doc: Document = document): Theme | null {
  const t = doc.documentElement.dataset.theme;
  return t === "dark" || t === "light" ? t : null;
}

/** 切换主题并持久化用户选择；存储不可用时仅本次会话生效。 */
export function toggleTheme(theme: Theme, writeStored: (v: string) => void = (v) => localStorage.setItem(STORAGE_KEY, v)): Theme {
  const next: Theme = theme === "dark" ? "light" : "dark";
  try {
    writeStored(next);
  } catch {
    /* 隐私模式等存储不可用：不阻断切换 */
  }
  return next;
}
