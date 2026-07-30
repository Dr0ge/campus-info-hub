# 校园信息聚合器

> 本地运行的网页应用，通过 WeFlow API 监听微信群消息，AI 自动分类筛选有价值的信息并结构化展示。

## 功能

- **消息获取**：启动时回填 24h 历史消息，之后通过 SSE 实时监听新消息
- **AI 分类**：DeepSeek 自动将消息分为活动通知、社团招新、学术、二手、实习五类
- **语义去重**：同一条信息在多个群转发时自动合并，保留多来源标注
- **每日摘要**：每次同步后自动生成 24h 简报
- **原文上下文**：展开信息卡片可查看原文及附近消息
- **群聊筛选**：设置中自由选择监控哪些群聊
- **分类过滤**：设置中可选隐藏不需要的信息类型

## 快速开始

### 前置条件

- [Bun](https://bun.com) >= 1.3
- [WeFlow](https://opencli.info) 运行中，HTTP API 已开启
- DeepSeek API Key（环境变量 `DEEPSEEK_API_KEY`）

### 安装运行

```bash
cd campus-info-hub
bun install
```

双击 `start.bat` 或：

```bash
bun run index.ts
```

浏览器打开 `http://localhost:3000`

## 配置

通过项目根目录的 `.env` 文件配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEFLOW_API_TOKEN` | — | WeFlow HTTP API 访问令牌 |
| `WEFLOW_API_BASE` | `http://127.0.0.1:5031` | WeFlow API 地址 |
| `DEEPSEEK_API_KEY` | — | DeepSeek API Key（必填） |
| `DEEPSEEK_API_BASE` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `POLL_INTERVAL_SEC` | `300` | 轮询间隔（秒） |
| `SERVER_PORT` | `3000` | 服务端口 |
| `BATCH_MAX_COUNT` | `100` | 每批发送给 DeepSeek 的消息数 |
| `DEDUP_SIMILARITY_THRESHOLD` | `0.6` | 去重相似度阈值 |

## 项目结构

```
campus-info-hub/
├── index.ts                # 入口：启动回填 → SSE 监听 → 消息管道
├── start.bat               # 一键启动
├── .env                    # 密钥配置
├── src/
│   ├── config.ts           # 读 .env + 默认值
│   ├── db.ts               # SQLite 数据库操作
│   ├── server.ts           # Bun HTTP 服务 + JSON API
│   ├── normalize.ts        # 消息归一化 + 预过滤
│   ├── poller.ts           # REST 消息回填
│   ├── sse-client.ts       # SSE 实时监听 + 批处理缓冲
│   ├── classify.ts         # DeepSeek 分类引擎
│   ├── dedup.ts            # 语义去重（DeepSeek 判重）
│   └── summarize.ts        # 每日摘要生成
├── ui/
│   ├── index.html          # 桌面端页面
│   ├── app.js              # 前端逻辑
│   └── style.css           # 样式
└── tests/
    ├── normalize.test.ts
    └── dedup.test.ts
```

## 架构

```
WeFlow :5031
  ├─ SSE /api/v1/push/messages ──→ sse-client.ts (实时推送)
  └─ REST /api/v1/messages      ──→ poller.ts (启动回填)
                    ↓
              normalize.ts (统一 InternalMessage)
                    ↓
              pre-filter (撤回/空/短 → 丢弃)
                    ↓
              classify.ts → DeepSeek (并行分批)
                    ↓
              dedup.ts → DeepSeek 语义判重
                    ↓
              db.ts → SQLite 入库
                    ↓
              server.ts → Bun HTTP :3000
                    ↓
              ui/ → 桌面端网页
```

## 技术栈

- **运行时**: Bun + TypeScript
- **数据库**: SQLite (Bun 内置)
- **AI**: DeepSeek Chat API
- **前端**: 原生 HTML + CSS + JavaScript（无框架）
- **消息源**: WeFlow HTTP API
