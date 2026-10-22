# 发布检查清单

## 所有平台

- [ ] `pnpm check`、`pnpm rust:lint` 全部通过。
- [ ] `pnpm --dir tests/e2e install --frozen-lockfile` 成功，Playwright Chromium 已安装。
- [ ] `pnpm --filter @todo/app build` 生成生产构建（`apps/app/dist`）。
- [ ] `pnpm --dir tests/e2e test` 全部通过（功能、键盘、PWA 离线、axe）。
- [ ] 性能基准已按 [`docs/performance.md`](../performance.md) 的方法重跑，结果与发布说明一致。
- [ ] 无障碍审查已完成，已知问题与豁免记录在 [`docs/accessibility.md`](../accessibility.md)。
- [ ] 导入一份真实备份，任务、步骤、日期、我的一天均恢复。
- [ ] 断网 24 小时可用，重启后数据完整。
- [ ] 深色模式、200% 字体、键盘全流程、屏幕阅读器抽查。
- [ ] 无 P0 数据丢失或重复完成问题。

## 自动化门禁

浏览器测试（`.github/workflows/browser.yml`）不会启动 Axum API：Web 端默认本地模式，
只有构建时设置 `VITE_API_URL` 才会访问服务端。API 的编译、迁移与健康检查由
`.github/workflows/api.yml` 独立覆盖。若以后浏览器用例覆盖可选云同步，需要在该
workflow 中增加 PostgreSQL service 与 `cargo run -p todo-api`。

本地等价命令：

```bash
pnpm install --frozen-lockfile
pnpm --filter @todo/app build
pnpm --dir tests/e2e install --frozen-lockfile
pnpm --dir tests/e2e exec playwright install chromium
pnpm --dir tests/e2e test
```

测试项目位于 `tests/e2e`，是嵌套的独立 pnpm workspace，不进入根 workspace。
Playwright 配置会自动启动 `vite preview --host 127.0.0.1 --port 4173 --strictPort`；
如需复用已有预览，设置 `APP_URL`。

## Web

- [ ] `pnpm --filter @todo/app build` 后 `dist/` 包含 `manifest.webmanifest`、`sw.js`、图标。
- [ ] Service Worker 只缓存应用外壳与静态资源，不缓存 `/api/` 响应。
- [ ] 浏览器通知权限被拒绝时，界面明确说明而非静默失败。
- [ ] HTTPS、精确 CORS allowlist、CSP 生效。
- [ ] `release-web.yml` 的 tag 构建已上传 `shishi-web-<tag>` artifact 和 `SHA256SUMS`。
- [ ] 静态托管配置 SPA fallback（`index.html`）且对 `sw.js` 使用 no-cache。

## Desktop

- [ ] `release-desktop.yml` 在 Windows/macOS/Linux 矩阵完成 `pnpm build` + `cargo tauri build`。
- [ ] **当前 CI 产物未签名，仅用于 QA，不得作为生产发布。** 正式发布前配置签名。
- [ ] Windows：代码签名证书、时间戳服务、SmartScreen 验证。
- [ ] macOS：Developer ID Application 证书、notarization、staple；验证 Gatekeeper。
- [ ] Linux：AppImage/deb 校验和；确认 WebKitGTK 目标版本。
- [ ] 签名 secrets 占位：`TAURI_SIGNING_PRIVATE_KEY` /
      `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`APPLE_CERTIFICATE` /
      `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` /
      `APPLE_PASSWORD` / `APPLE_TEAM_ID`、`WINDOWS_CERTIFICATE` /
      `WINDOWS_CERTIFICATE_PASSWORD`。当前仓库没有任何签名凭据。
- [ ] SQLite 迁移前备份。
- [ ] 系统通知权限、托盘、全局快捷键（若启用）真机验证。

## Mobile

- [ ] Android/iOS 真机安装与升级。
- [ ] 关闭应用后预约提醒仍可触发；记录 OEM/OS 限制。
- [ ] 安全区、软键盘、触控目标、生命周期恢复。
- [ ] 商店隐私标签与通知权限说明一致。

## 服务端

- [ ] `JWT_SECRET` 为独立随机值，`AUTH_DEV_CODE` 未用于生产。
- [ ] 邮件 provider 已配置，验证码请求有 IP/邮箱双维度限流。
- [ ] Refresh token 轮换与复用检测测试通过。
- [ ] PostgreSQL 备份恢复演练完成。

## Tag 发布流程

1. 在 `main` 上完成上述门禁并更新版本号。
2. 打 tag：`git tag v1.0.0 && git push origin v1.0.0`。
3. `release-web` 与 `release-desktop` 自动运行，从 Actions 下载 artifact。
4. 人工复核 `SHA256SUMS`、安装包体积与平台清单。
5. 签名/公证完成后，才允许上传到正式分发渠道。
