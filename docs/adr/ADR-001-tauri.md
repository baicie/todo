# ADR-001：选择 Tauri 2，而不是 Flutter 或 Electron

- 状态：接受
- 日期：2026-10-21

## 背景

需要覆盖 Windows、macOS、Linux、Android、iOS，并复用同一套 SolidJS UI 和 TypeScript
业务层。Electron 的桌面包与内存占用不适合“随手打开的小工具”；Flutter 移动体验好，但
无法复用 TS 领域模型与组件。

## 决策

使用 Tauri 2 + 系统 WebView。桌面和移动共用 SPA，平台能力通过固定命令桥接暴露。

## 后果

- 安装包小、UI 复用率高。
- 仍需真实设备压测 WebView 内存与启动时间。
- 移动端通知等能力需要在原生侧补充插件和真机验证。
