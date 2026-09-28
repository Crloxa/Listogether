/** 黑夜模式切换按钮：固定在页面右上角，所有页面可用。 */
import { useState } from "react";
import { applyTheme, currentTheme, resolveInitialTheme, toggleTheme, type Theme } from "./theme";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme() ?? resolveInitialTheme());

  function handleToggle() {
    const next = toggleTheme(theme);
    applyTheme(next);
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      data-testid="theme-toggle"
      onClick={handleToggle}
      aria-label={theme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
      title={theme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
    >
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}
