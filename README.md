# Aurora Console — 单文件个人导航站

一个零构建、单文件前端的个人导航站。毛玻璃质感、黑白灰度审美、支持深浅双主题，数据存 MySQL，服务端 Node.js + Express，页面之间通过 SSE 实时同步。

> **演示站**：[home.leich.cn](https://home.leich.cn) — 本项目线上实例，浏览器打开即用，手机 / 桌面自适应。

## 演示与联系

| 项目 | 地址 / 号码 |
|---|---|
| 在线演示 | [https://home.leich.cn](https://home.leich.cn) |
| QQ | 3542545505 |

![tech](https://img.shields.io/badge/frontend-%E5%8D%95%E6%96%87%E4%BB%B6HTML-blue) ![tech](https://img.shields.io/badge/backend-Node.js%20%2B%20Express-green) ![tech](https://img.shields.io/badge/db-MySQL-orange)

---

## 目录结构

```
home-nav/
├── web/                 # 前端（零依赖，单文件）
│   ├── index.html       # 全部前端代码：页面 + 样式 + 逻辑
│   ├── favicon.svg      # 主题自适应站点图标
│   ├── manifest.webmanifest
│   └── gen-icons.py     # PWA 图标生成脚本（Python + Pillow）
├── server/              # 后端
│   ├── server.js        # Express API（含图标聚合 / SSE / 健康探测）
│   └── package.json
└── sql/
    └── init.sql         # 数据库初始化脚本
```

## 功能一览

### 导航与浏览
- **分类分区**：自由增删分类，每个分类独立图标、排序、可隐藏、可折叠
- **站点卡片**：名称 / 链接 / 描述 / 图标 / 私密备注，支持置顶、隐藏、下线标记
- **自动健康探测**：服务端每 10 分钟 ping 全部站点，连续 3 次失败自动标灰「下线」（与手动下线标记互不覆盖）
- **图标自动获取**：服务端聚合图标源（DuckDuckGo → 站点声明 → favicon.ico），抓不到时前端显示内置 SVG 默认图标
- **站内搜索直达**：配置过的站点支持「在 XX 内搜索」直接跳转站内搜索结果页

### 交互
- **⌘K / Ctrl+K 命令面板**：全站模糊搜索、方向键选择、回车直达
- **`/` 聚焦搜索框**，**Ctrl+E** 直达后台编辑
- **右键 / 长按卡片**：打开、置顶、复制链接、编辑
- **拖拽排序**：后台站点 / 分类表格行直接拖动调整顺序
- **访问统计**：点击计数、最近访问、14 天趋势图

### 外观
- **深浅双主题**，默认浅色，跟随系统亦可手动切换
- 毛玻璃、卡片磁吸、光标光晕、滚动视差等氛围效果（`prefers-reduced-motion` 下自动关闭）
- PWA 可安装（manifest + 图标齐全）

### 数据与安全
- **全量数据存 MySQL**，前端 API 优先 + SSE 实时刷新，多设备打开看到同一份数据
- **后台登录**：密码换 HMAC token，修改密码后旧 token 自动失效
- **保存语义安全**：PUT 请求缺哪个字段就保留哪个字段，不会误清数据
- **访问记录**：本机 recent 与服务端合并，可一键清空（需鉴权）

## 快速开始

### 1. 准备数据库

```bash
mysql -u root -p < sql/init.sql
# 或手动执行 sql/init.sql 中的语句
```

### 2. 启动后端

```bash
cd server
npm install

# Linux / macOS
export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_USER=home_nav
export DB_PASSWORD='你的数据库密码'
export DB_NAME=home_nav
export PORT=6178
export BIND=127.0.0.1

npm start
```

Windows PowerShell 用 `$env:DB_PASSWORD='...'` 逐条设置。

启动后：
- API 服务：`http://127.0.0.1:6178`
- 健康检查：`http://127.0.0.1:6178/api/health`
- 默认管理员密码：`admin123`（**登录后台后请立即修改**）

### 3. 部署前端

`web/index.html` 是完整的单文件前端，放到任意静态服务器即可，只需保证页面通过同源的 `/api/` 路径访问到后端。

### 4. Nginx 反代示例

```nginx
server {
    listen 443 ssl;
    server_name nav.example.com;
    root /www/wwwroot/nav;          # web/ 目录内容放这里
    index index.html;

    location ^~ /api/ {
        proxy_pass http://127.0.0.1:6178;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        # SSE 实时推送必须关闭缓冲
        proxy_buffering off;
        proxy_read_timeout 24h;
    }
}
```

### 5. 进程守护（二选一）

```bash
# pm2
pm2 start server/server.js --name nav-api

# systemd
# /etc/systemd/system/nav-api.service
# [Service]
# WorkingDirectory=/opt/home-nav/server
# Environment=DB_PASSWORD=你的数据库密码
# ExecStart=/usr/bin/node server.js
# Restart=always
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `6178` | 监听端口 |
| `BIND` | `127.0.0.1` | 监听地址（建议仅本机，由 Nginx 对外） |
| `DB_HOST` | `127.0.0.1` | MySQL 地址 |
| `DB_PORT` | `3306` | MySQL 端口 |
| `DB_USER` | `home_nav` | 数据库用户 |
| `DB_PASSWORD` | 空 | **务必通过环境变量注入** |
| `DB_NAME` | `home_nav` | 数据库名 |

## API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/data` | 否 | 全量数据（settings 已剥离密码字段） |
| PUT | `/api/data` | 是 | 全量保存（缺字段不覆盖，防误清） |
| POST | `/api/login` | 否 | 密码换 token |
| GET | `/api/events` | 否 | SSE 实时推送（数据版本变更广播） |
| GET | `/api/favicon?url=` | 否 | 图标聚合（内存缓存 24h） |
| POST | `/api/pins` | 限流 | 保存钉选 |
| POST | `/api/visit` | 限流 | 记录站点访问 |
| DELETE | `/api/visit` | 是 | 清空访问记录 |
| GET | `/api/health` | 否 | 健康检查 + 运行状态 |

## 设计说明

- **为什么单文件前端**：零构建、零依赖，改完即上线；对个人项目来说维护成本最低
- **PUT 缺字段语义**：请求体带哪个 section 才替换哪个 section。历史上曾因默认值 `[]` 导致只保存钉选时把站点表清空，现为硬性保护
- **手动下线与自动探测分离**：`down`（手动）与 `auto_down`（探测）分列存储，API 层分离返回，前端合并展示——避免「全量保存」把探测结果固化成手动标记
- **图标兜底链**：手动 icon → 服务端聚合 → 内置 SVG 默认图标，保证任何站点都有体面的图标显示

## License

MIT
