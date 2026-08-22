# dsh-archive-manager

归档管理插件：在 Web 设置页新增「归档管理」标签页，列出所有已归档会话，每条右侧带删除按钮，点击后**彻底删除**该会话（会话日志文件、归档标记、投影缓存一并清理）。

> 背景：DSH 的归档只把会话从列表视图隐藏，`session.jsonl.zstd` 日志与记账原样保留，且官方 UI 没有删除入口。本插件补齐「真删除」能力。

## 结构（双半插件）

```
dsh-archive-manager/
├── package.json         # dsh.bundle.patch + dsh.client 元数据、exports
├── cordis.patch.yml     # 把插件插入 profile 层栈
├── lib/
│   ├── index.js         # host 半：注册 webServer 路由
│   └── routes.js        # /dsh-archive-manager/list + /delete
└── client/
    └── client.js        # 浏览器半：注册 settings.section「归档管理」页面
```

- **host 半**：`ctx.inject(['webServer'])` → `webServer.register({kind:'exact', ...})`，两条路由：
  - `GET  /dsh-archive-manager/list` — 读 `$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds`，配合 `session_projcache.json` 补标题/创建时间，检查磁盘日志是否存在
  - `POST /dsh-archive-manager/delete` — 仅同源 POST，sessionId 严格校验（`^session-[0-9a-fA-F-]+$`），然后：归档集合移除 → 各 workspace 的 `sessionIds` 移除 → 删除 `$DSH_HOME/sessions/<编码>/<session-id>/` → 清理投影缓存条目
- **浏览器半**：`settings.section`（`kind:"list"`）注册一页，section row 渲染列表 + 删除按钮，删除前 `confirm` 二次确认。

## 安装（web profile）

**推荐：一键安装脚本**（已自动处理 Windows PowerShell 5.1 的 BOM 陷阱）：

```powershell
powershell -ExecutionPolicy Bypass -File D:\deepseek-harness\dsh-archive-manager\install.ps1
```

脚本会：复制插件到 `profiles/web/node_modules/` → 在 `package.json` 注册依赖与 bundle → **用 Node 自校验写出的 JSON**（无 BOM、合法、条目齐全）后才报告成功；失败自动回滚备份（`package.json.dsh-archive-manager.bak`）。

> ⚠️ **BOM 陷阱（已修复）**：旧版脚本用 `Set-Content -Encoding UTF8`，在 Windows PowerShell 5.1 下会向 `package.json` 写入 UTF-8 BOM（`﻿`），Node 的 `JSON.parse` 拒绝它并导致 `dsh web` 启动即崩溃（`Unexpected token '﻿'`）。新脚本改用 .NET `WriteAllText` + `UTF8Encoding($false)`，两个 PowerShell 版本下均写出**无 BOM** 的 UTF-8。若手头的 `package.json` 已带 BOM，运行本脚本会顺带清掉并保留备份。

手动等价操作（若不用脚本，务必用无 BOM 的 UTF-8 保存）：

1. 把整个 `dsh-archive-manager` 目录复制到 `$DSH_HOME/profiles/web/node_modules/dsh-archive-manager/`。
2. 在 `$DSH_HOME/profiles/web/package.json` 的 `dependencies` 加：
   ```json
   "dsh-archive-manager": "0.1.0"
   ```
3. 在 `dsh.profile.bundles` 数组尾部加：
   ```json
   "dsh-archive-manager"
   ```
4. 保存后重启 `dsh web` 并刷新页面。建议保存后用 `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` 验证。

## 测试

1. 在 Web 侧边栏任一会话行 `⋯` 菜单选择「归档会话」，归档 1–2 个会话。
2. 打开 设置（齿轮）→「归档管理」：应列出刚归档的会话，显示标题/创建时间/日志是否在盘。
3. 点「删除」→ 确认 → 行消失。
4. 验证磁盘：`D:\deepseek-harness\.dsh\sessions\--D-deepseek-harness--\<session-id>\` 目录已删除，
   `storages/workspace.json` 的 `archivedSessionIds` 与各 workspace `sessionIds` 中不再含该 id。

## 说明与限制

- 删除只处理**已归档**会话；在删除前该会话不应处于运行中（运行中的删除由调用方负责）。
- 宿主内存态（如 `session.list` 的残留行）在删除后到下次重连/刷新间可能仍短暂可见——文件与注册表层是一致且持久的事实。
- 不清理 `storages/cost-meter/ledger.json`（费用流水为历史记录，保留）。

## 开发/重新构建

浏览器半是纯手写 CJS bundle（无构建步骤），直接改 `client/client.js` 后刷新即可（HMR 生效）。
host 半同为纯 ESM 源码，改 `lib/` 后重启 dsh web。