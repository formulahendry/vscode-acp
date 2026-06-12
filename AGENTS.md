# AGENTS.md — vscode-acp 项目指南

## 项目概述

**vscode-acp** 是一个 VS Code 扩展，实现了 [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 客户端。
用户可以在 VS Code 内连接任何兼容 ACP 的 AI 编程 Agent（Claude Code、Hermes、Reasonix、Copilot 等）。

- **仓库**: `formulahendry/vscode-acp`（上游）
- **Fork**: `Henry-916/vscode-acp`（我们的 fork）
- **语言**: TypeScript
- **构建**: Webpack + tsconfig
- **测试**: `npm test`（VS Code Extension Host 测试）
- **Lint**: ESLint (`npm run lint`)

## 当前任务

### feat: Improved Diff Preview for ACP Agents

**目标**: 实现高质量的文件编辑 diff 预览，让 Agent 编辑文件时用户能实时看到变化。

**背景**:
- PR #37 (yes999zc) 提出了基础实现，但存在竞态条件、资源泄漏等问题
- 我们的方案借鉴 Cline 的架构（自定义 URI Scheme），适配 ACP 协议
- 不使用临时文件，不依赖 setTimeout

**分支**: `feat/improved-diff-preview`

## 项目结构

```
src/
├── extension.ts                    # 入口，注册所有 handler/provider
├── core/
│   ├── AcpClientImpl.ts           # ACP 协议客户端实现
│   ├── AgentManager.ts            # Agent 配置管理
│   ├── ConnectionManager.ts       # 连接生命周期
│   ├── SessionHistoryStore.ts     # 会话历史存储
│   └── SessionManager.ts          # 会话创建/恢复
├── handlers/
│   ├── FileSystemHandler.ts       # ACP 文件读写（readTextFile/writeTextFile）
│   ├── PermissionHandler.ts       # 权限请求处理
│   ├── SessionUpdateHandler.ts    # session/update 通知路由（关键！）
│   └── TerminalHandler.ts         # 终端命令执行
├── ui/
│   ├── ChatWebviewProvider.ts     # 聊天 WebView
│   ├── SessionTreeProvider.ts     # 侧边栏会话树
│   └── StatusBarManager.ts        # 状态栏
├── config/
│   ├── AgentConfig.ts             # Agent 配置
│   └── RegistryClient.ts          # Agent 注册表
└── utils/
    ├── Logger.ts                  # 日志
    ├── StreamAdapter.ts           # 流处理
    └── TelemetryManager.ts        # 遥测
```

## 关键架构：SessionUpdateHandler

所有 ACP `session/update` 通知都通过 `SessionUpdateHandler` 路由：

```typescript
// SessionUpdateHandler.ts
export type SessionUpdateListener = (update: SessionNotification) => void;

export class SessionUpdateHandler {
  private listeners: Set<SessionUpdateListener> = new Set();

  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

  handleUpdate(update: SessionNotification): void {
    for (const listener of this.listeners) {
      try { listener(update); } catch (e) { log(`Error: ${e}`); }
    }
  }

  dispose(): void { this.listeners.clear(); }
}
```

**我们的 DiffPreviewHandler 通过 `addListener` 注册，接收所有 tool_call 通知。**

## ACP 协议关键点

### tool_call 通知格式

```json
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call",       // 或 "tool_call_update"
      "toolCallId": "call_001",
      "title": "Editing configuration file",
      "kind": "edit",                      // read|edit|delete|move|search|execute|think|fetch|other
      "status": "pending",                 // pending|in_progress|completed|failed
      "locations": [{ "path": "/abs/path", "line": 42 }],
      "content": [{ "type": "diff", "path": "...", ... }],
      "rawInput": { ... }
    }
  }
}
```

### Status 枚举
- `pending` — 工具调用已创建，未开始执行
- `in_progress` — 正在执行
- `completed` — 执行完成
- `failed` — 执行失败

### Kind 枚举（与 diff 相关的）
- `edit` — 修改文件内容
- `delete` — 删除文件
- `move` — 移动/重命名文件
- `create` — 创建新文件（某些 agent 用 edit + 新文件路径）

### 文件路径提取优先级
1. `locations[].path` — 最可靠，ACP 规范推荐
2. `content[].path`（type=diff 时）— 有 diff 内容时
3. `rawInput` 递归扫描（key: path/file/filePath/filepath/filename/targetPath/sourcePath）
4. `title` 正则回退 — 最不可靠

## Diff 预览设计方案

### 核心架构（借鉴 Cline）

```
                    ┌─────────────────────┐
                    │  SessionUpdateHandler │
                    └──────────┬──────────┘
                               │ session/update
                    ┌──────────▼──────────┐
                    │  DiffPreviewHandler  │
                    │                      │
                    │  1. tool_call        │
                    │     pending/in_prog  │
                    │     → 同步快照旧内容  │
                    │     → 存入 URI Map   │
                    │     → 高亮编辑行     │
                    │                      │
                    │  2. tool_call_update  │
                    │     → 更新高亮位置   │
                    │                      │
                    │  3. tool_call         │
                    │     completed        │
                    │     → vscode.diff    │
                    │     → 清理状态       │
                    └─────────────────────┘
```

### 关键设计决策

**1. 自定义 URI Scheme（不用临时文件）**
```typescript
const DIFF_URI_SCHEME = 'acp-diff';

// 旧内容 base64 编码到 URI query 参数
function createOldContentUri(filePath: string, oldContent: string): vscode.Uri {
  const fileName = path.basename(filePath);
  return vscode.Uri.parse(`${DIFF_URI_SCHEME}:${fileName}`)
    .with({ query: Buffer.from(oldContent).toString('base64') });
}

// 注册 TextDocumentContentProvider 提供旧内容
class AcpDiffContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return Buffer.from(uri.query, 'base64').toString('utf-8');
  }
}
```

**2. 同步快照（无竞态）**
```typescript
// tool_call pending 时立即同步读取
// 优先从已打开的编辑器获取（可能有未保存内容）
// 回退到磁盘读取
function snapshotOldContent(filePath: string): string | undefined {
  const openDoc = vscode.workspace.textDocuments.find(
    doc => doc.uri.fsPath === filePath
  );
  if (openDoc) return openDoc.getText();

  try {
    const raw = fs.readFileSync(filePath);
    const encoding = detectEncoding(raw);
    return iconv.decode(raw, encoding);
  } catch {
    return undefined; // 新文件
  }
}
```

**3. 高亮编辑位置**
```typescript
// 编辑中的高亮装饰
const editDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});
```

**4. Diff 触发**
```typescript
// completed 时打开 diff 视图
const oldUri = createOldContentUri(filePath, oldContent);
const newUri = vscode.Uri.file(filePath);
await vscode.commands.executeCommand(
  'vscode.diff',
  oldUri,
  newUri,
  `${path.basename(filePath)}: Original ↔ Agent's Changes`
);
```

## 开发规范

### 代码风格
- TypeScript strict mode
- ESLint + Prettier
- 函数和变量用 camelCase
- 类和接口用 PascalCase
- 注释用英文（与上游保持一致）

### Git 提交规范
```
feat: add DiffPreviewHandler with custom URI scheme
fix: handle encoding detection for non-UTF-8 files
refactor: extract snapshot logic to separate method
test: add unit tests for AcpDiffContentProvider
docs: update AGENTS.md with ACP protocol details
```

### 构建和测试
```bash
npm install          # 安装依赖
npm run compile      # 编译
npm run lint         # Lint 检查
npm test             # 运行测试
npm run watch        # 监听模式（开发用）
npx vsce package     # 打包 VSIX
```

### 测试方法
1. `npm run compile` 确保无编译错误
2. 按 F5 启动 Extension Development Host
3. 连接一个 ACP Agent（如 Hermes: `hermes acp`）
4. 让 Agent 编辑文件，观察 diff 视图是否正确弹出
5. 检查：新建文件、修改文件、多文件编辑、编码特殊文件

## 已知限制

- `content` 中的 `diff` 类型依赖 Agent 实现，不是所有 Agent 都提供
- `rawInput` 结构因 Agent 而异，路径提取是启发式的
- 暂不支持流式 diff（只在 completed 后显示）— 后续可增强
- 暂不支持用户在 diff 视图中编辑后接受/拒绝 — 后续可增强

## 参考实现

### Cline (最佳实践)
- `apps/vscode/src/integrations/editor/DiffViewProvider.ts` — 抽象基类
- `apps/vscode/src/hosts/vscode/VscodeDiffViewProvider.ts` — VS Code 实现
- `apps/vscode/src/hosts/vscode/hostbridge/diff/openDiff.ts` — Diff 打开逻辑
- 关键：自定义 URI Scheme (`cline-diff:`)、流式更新、Decoration 控制器

### PR #37 (参考但不照搬)
- `src/handlers/DiffPreviewHandler.ts` — 基础实现（有竞态 bug）
- 可参考其 `isEditToolCall` 判断逻辑和 `extractFilePaths` 路径提取

## 参考链接

- [ACP 协议规范 - Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [ACP SDK (npm)](https://www.npmjs.com/package/@agentclientprotocol/sdk)
- [VS Code Diff API](https://code.visualstudio.com/api/references/vscode-api#commands.executeCommand)
- [Cline 源码](https://github.com/cline/cline)
- [PR #37](https://github.com/formulahendry/vscode-acp/pull/37)
