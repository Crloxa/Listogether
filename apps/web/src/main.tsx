import { createRoot } from "react-dom/client";
import App from "./app/App";
import { applyTheme, resolveInitialTheme } from "./ui/theme";
import "./app/styles.css";

// 首帧渲染前应用主题，避免深色用户看到闪白
applyTheme(resolveInitialTheme());

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点");
}

createRoot(container).render(<App />);
