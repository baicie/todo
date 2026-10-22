# Web 性能基准

> 测量日期：2026-10-22
> 构建：`apps/app/dist`（Vite production，入口 `index-DKwWlfHZ.js`）
> 机器：Windows 10.0.26200 / Intel Core i5-10400F，6C/12T，2.9 GHz，15.9 GiB RAM
> 浏览器：Playwright Chromium 156.0.8078.4（headless）
> 测试地址：`http://127.0.0.1:4173`（`vite preview`，本机回环）

## 结论摘要

- 10,000 任务：列表点击到首行 **76 ms**（预算 ≤ 200 ms），搜索输入到结果 **101 ms**（预算 ≤ 450 ms，含应用防抖），冷重载 **174 ms**（预算 ≤ 1.5 s），热重载 **175 ms**。
- 100,000 任务：现在加载**全部 100,000 条**，热重载 **1,206 ms**，列表首屏 **167 ms**，搜索 **226 ms**，JS 堆 **50.35 MiB**；均在 100k 预算内。
- 虚拟滚动在 10k/100k 时只挂载约 18 个可见行；DOM 节点约 1,440，不随任务数线性增长。
- 列表、计数、搜索共用内存任务快照；`getCounts` 和 `listTasks` 不各自扫描全表。
- Web 首屏 JS gzip 约 **115 KB**（主入口 78.7 KB + Dexie 32.5 KB + 其他 4 KB），低于“尽量 ≤ 200 KB”目标。
- 测试数据直接写入 IndexedDB，不修改应用源码；100k 冷写入耗时约 6.1 s，属于测试数据准备时间，不是用户操作。

## 测量方法

数据由 [`scripts/perf/seed-dataset.mjs`](../scripts/perf/seed-dataset.mjs) 通过 Playwright
`page.evaluate` 直接写入 Dexie 兼容的 IndexedDB（`shishi-todo` 的 `tasks` store），
不修改应用源码。任务字段为完整 `Task` 结构（标题、状态、rank、dueOn、important、
时间戳等），每 7 条设置一个截止日期，每 11 条标记重要。

每个档位使用独立 browser context：

1. 正常打开应用建立数据库；清空 `tasks/steps/dayPlans/mutations`，批量写入 N 条任务。
2. **冷重载**：注销 Service Worker、清空 Cache Storage、通过 CDP
   `Network.setCacheDisabled(true)` 禁用 HTTP 缓存，然后 `page.reload()`。
3. **热重载**：Service Worker 与 HTTP 缓存预热后连续重载（4 次样本）。
4. **列表查询**：点击「全部任务」到首个任务行可见。`App.tsx` 现在请求最多
   100,000 条；`DexieTaskRepository` 用一份内存任务快照同时服务 `getCounts` 与
   `listTasks`，仅对当前页任务批量附加 steps/dayPlans，虚拟列表只挂载约 18 个可见行。
5. **搜索**：从一次干净热重载开始，`Ctrl+K` 打开搜索，输入唯一 token
   `zebra-target-0` 到首个结果可见；包含应用防抖和搜索 UI 渲染。搜索使用同一份
   任务快照，并预编译搜索 token。
6. **JS 堆**：`HeapProfiler.collectGarbage` 后读取 CDP `Performance.getMetrics` 的
   `JSHeapUsedSize`；这是 JS 堆，不是进程 RSS。

计时使用 Node 侧 wall clock，包含 Playwright 协议往返；相对比较有效，绝对值比应用内
`performance.now()` 略高。

命令：

```bash
pnpm --filter @todo/app build
pnpm --filter @todo/app preview --host 127.0.0.1 --port 4173 --strictPort

# 另一个终端
node scripts/perf/benchmark.mjs --sizes=100,1000,10000,100000 --iterations=2
node scripts/perf/check-budget.mjs artifacts/perf-100k-full.json
```

原始结果保存在 `artifacts/perf-100k-full.json`（git-ignored）。

## 实测结果

|  任务数 | 写入耗时 | IndexedDB 占用 | 冷重载到可交互 | 热重载 median | 列表查询 median | 搜索 median |     JS 堆 |
| ------: | -------: | -------------: | -------------: | ------------: | --------------: | ----------: | --------: |
|  10,000 |   0.57 s |       9.66 MiB |         174 ms |        175 ms |           76 ms |      101 ms |  9.63 MiB |
| 100,000 |   6.11 s |       96.3 MiB |       1,278 ms |      1,206 ms |          167 ms |      226 ms | 50.35 MiB |

10k 的冷重载是在已安装 Service Worker 的第二次测量中得到；首次安装缓存会额外增加
约 4 秒，这属于一次性浏览器安装成本，不是日常启动路径。

## 设计预算对照

| 指标                        |          设计预算 |                                  本次实测 | 结果        |
| --------------------------- | ----------------: | ----------------------------------------: | ----------- |
| PC 冷启动到可交互           |           ≤ 2.5 s | 10k: 174 ms / 100k: 1,278 ms（已安装 SW） | ✅ 达标     |
| 1 万任务本地清单查询（p95） |          ≤ 200 ms |                                     76 ms | ✅ 达标     |
| 搜索 1 万任务（p95）        |          ≤ 450 ms |                          101 ms（含防抖） | ✅ 达标     |
| 10 万任务列表首屏           |          ≤ 300 ms |                                    167 ms | ✅ 达标     |
| 10 万任务搜索               |          ≤ 500 ms |                                    226 ms | ✅ 达标     |
| 10 万任务热重载             |           ≤ 2.5 s |                                  1,206 ms | ✅ 达标     |
| 10 万任务滚动               |       目标 60 FPS |    未单独采样 FPS；虚拟列表只挂载约 18 行 | ⚠️ 未测 FPS |
| Web 首屏 JS gzip            |     尽量 ≤ 200 KB |                                 约 115 KB | ✅ 达标     |
| PC 安装包                   |      尽量 ≤ 15 MB |                    未测（本任务只做 Web） | ⏳ 未测     |
| Android APK / iOS IPA       | 尽量 ≤ 25 / 50 MB |                                      未测 | ⏳ 未测     |
| 桌面闲置 RSS                |     目标 ≤ 250 MB |                        未测（只测 JS 堆） | ⏳ 未测     |
| 移动内存占用                |     目标 ≤ 180 MB |                                      未测 | ⏳ 未测     |
| 同步增量                    | 100 ops / request |                未测（不在浏览器基准范围） | ⏳ 未测     |

## 已知限制

- 100k 全量加载依赖本机 IndexedDB 和内存；低端移动设备仍需单独压测。
- 尚未采样滚动 FPS；当前只验证虚拟列表可加载和低 DOM 数量。
- 没有真实 Android/iOS 设备，移动端冷启动和内存数字缺失。
- 云同步、Web Push 和共享清单的网络延迟不在本基准范围内。
