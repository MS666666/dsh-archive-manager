# 提交到 awesome-dsh-plugin 精选列表（PR 素材）

目标仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin （你的市场数据源 `awesome-dsh-plugin.com/plugins.json`）

操作：Fork → 在 `plugins.json` 加一条、在 `README.md`（或 `README.zh.md`）对应分类加一行 → Push → 提 PR。

---

## 1) plugins.json 条目

`plugins.json` 顶层结构为：

```json
{
  "updated": "...",
  "count": ...,
  "categories": { ... },
  "plugins": [ /* 在数组中加入下面这条 */ ]
}
```

在 `plugins` 数组里新增（字段对齐上方 RegistryPlugin 类型定义）：

```json
{
  "name": "dsh-archive-manager-plus",
  "owner": "MS666666",
  "url": "https://github.com/MS666666/dsh-archive-manager",
  "category": "archive",
  "description": {
    "en": "Archive manager for DSH Web: list archived sessions in Settings and truly delete them (log, archive marker, projection cache).",
    "zh": "归档管理：在设置页列出已归档会话，并提供真正的删除（会话日志、归档标记、投影缓存一并清理）。"
  },
  "npm": "dsh-archive-manager-plus",
  "install": "npm i dsh-archive-manager-plus",
  "added": "2026-08-22"
}
```

> 字段说明：
> - `category`：按仓库现有分类取名（归档/管理类；若仓库使用 `tools`、`utility` 等具体枚举，请用维护者现有分类名，不要自创）。从 `categories` 对象里挑一个最接近的。
> - `description`：Market 用 `Record<string,string>`，en/zh 两键即可（与 dshmarket 读取逻辑一致）。
> - `stars` / `downloads`：市场会实时补全，不需要你填。
> - `added`：当天日期。

---

## 2) README 表格行

在 `README.md` 对应分类小节加一行：

```markdown
- [dsh-archive-manager-plus](https://github.com/MS666666/dsh-archive-manager) - Archive manager for DSH Web: list archived sessions in the Settings page and truly delete them (log, archive marker, projection cache).
```

中文版 `README.zh.md` 对应分类加一行：

```markdown
- [dsh-archive-manager-plus](https://github.com/MS666666/dsh-archive-manager) - 归档管理：在设置页列出已归档会话，并提供真正的删除（会话日志、归档标记、投影缓存一并清理）。
```

---

## 3) PR 描述模板

```markdown
## 提交内容
新增插件：**dsh-archive-manager-plus**

- 仓库：https://github.com/MS666666/dsh-archive-manager
- npm：https://www.npmjs.com/package/dsh-archive-manager-plus
- 功能：在 DSH Web 设置页新增「归档管理」标签页，列出已归档会话并提供真正的删除（会话日志目录、workspace 记账、投影缓存一并清理）。
- Topic：仓库已打 `dsh-plugin` topic

## 改动
- `plugins.json`：新增 1 条 entry
- `README.md` / `README.zh.md`：归档管理分类新增 1 行

## 自检
- [x] 双半插件：`lib/`（host 路由）+ `client/`（settings.section 页面）
- [x] npm 已发布：dsh-archive-manager-plus@0.1.1（public）
- [x] 隐私：README 无真实路径/用户名
```

---

## 快捷入口

- awesome-dsh-plugin 仓库（Fork/PR）：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- 社区范例 PR（参考其 diff 结构）：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/102