# analysis-site

DeepSeek Harness 源码分析的静态站点，无构建步骤、无外部资源请求。

| 路径 | 内容 |
|---|---|
| `index.html` | 分析正文，单文件自包含 |
| `demo.html` | 会话回放播放器，按需 `fetch` 同源 JSON |
| `demo-data/` | 回放数据，由 `scripts/build-demo-data.mjs` 从仓库快照生成 |

两页共用同一套配色，值镜像自产品自身的主题 `packages/client/ui-theme/src/styles/design-platform.css`
（`--dsw-alias-*` 语义别名与 `deepseek-*` / `neutral-bluish-*` 色阶），因此与 DeepSeek Web UI 同源。
图表用色另经色觉安全校验：深色档取 `deepseek-450`，因为它是同时通过亮度带与对比度两项检查的官方色阶。

回放数据取自 `examples/headless-agent/tests/snapshots/<场景>/stream-json.expected.jsonl`——
仓库中提交的快照期望输出，由 `DSH_SNAPSHOT=record` 对真实 API 录制后作为 golden 供无密钥回放。
其中会话 id、工作目录、时间戳、系统提示词、工具 schema 与 token 计数已被规范化，故播放器不展示 token 数字。

重新生成回放数据：

```sh
node analysis-site/scripts/build-demo-data.mjs   # 从仓库根目录运行
```

`demo.html` 通过 `fetch` 读取同源 JSON，用 `file://` 直接打开会被浏览器拦截，本地预览须走 HTTP。

## 本地预览

```sh
npx http-server analysis-site -p 8080
```

## 部署到 Cloudflare Pages

### 方式一：命令行直传

```sh
export CLOUDFLARE_API_TOKEN=...     # 需要 "Cloudflare Pages: Edit" 权限
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler pages deploy analysis-site --project-name dsh-analysis --branch main
```

### 方式二：Cloudflare 控制台接 Git

Workers & Pages → Create → Pages → Connect to Git，选中本仓库后设置：

| 字段 | 值 |
|---|---|
| Production branch | 本站点所在分支 |
| Build command | 留空 |
| Build output directory | `analysis-site` |

之后每次推送自动发布，无需向外部交出 API token。
