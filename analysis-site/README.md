# analysis-site

DeepSeek Harness 源码分析的静态站点：单个自包含的 `index.html`，无构建步骤、无外部资源请求。

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
