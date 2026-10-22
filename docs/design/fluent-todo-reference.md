# Microsoft To Do 视觉参考

本次 Fluent 皮肤按 Microsoft To Do Web 的浅色主题对齐，参考了用户提供的 2516×1252 截图，并对截图做像素采样。

## 采样色板

| 区域                 | 色值      | 用途                  |
| -------------------- | --------- | --------------------- |
| 顶栏                 | `#2564CF` | 品牌蓝、顶栏、主按钮  |
| 页面画布             | `#FAF9F8` | 主内容区背景          |
| 侧栏/任务卡/详情面板 | `#FFFFFF` | 导航、列表、详情表面  |
| 选中导航             | `#EFF6FC` | 当前智能清单/清单底色 |
| 主文字               | `#292827` | 标题、任务标题        |
| 次级文字             | `#605E5C` | 日期、元信息          |
| 弱文字               | `#8A8886` | 占位、辅助说明        |
| 分隔线               | `#EDEBE9` | 任务行、详情分区      |

## 对应实现

- `apps/app/src/fluent.css` 中的 `--accent`、`--bg-canvas`、`--bg-sidebar`、`--bg-active`、`--border-subtle`。
- 顶栏结构在 `apps/app/src/App.tsx`：全宽蓝色栏、左侧品牌、居中搜索、右侧设置/帮助/账号。
- 侧栏选中项使用浅蓝底，不使用阴影；任务列表使用白色卡片 + 细分隔线。
- 移动端顶栏固定四列：菜单、品牌、搜索、账号，避免操作按钮换行覆盖内容。

## 在线素材

- Microsoft To Do 官方入口：https://todo.microsoft.com
- Microsoft Fluent 2 Design：https://fluent2.microsoft.design/
- DrWindows 对 To Do Web 新设计的报道：https://www.drwindows.de/news/web-version-von-microsoft-to-do-mit-frischem-design
- Design Atlas Microsoft 风格参考：https://geoffreymanda.github.io/design-atlas/styles/microsoft.html

> 像素色值以用户提供的截图采样为准；在线页面会随 Microsoft 版本更新而变化。
