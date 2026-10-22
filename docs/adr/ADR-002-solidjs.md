# ADR-002：UI 使用 SolidJS

- 状态：接受
- 日期：2026-10-21

## 决策

采用 SolidJS + TypeScript + Vite。组件直接编译为细粒度 DOM 更新，不需要虚拟 DOM；
适合长列表、低内存和短启动时间目标。

## 约束

- 业务状态不散落在组件中，统一经 `TaskService`。
- 仅使用 Kobalte 式的无样式可访问基础组件或自研小组件，不引入重量级 UI 套件。
- 图标按需从 Lucide 引入。
