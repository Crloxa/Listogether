/** 黑夜模式主题辅助函数单元测试。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, currentTheme, resolveInitialTheme, toggleTheme } from "../ui/theme";

describe("resolveInitialTheme", () => {
  it("已保存的用户选择优先于系统偏好", () => {
    expect(resolveInitialTheme(() => "dark", false)).toBe("dark");
    expect(resolveInitialTheme(() => "light", true)).toBe("light");
  });

  it("未保存时跟随系统深色偏好", () => {
    expect(resolveInitialTheme(() => null, true)).toBe("dark");
    expect(resolveInitialTheme(() => null, false)).toBe("light");
  });

  it("非法保存值回退到系统偏好", () => {
    expect(resolveInitialTheme(() => "blue", true)).toBe("dark");
    expect(resolveInitialTheme(() => "", false)).toBe("light");
  });
});

describe("toggleTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("在 light/dark 间切换并持久化用户选择", () => {
    expect(toggleTheme("light")).toBe("dark");
    expect(localStorage.getItem("listo.theme")).toBe("dark");
    expect(toggleTheme("dark")).toBe("light");
    expect(localStorage.getItem("listo.theme")).toBe("light");
  });

  it("存储不可用时不抛错（仅本次会话生效）", () => {
    expect(toggleTheme("dark", () => { throw new Error("quota"); })).toBe("light");
  });
});

describe("applyTheme/currentTheme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty("color-scheme");
  });

  it("写入 data-theme 与 color-scheme，并可读回", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(currentTheme()).toBe("dark");

    applyTheme("light");
    expect(currentTheme()).toBe("light");
  });

  it("未设置时 currentTheme 为 null", () => {
    expect(currentTheme()).toBeNull();
  });
});
