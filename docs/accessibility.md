# 无障碍审查（WCAG 2.2 AA）

- 审查日期：2026-10-21
- 构建：生产预览 `apps/app/dist`（Vite production `index-Ck6taOgQ.js`；Chromium 156）
- 工具：`@axe-core/playwright` 4.14.0 + Playwright 1.64.1，手工键盘检查
- 范围：桌面 1440×900、移动 390×844，浅色/深色，首页、任务详情、设置、搜索
- 结论：**自动化 axe WCAG A/AA 扫描为 0 violation**；`tests/e2e` 已移除
  allowlist，任何新违规都会直接让 CI 失败。屏幕阅读器与系统缩放仍需人工验收。

## 已通过

- 页面声明 `lang="zh-CN"`；标题由视图动态更新（例如“我的一天 · 拾事”）。
- 主页恰好一个 `main`；侧栏为命名 `complementary` landmark（`aria-label="主导航"`），
  内部导航为 `aria-label="应用导航"`；移动端底栏为 `aria-label="移动端导航"`。
- 设置与搜索对话框均有可访问名称；设置主题为命名 `radiogroup`，三个 `role=radio`
  通过 `aria-checked` 表达选中状态。
- 任务行不再使用 `role="button"` 包裹 checkbox/星标；标题区域是独立原生按钮，
  可访问名称由可见标题、日期/步骤/清单和 `sr-only` 状态文本自然组成。
- 键盘：`Ctrl/⌘+K` 打开搜索并聚焦输入框；`Ctrl/⌘+N` 聚焦快速录入；任务标题按钮
  `Space` 切换完成、`Enter` 打开详情；`Escape` 关闭对话框并把焦点还给触发按钮；
  设置对话框 Tab 焦点被困在对话框内。
- `:focus-visible` 有 2px outline；`prefers-reduced-motion` 会关闭动画。
- 390/768/1440 宽度下，列表与详情均无水平滚动（Playwright 轮询断言）。
- 浅色/深色主题切换即时生效，设置会持久化到 `localStorage`。
- 浅色 tertiary/amber token 已加深；选中任务行的步骤徽标使用
  `--text-secondary`，深色主题下不再低于 4.5:1。
- 详情面板区块标题统一为 `h2`，不再从页面 `h1` 跳到 `h3`。

## 自动化基线

`tests/e2e/tests/accessibility.spec.ts` 在以下状态执行 axe WCAG A/AA：

- 桌面浅色首页
- 桌面深色 + 设置
- 移动端浅色首页
- 移动端任务详情

当前四项均为 **0 violation**。未来若出现误报，必须先在
`docs/accessibility.md` 记录原因，再在测试中加入范围尽可能窄的例外；
不得直接放宽整条规则。

## 未覆盖 / 发布前仍需人工完成

- NVDA（Windows）、VoiceOver（macOS/iOS）、TalkBack（Android）实机抽查。
- 200% 字体/缩放、Windows 高对比度模式。
- Web 端提醒权限被拒绝时的提示措辞与焦点顺序。
- 原生 Tauri WebView 与移动端安全区、软键盘下的详情面板。
- 自动化 axe 只能覆盖可静态分析的规则，不能替代屏幕阅读器走查。

## 复现

```bash
pnpm --filter @todo/app build
APP_URL=http://127.0.0.1:4173 pnpm --dir tests/e2e test
```

测试报告会写入 `tests/e2e/playwright-report/`；完整的 axe 原始节点摘要保存在
`artifacts/a11y-audit.json`（git-ignored）。
