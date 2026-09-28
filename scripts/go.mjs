#!/usr/bin/env node
// 解析 go 可执行文件并转发命令行参数。
// 优先级：LISTO_GO_BIN 环境变量 > PATH 中的 go > 常见安装位置。
// 将本机安装路径加入 PATH（如 D:\Golang\go\bin）即可不依赖 fallback。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const fallbackLocations = [
  "D:\\Golang\\go\\bin\\go.exe",
  "C:\\Program Files\\Go\\bin\\go.exe",
  "/usr/local/go/bin/go",
];

function resolveGo() {
  if (process.env.LISTO_GO_BIN && existsSync(process.env.LISTO_GO_BIN)) {
    return process.env.LISTO_GO_BIN;
  }
  const probe = spawnSync("go", ["version"], { stdio: "ignore" });
  if (probe.status === 0) return "go";
  for (const loc of fallbackLocations) {
    if (existsSync(loc)) return loc;
  }
  console.error(
    "[scripts/go.mjs] 未找到 go。请将 go 加入 PATH（本机示例：D:\\Golang\\go\\bin），或设置环境变量 LISTO_GO_BIN 指向 go 可执行文件。",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
// Go module 在 apps/relay；无论从仓库哪个目录调用都在该目录执行（LISTO_GO_CWD 可覆盖）。
const goCwd = process.env.LISTO_GO_CWD ?? new URL("../apps/relay", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const result = spawnSync(resolveGo(), args, { stdio: "inherit", cwd: goCwd });
process.exit(result.status ?? 1);
