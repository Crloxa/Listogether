/** 复制到剪贴板按钮；成功后短暂显示“已复制”。 */
import { useEffect, useState } from "react";

export default function CopyButton({ text, label = "复制链接" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // 剪贴板不可用时退化为选中文本提示
      setCopied(false);
      window.prompt("请手动复制以下链接", text);
    }
  }

  return (
    <button type="button" onClick={handleCopy} data-testid="copy-invite">
      {copied ? "已复制 ✓" : label}
    </button>
  );
}
