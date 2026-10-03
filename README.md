# 英语六级复习工作台

入口文件是 index.html。此项目是 Node.js + SQLite 的完整应用，包含账号登录、学习记录、单词复习、学习日历和整套模拟。

## 运行

需要 Node.js 22.13 或更高版本，推荐 Node.js 24。没有第三方 npm 依赖。

Windows PowerShell，在仓库目录执行：

```powershell
$env:CET6_LIBRARY_ROOT = Join-Path (Get-Location) 'resources'
npm start
```

访问 http://127.0.0.1:5173/。不要用 file:// 打开 index.html。

Linux，在仓库目录执行：

```sh
CET6_LIBRARY_ROOT="$PWD/resources" CET6_DATA_ROOT="$PWD/data" CET6_HOST=0.0.0.0 CET6_PORT=8080 npm start
```

公网服务需要 HTTPS 反向代理，并把 data 放到持久化磁盘。用户数据库不能放到静态网站目录或 Git 仓库。升级时保留 data，定期备份数据库。

## Docker

```sh
docker build -t cet6-study-desk .
docker run -d --name cet6-study-desk -p 127.0.0.1:8080:8080 -v cet6-data:/app/data -v /absolute/path/to/resources:/app/resources:ro --restart unless-stopped cet6-study-desk
```

## 上传内容

本包含网页、后端源码及结构化题库。不会复制已有账号数据库、会话、日志或开发临时文件。约 7.7 GB 原始音频与 PDF 不随代码上传，需要单独复制到 resources 目录。原始资料缺失时，相应听力或资料功能不可用。

## GitHub Pages 限制

GitHub Pages 只托管静态 HTML/CSS/JS，不运行 server.mjs，也不提供 SQLite 数据库。仅开启 Pages 无法完成注册、登录、保存记录或题库接口。此仓库需要在支持 Node.js 和持久化存储的服务器运行，才能保持完整功能。
