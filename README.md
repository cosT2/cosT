# 六级网站：云端部署

目标：少量用户；题库固定；公网上直接使用；账号与记录保存在独立 PostgreSQL 数据库。

## 当前状态

代码支持 DATABASE_URL 自动选择 PostgreSQL；不配置时本地开发继续使用 SQLite。
生产环境拒绝退回临时 SQLite。18 张关系表及状态版本冲突保护保留。
当前媒体通过已部署的只读 Worker 提供，R2 桶保持私有。后台无需配置上传密钥。
注册账号为 8–32 位英文字母/数字，密码为 8–128 位，前端要求再次确认密码。
登录兼容原有至少 6 位密码的本地账号。当前没有邮箱验证或自助找回密码。
此文件不是上线成功证明；实际 Neon、Render、R2 必须单独验收。

## 注册准备（由用户完成）

1. 注册 https://neon.com/ ，创建 Free 项目，选择与后台尽量接近的区域。复制 PostgreSQL 连接串（带 SSL 配置），不要提交到 GitHub。
2. 注册 https://dash.cloudflare.com/ ，开通 R2（Standard）。如要求付款验证，用户自行处理，不能承诺永不收费。创建私有桶 cet6-resources。
3. 现有 57 个 MP3 已完成上传并提供公开只读播放，无需再次创建密钥。未上传的原卷文件不提供失效下载按钮，网页结构化题目和解析保留。
4. 注册 https://dashboard.render.com/ ，连接 cosT2/cosT 仓库。

## 上传及配置

将云端部署包内容上传到现有仓库（保留根 index.html 为 Pages 预览），不能上传 data/、.env、旧会话和日志。
Render 创建 Web Service，选择 Docker、Free，健康检查 /api/health。
Environment 设置 NODE_ENV=production、CET6_HOST=0.0.0.0、DATABASE_URL，以及 CET6_MEDIA_ORIGIN=https://cet6-media.simplesincost.workers.dev。
DATABASE_URL 由用户在 Render 的 Environment 中填写现有 Neon 数据库的连接串，不发送聊天，不写公开仓库。
前端和后端由同一个 Render 网站地址提供；不能把 GitHub Pages 的静态入口直接换成需要后台的登录页面。
服务器自动读取平台 PORT。最终网址确定后设置 CET6_ORIGIN=https://实际服务.onrender.com（无末尾斜杠）。
R2 上传必须保留 catalog.items[].relativePath 的目录名；优先保持原文件路径，不上传个人数据。
需要浏览器下载缓存时配置 R2 CORS：只允许正式网站 Origin；GET/HEAD；Range；Expose Accept-Ranges、Content-Range、Content-Length、Content-Type、ETag。

## 使用及费用限制

Render Free 闲置会休眠。账号数据在 Neon，不能写在 Render 本地临时盘。
R2 具有用量计费；查看存储、请求额度并设用量通知，不保证通知等同硬性费用上限。
本机数据不会自动复制到线上；已有用户可以导出备份并在同一线上账号导入。密码与原会话不经前端导出。
当前内容是否允许公开再发布应按实际使用条件处理；公开可获取不等于授权。

## 上线验收

- 两个测试账号互相隔离；密码不明文入库。
- 保存已背会、下一个、草稿、题目选项、日历、笔记后关闭浏览器重开恢复。
- 修改记录后重部署后台，再登录确认不丢失。
- 同版本并发写入只能有一个成功，另一个返回 409。
- 未登录的题库、资源接口返回 401；源码与密钥路径返回 404。
- HTTP 跨站写入拒绝；生产 Cookie Secure/HttpOnly/SameSite。
- 已部署的 MP3 播放/暂停/拖动、续播；正式账号网址的实际媒体访问。
- 导出和导入、账号备份；国内实际网络访问速度。

本地测试命令：npm ci；node scripts/verify-cloud-database.mjs；node scripts/verify-http.mjs。
PostgreSQL 本地验收使用 PGlite，不能当成 Neon 网络连接、远程重启和存储持久性验收。

## 2026-10-04 本轮验收

- 已完成注册确认密码、账号长度与格式校验、异步密码散列、恒定时间散列比较和退出前保存失败提示。
- 已把线上听力位置保存与暂停提示修复同步至账号前端，未替换当前 GitHub Pages 免登录入口。
- 隔离 HTTP 测试通过：注册、重复注册、非法账号/短密码、错误密码、登录退出、账号隔离、备份恢复、保存冲突、跨站写入拒绝、敏感路径 404、会话 HttpOnly/SameSite。
- 云媒体模式隔离 HTTP 测试通过：资料目录仅显示 57 个已部署 MP3，登录后的媒体请求跳转到只读 Worker，未上传资源返回 404。
- 本地 PostgreSQL 兼容测试通过 18 表结构、账号隔离、事务及版本冲突；真实 Neon 后台连接尚未验证。
- Render 登录页要求用户注册/登录；尚未创建账号服务、设置 DATABASE_URL 或发布新版。生产 Secure Cookie、真实公网注册、后台重新部署后的记录恢复尚未验收。
- 现有 GitHub Pages 学习记录仍仅保存在原浏览器；迁移须从原网站导出，再登录新版账号导入，不自动同步。
- 免费 Render 存在休眠和冷启动；不承诺全天候即时访问。源码包不是已上线服务。
