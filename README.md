# dsh-archive-manager-plus

> 归档管理：在设置页列出已归档会话，并提供真正的删除（会话日志、归档标记、投影缓存一并清理）。
>
> Archive manager: list archived sessions in the Settings page and delete them for real (session log, archive marker, and projection cache removed together).

[![npm](https://img.shields.io/npm/v/dsh-archive-manager-plus?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-archive-manager-plus)
[![GitHub](https://img.shields.io/badge/GitHub-MS666666%2Fdsh--archive--manager-181717?logo=github&logoColor=white)](https://github.com/MS666666/dsh-archive-manager)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![cover](docs/screenshot.png)

## 特性 / Features

- 设置页新增**「归档管理」**标签页（官方 `settings.section` slot 机制，与「通用」「模型」等同级）
- 列出所有**已归档会话**：标题、创建时间、日志是否仍在磁盘
- 每条右侧**删除按钮**，二次确认后**彻底删除**
- 安全设计：仅接受同源 POST、sessionId 严格校验、写后由 Node 自校验、失败自动回滚备份
- 跨 PowerShell 版本无 BOM 隐患（Windows PowerShell 5.1 与 PowerShell 7 行为一致）

## 背景 / Why

DSH 的「归档会话」只是把会话从分组视图隐藏：`session.jsonl.zstd` 日志与记账**原样保留**，且官方 UI 没有删除入口。本插件补齐「真删除」能力——归档只是隐藏，需要真正清理磁盘时可以在这里完成。

## 工作原理 / How it works

双半插件（与官方插件生态一致的形态）：

| 半 | 位置 | 职责 |
|---|---|---|
| host 半 | `lib/` | 挂载两条 HTTP 路由：`GET /dsh-archive-manager-plus/list` 列出归档会话；`POST /dsh-archive-manager-plus/delete` 删除（会话目录 + workspace 记账 + 投影缓存） |
| 浏览器半 | `client/` | 注册 `settings.section` 页面，渲染列表 + 删除按钮（先 `confirm` 二次确认，再调用 host 路由） |

删除动作的落盘范围：

1. `workspace.json` 的 `global.archivedSessionIds` 移除该 id
2. 各 workspace 的 `sessionIds` 移除该 id
3. 删除 `<DSH_HOME>/sessions/<workspace-encoded>/<session-id>/` 目录
4. `session_projcache.json` 中该会话条目清除

> 不清理 `cost-meter/ledger.json`（费用流水属历史记录，予以保留）。

## 安装 / Install

### 方式一：npm（推荐，社区标准）

```powershell
npm install dsh-archive-manager-plus
```

npm 会把包装进当前项目/全局 node_modules；DSH 插件需要注册进 profile 的 bundle 层：

1. 在 `<profile>/package.json` 的 `dependencies` 加入：`"dsh-archive-manager-plus": "^0.1.0"`
2. 在 `dsh.profile.bundles` 尾部加入：`"dsh-archive-manager-plus"`
3. `npm install`（或 `pnpm install`）后在 profile 里确认包已落位，重启 DSH 并刷新页面

### 方式二：一键安装脚本（本地开发调试）

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本自定位插件根目录（可从任意位置运行），自动完成：白名单复制发布物 → 注册依赖与 bundle → Node 自校验（无 BOM / JSON 合法 / 条目齐全）→ 失败回滚备份。

| 参数 | 说明 |
|---|---|
| `-ProfileDir <path>` | 显式指定 profile 目录（优先于自动探测） |
| `-ProfileName <name>` | profile 名，默认 `web` |
| `-DSHHome <path>` | 指定 DSH home（默认取 `$env:DSH_HOME`，其次 `~/.dsh`） |
| `-DryRun` | 只预览，不写入 |
| `-SkipCopy` | 跳过复制，只更新 manifest |

```powershell
.\install.ps1 -DryRun                    # 预览
.\install.ps1 -DSHHome <your-dsh-home>   # 指定安装位置
```

### 方式三：手动

1. 复制 `lib/`、`client/`、`cordis.patch.yml`、`LICENSE`、`README.md`、`package.json` 到
   `<profile>/node_modules/dsh-archive-manager-plus/`
2. 在 `<profile>/package.json` 的 `dependencies` 加入：`"dsh-archive-manager-plus": "<version>"`
3. 在 `dsh.profile.bundles` 尾部加入：`"dsh-archive-manager-plus"`
4. 保存（务必 UTF-8 **无 BOM**）后重启 DSH，并刷新页面

> ⚠️ BOM 陷阱：`package.json` 若带 UTF-8 BOM 会导致 DSH 启动报 `Unexpected token '﻿'`。
> 推荐用 npm 安装或一键脚本（已内置无 BOM 写入与 Node 校验）。

## 使用 / Usage

1. 侧边栏任一会话行 `⋯` 菜单 → **归档会话**（归档 1–2 个会话备用）
2. 打开 **设置（齿轮）→ 归档管理**
3. 列表展示已归档会话：标题 / 创建时间 / 日志是否在盘
4. 点击右侧 **删除** → 确认 → 该项消失，磁盘日志一并清除

## 隐私与安全 / Privacy & Security

- 删除范围**仅限已归档会话**；运行中的会话不应执行删除（由调用方负责判断）
- 删除会移除磁盘日志文件与关联记账；**费用流水保留**
- 宿主内存态（如 `session.list` 残留行）在删除后到下次重连/刷新间可能短暂可见——文件与注册表层始终是一致且持久的
- 网关侧仅接受同源请求，sessionId 有严格的格式白名单（`session-` + 十六进制/连字符），杜绝路径穿越
- 本 README 中的路径均为**占位符**（`<DSH_HOME>`、`<profile>`…），请勿在 issue / 讨论中粘贴本机绝对路径、用户名或会话 id

## 开发 / Development

- 浏览器半为纯手写 CJS bundle（无构建步骤）：改 `client/client.js` 后刷新页面可见（HMR 生效）
- host 半为纯 ESM：改 `lib/` 后重启 DSH
- 版本号改动后重新运行 `install.ps1` 即可同步 manifest（无需改脚本）

### 发布新版本（npm）

1. 在 `package.json` 提升 `version`（遵循 [SemVer](https://semver.org/lang/zh-CN/)）
2. 本地验证：`node --check lib/*.js client/client.js` + `npm publish --dry-run`
3. 发布：`npm publish --registry=https://registry.npmjs.org/`
4. 生成新的 GitHub release / tag（`v<version>`），保持仓库与 npm 版本同步

## 许可 / License

[MIT](LICENSE)