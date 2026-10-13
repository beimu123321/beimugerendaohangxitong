'use strict'
/**
 * Aurora Console 导航站后端 API
 * - 数据源：MySQL（库 home_nav）
 * - 内容：categories / sites / settings / pins / recent 全部入库
 * - 实时：GET /api/events (SSE)，任何数据变更广播 version，前端收到后重新拉取
 * - 鉴权：POST /api/login 换 token（HMAC(当前管理员密码)），改密码后旧 token 自动失效
 *
 * 环境变量：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME / PORT / BIND
 */
const express = require('express')
const crypto = require('crypto')
const http = require('http')
const https = require('https')
const mysql = require('mysql2/promise')

const PORT = Number(process.env.PORT || 6178)
const BIND = process.env.BIND || '127.0.0.1'

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'home_nav',
  password: process.env.DB_PASSWORD || '', // 建议通过环境变量注入，不要写死在代码里
  database: process.env.DB_NAME || 'home_nav',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4_unicode_ci',
  timezone: '+08:00'
})

// ---------- 图标聚合：GET /api/favicon?url=<站点链接> ----------
// 背景：客户端直连取图标在国内网络下容易全部超时——第三方服务证书过期、
// 目标站自身证书不可信（混合内容/证书错误）。改为服务端代取后收敛为同源接口：
// DuckDuckGo → 站点自身 favicon.ico（容忍证书错误）→ http 直连；内存缓存，失败短缓存。
// 前端来源链简化为：手动 icon > /api/favicon > 内置 SVG 默认图标。
const iconCache = new Map() // hostname -> { ok, buf, type, ts }
const ICON_OK_TTL = 24 * 3600 * 1000
const ICON_FAIL_TTL = 10 * 60 * 1000
const ICON_MAX_BYTES = 1024 * 1024
const ICON_CACHE_MAX = 800
const iconRelaxAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true })

function isPrivateHost(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 127 || a === 0 || a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

function fetchBuffer(url, relaxTls, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch {
      return reject(new Error('bad url'))
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get(
      url,
      {
        agent: u.protocol === 'https:' && relaxTls ? iconRelaxAgent : undefined,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; home-nav-favicon/1.0)' },
        timeout: 5000
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
          res.resume()
          return resolve(fetchBuffer(new URL(res.headers.location, url).href, relaxTls, redirects + 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error('status ' + res.statusCode))
        }
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > ICON_MAX_BYTES) req.destroy(new Error('too large'))
          else chunks.push(c)
        })
        res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: String(res.headers['content-type'] || '') }))
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

// 魔术字嗅探：挡掉把 404 页/HTML 当图标返回的站点
function looksLikeImage(buf, type) {
  if (/^image\//i.test(type) && !/html|xml(?!.*svg)/i.test(type)) return true
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true // PNG
  if (buf.length >= 4 && buf.readUInt16BE(0) === 0 && buf.readUInt16BE(2) === 1) return true // ICO
  const head = buf.slice(0, 300).toString('latin1')
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return true
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true // JPEG
  if (head.trimStart().startsWith('<svg') || (head.trimStart().startsWith('<?xml') && head.includes('<svg'))) return true // SVG
  if (/^image\//i.test(type)) return true
  return false
}

// 从首页 HTML 中提取 <link rel="icon" href="...">（Halo 等自定义图标路径）
function extractIconUrl(html, baseUrl) {
  const re = /<link\b[^>]*>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const tag = m[0]
    if (!/rel=["'][^"']*\bicon\b[^"']*["']/i.test(tag) && !/rel=\b[^>\s]*\bicon\b/i.test(tag)) continue
    const h = tag.match(/href=["']([^"']+)["']/i)
    if (!h) continue
    try {
      return new URL(h[1], baseUrl).href
    } catch {
      /* 下一个 */
    }
  }
  return null
}

async function resolveIcon(hostname) {
  const now = Date.now()
  const hit = iconCache.get(hostname)
  if (hit && now - hit.ts < (hit.ok ? ICON_OK_TTL : ICON_FAIL_TTL)) return hit
  const home = `https://${hostname}/`
  const sources = [
    { url: `https://icons.duckduckgo.com/ip3/${hostname}.ico`, relaxTls: false },
    { url: home, relaxTls: true }, // 占位：下面单独解析首页找 link rel=icon
    { url: `https://${hostname}/favicon.ico`, relaxTls: true },
    { url: `http://${hostname}/favicon.ico`, relaxTls: false },
  ]
  for (const s of sources) {
    if (s.url === home) {
      // 首页声明式图标：先取 HTML，解析出真实图标地址再取图
      try {
        const page = await fetchBuffer(home, true)
        if (/text\/html/i.test(page.type)) {
          const iconUrl = extractIconUrl(page.buf.toString('utf8'), home)
          if (iconUrl) {
            const r = await fetchBuffer(iconUrl, true)
            if (looksLikeImage(r.buf, r.type)) {
              const entry = { ok: true, buf: r.buf, type: /^image\//i.test(r.type) ? r.type.split(';')[0] : 'image/x-icon', ts: Date.now() }
              iconCache.set(hostname, entry)
              return entry
            }
          }
        }
      } catch {
        /* 换下一来源 */
      }
      continue
    }
    try {
      const { buf, type } = await fetchBuffer(s.url, s.relaxTls)
      if (looksLikeImage(buf, type)) {
        const entry = { ok: true, buf, type: /^image\//i.test(type) ? type.split(';')[0] : 'image/x-icon', ts: Date.now() }
        iconCache.set(hostname, entry)
        return entry
      }
    } catch {
      /* 换下一来源 */
    }
  }
  iconCache.set(hostname, { ok: false, ts: Date.now() })
  if (iconCache.size > ICON_CACHE_MAX) {
    const it = iconCache.keys()
    for (let i = 0; i < 200; i++) {
      const k = it.next().value
      if (!k) break
      iconCache.delete(k)
    }
  }
  return iconCache.get(hostname)
}

// ---------- 首次启动种子数据（示例内容，登录后台即可修改删除） ----------
const DEFAULT_SETTINGS = {
  title: '我的导航',
  subtitle: '个人导航 · 常用站点一键直达',
  logoLetter: '航',
  footerText: '个人导航',
  searchEngine: 'bing',
  adminPassword: 'admin123', // 首次登录后请立即在后台修改
  allowRegister: false,
  contacts: { wechat: '', qq: '', taobao: '', email: '' },
  backgroundImage: ''
}

const DEFAULT_CATEGORIES = [
  { id: 'cat-common', name: '常用推荐', icon: 'Star', order: 0, hidden: false, createdAt: '2026-10-11' },
  { id: 'cat-dev', name: '开发工具', icon: 'Tools', order: 1, hidden: false, createdAt: '2026-10-11' },
  { id: 'cat-media', name: '影音娱乐', icon: 'VideoPlay', order: 2, hidden: false, createdAt: '2026-10-11' },
  { id: 'cat-reading', name: '学习阅读', icon: 'Reading', order: 3, hidden: false, createdAt: '2026-10-11' }
]

const DEFAULT_SITES = [
  { id: 's-github', name: 'GitHub', url: 'https://github.com', description: '全球最大代码托管平台', icon: '', categoryId: 'cat-common', order: 0, hidden: false, createdAt: '2026-10-11' },
  { id: 's-gitee', name: 'Gitee 码云', url: 'https://gitee.com', description: '国内代码托管平台', icon: '', categoryId: 'cat-common', order: 1, hidden: false, createdAt: '2026-10-11' },
  { id: 's-bilibili', name: '哔哩哔哩', url: 'https://www.bilibili.com', description: '视频弹幕网站', icon: '', categoryId: 'cat-media', order: 0, hidden: false, createdAt: '2026-10-11' },
  { id: 's-zhihu', name: '知乎', url: 'https://www.zhihu.com', description: '问答社区', icon: '', categoryId: 'cat-media', order: 1, hidden: false, createdAt: '2026-10-11' },
  { id: 's-mdn', name: 'MDN Web Docs', url: 'https://developer.mozilla.org', description: 'Web 技术权威文档', icon: '', categoryId: 'cat-dev', order: 0, hidden: false, createdAt: '2026-10-11' },
  { id: 's-stackoverflow', name: 'Stack Overflow', url: 'https://stackoverflow.com', description: '程序员问答社区', icon: '', categoryId: 'cat-dev', order: 1, hidden: false, createdAt: '2026-10-11' },
  { id: 's-juejin', name: '掘金', url: 'https://juejin.cn', description: '前端技术社区', icon: '', categoryId: 'cat-dev', order: 2, hidden: false, createdAt: '2026-10-11' },
  { id: 's-douban', name: '豆瓣读书', url: 'https://book.douban.com', description: '书籍评分与书评', icon: '', categoryId: 'cat-reading', order: 0, hidden: false, createdAt: '2026-10-11' }
]

// ---------- 工具 ----------
function getTokenFor(password) {
  return crypto.createHmac('sha256', 'nav-api-secret-v1').update(String(password)).digest('hex')
}

async function getVersion() {
  const [rows] = await pool.query("SELECT v FROM meta WHERE k='version'")
  return rows.length ? Number(rows[0].v) : 0
}

async function bumpVersion() {
  await pool.query("UPDATE meta SET v = v + 1 WHERE k='version'")
  return getVersion()
}

function publicSettings(s) {
  if (!s) return s
  const { adminPassword, ...rest } = s
  return rest
}

// SSE 客户端
const sseClients = new Set()
function broadcast(version) {
  const payload = `data: ${JSON.stringify({ type: 'update', version })}\n\n`
  for (const res of sseClients) {
    try { res.write(payload) } catch { sseClients.delete(res) }
  }
}

// 简单内存限流：免鉴权写接口，每 IP 每分钟 60 次
const rateMap = new Map()
function rateLimit(req, res, next) {
  const ip = req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  let entry = rateMap.get(ip)
  if (!entry || now - entry.start > 60000) {
    entry = { start: now, count: 0 }
    rateMap.set(ip, entry)
  }
  entry.count++
  if (entry.count > 60) return res.status(429).json({ error: 'too many requests' })
  next()
}
setInterval(() => {
  const now = Date.now()
  for (const [ip, e] of rateMap) if (now - e.start > 120000) rateMap.delete(ip)
}, 120000).unref()

async function getAdminPassword() {
  const [rows] = await pool.query('SELECT data FROM settings WHERE id=1')
  if (!rows.length) return DEFAULT_SETTINGS.adminPassword
  const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data
  return data.adminPassword || DEFAULT_SETTINGS.adminPassword
}

function auth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  getAdminPassword().then((pwd) => {
    if (!token || token !== getTokenFor(pwd)) return res.status(401).json({ error: 'unauthorized' })
    next()
  }).catch(() => res.status(500).json({ error: 'server error' }))
}

// ---------- 首次种子 ----------
async function seedIfEmpty() {
  const [s] = await pool.query('SELECT id FROM settings WHERE id=1')
  const [c] = await pool.query('SELECT COUNT(*) AS n FROM categories')
  const [st] = await pool.query('SELECT COUNT(*) AS n FROM sites')
  if (s.length && c[0].n > 0 && st[0].n > 0) return

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (!s.length) {
      await conn.query('INSERT INTO settings (id, data) VALUES (1, ?)', [JSON.stringify(DEFAULT_SETTINGS)])
    }
    if (c[0].n === 0) {
      for (const cat of DEFAULT_CATEGORIES) {
        await conn.query(
          'INSERT INTO categories (id, name, icon, sort, hidden, created_at) VALUES (?,?,?,?,?,?)',
          [cat.id, cat.name, cat.icon, cat.order, cat.hidden ? 1 : 0, cat.createdAt]
        )
      }
    }
    if (st[0].n === 0) {
      for (const site of DEFAULT_SITES) {
        await conn.query(
          'INSERT INTO sites (id, category_id, name, url, description, icon, sort, hidden, down, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [site.id, site.categoryId, site.name, site.url, site.description, site.icon, site.order, site.hidden ? 1 : 0, site.down ? 1 : 0, site.createdAt]
        )
      }
    }
    await conn.commit()
    console.log('[seed] 初始数据已写入')
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

// ---------- 应用 ----------
const app = express()
app.use(express.json({ limit: '2mb' }))

// 健康检查：带运行状态监控（uptime / db / 数据量 / 内存 / node 版本）
app.get('/api/health', async (_req, res) => {
  const out = { ok: true, ts: Date.now(), uptime: Math.round(process.uptime()) }
  try {
    const [c] = await pool.query('SELECT COUNT(*) AS n FROM categories')
    const [s] = await pool.query('SELECT COUNT(*) AS n FROM sites')
    const [st] = await pool.query('SELECT COUNT(*) AS n FROM settings')
    out.db = 'ok'
    out.counts = { categories: c[0].n, sites: s[0].n, settings: st[0].n }
  } catch (e) {
    out.db = 'error'
  }
  const m = process.memoryUsage()
  out.memory = { rss: Math.round(m.rss / 1048576) + 'MB', heap: Math.round(m.heapUsed / 1048576) + 'MB' }
  out.node = process.version
  res.json(out)
})

// 图标聚合（公开，不走限流：首页多卡并发取图）
app.get('/api/favicon', async (req, res) => {
  const raw = String(req.query.url || '')
  let hostname = ''
  try {
    hostname = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname
  } catch {
    /* 空 */
  }
  if (!hostname || isPrivateHost(hostname)) return res.status(400).end()
  try {
    const icon = await resolveIcon(hostname)
    if (!icon.ok) return res.status(404).end()
    res.set({
      'Content-Type': icon.type,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    })
    res.send(icon.buf)
  } catch (e) {
    console.error('[GET /api/favicon]', e.message)
    res.status(502).end()
  }
})

// 全量数据（公开；settings 剥离密码）
app.get('/api/data', async (_req, res) => {
  try {
    const [cats] = await pool.query('SELECT id, name, icon, sort, hidden, created_at AS createdAt FROM categories ORDER BY sort ASC')
    const [sites] = await pool.query('SELECT id, name, url, description, icon, note, category_id AS categoryId, sort, hidden, down, auto_down, created_at AS createdAt FROM sites ORDER BY sort ASC')
    const [settingsRows] = await pool.query('SELECT data FROM settings WHERE id=1')
    const [kvRows] = await pool.query("SELECT k, v FROM kv WHERE k IN ('pins','recent')")
    const settings = settingsRows.length
      ? (typeof settingsRows[0].data === 'string' ? JSON.parse(settingsRows[0].data) : settingsRows[0].data)
      : DEFAULT_SETTINGS
    let pins = []
    let recent = {}
    for (const row of kvRows) {
      const val = typeof row.v === 'string' ? JSON.parse(row.v) : row.v
      if (row.k === 'pins') pins = Array.isArray(val) ? val : []
      if (row.k === 'recent') recent = val && typeof val === 'object' ? val : {}
    }
    const version = await getVersion()
    res.json({ version, categories: cats.map((c) => ({ ...c, hidden: !!c.hidden, order: c.sort, sort: undefined })), sites: sites.map((s) => ({ ...s, note: s.note || '', hidden: !!s.hidden, down: !!s.down, auto_down: !!s.auto_down, order: s.sort, sort: undefined })), settings: publicSettings(settings), pins, recent })
  } catch (e) {
    console.error('[GET /api/data]', e.message)
    res.status(500).json({ error: 'server error' })
  }
})

// 登录
app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body || {}
    const pwd = await getAdminPassword()
    if (!password || String(password) !== String(pwd)) return res.status(401).json({ ok: false, error: '密码错误' })
    res.json({ ok: true, token: getTokenFor(pwd) })
  } catch (e) {
    res.status(500).json({ error: 'server error' })
  }
})

// 全量保存（后台鉴权）：categories/sites/settings/pins/recent
// 语义：请求体带了某个字段才替换该 section；缺字段则原样保留
// （防止旧版用默认值 []，前端只发 pins 时把 categories/sites 整表清空）
app.put('/api/data', auth, async (req, res) => {
  const body = req.body || {}
  const categories = Array.isArray(body.categories) ? body.categories : null
  const sites = Array.isArray(body.sites) ? body.sites : null
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : null
  const pins = Array.isArray(body.pins) ? body.pins : null
  const recent = body.recent && typeof body.recent === 'object' ? body.recent : null
  if (!categories && !sites && !settings && !pins && !recent) {
    return res.status(400).json({ error: 'empty payload' })
  }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (categories) {
      await conn.query('DELETE FROM categories')
      for (const c of categories) {
        await conn.query(
          'INSERT INTO categories (id, name, icon, sort, hidden, created_at) VALUES (?,?,?,?,?,?)',
          [String(c.id).slice(0, 32), String(c.name || '').slice(0, 100), String(c.icon || 'Folder').slice(0, 50), Number(c.order) || 0, c.hidden ? 1 : 0, String(c.createdAt || '').slice(0, 20)]
        )
      }
    }
    if (sites) {
      await conn.query('DELETE FROM sites')
      for (const s of sites) {
        await conn.query(
          'INSERT INTO sites (id, category_id, name, url, description, icon, note, sort, hidden, down, auto_down, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [String(s.id).slice(0, 32), String(s.categoryId || '').slice(0, 32), String(s.name || '').slice(0, 100), String(s.url || '').slice(0, 500), String(s.description || '').slice(0, 500), String(s.icon || '').slice(0, 500), String(s.note || '').slice(0, 500), Number(s.order) || 0, s.hidden ? 1 : 0, s.down ? 1 : 0, s.auto_down ? 1 : 0, String(s.createdAt || '').slice(0, 20)]
        )
      }
    }
    // settings：管理员密码为空/缺失时保留旧密码
    if (settings && Object.keys(settings).length) {
      const oldPwd = await getAdminPassword()
      const incoming = { ...DEFAULT_SETTINGS, ...settings }
      if (!incoming.adminPassword) incoming.adminPassword = oldPwd
      await conn.query('INSERT INTO settings (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)', [JSON.stringify(incoming)])
    }
    if (pins) {
      await conn.query("INSERT INTO kv (k, v) VALUES ('pins', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(pins.map(String).slice(0, 200))])
    }
    if (recent) {
      await conn.query("INSERT INTO kv (k, v) VALUES ('recent', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(recent)])
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    console.error('[PUT /api/data]', e.message)
    return res.status(500).json({ error: 'server error' })
  } finally {
    conn.release()
  }
  const version = await bumpVersion()
  broadcast(version)
  res.json({ ok: true, version })
})

// 记录访问（免鉴权，限流）
app.post('/api/visit', rateLimit, async (req, res) => {
  try {
    const { id } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'bad id' })
    const [rows] = await pool.query("SELECT v FROM kv WHERE k='recent'")
    let recent = {}
    if (rows.length) {
      const v = typeof rows[0].v === 'string' ? JSON.parse(rows[0].v) : rows[0].v
      if (v && typeof v === 'object') recent = v
    }
    const cur = recent[id]
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) // YYYY-MM-DD
    const hist = (cur && cur.hist) || {}
    hist[today] = (Number(hist[today]) || 0) + 1
    recent[id] = { count: (cur && Number(cur.count) || 0) + 1, ts: Date.now(), hist }
    await pool.query("INSERT INTO kv (k, v) VALUES ('recent', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(recent)])
    const version = await bumpVersion()
    broadcast(version)
    res.json({ ok: true, version })
  } catch (e) {
    res.status(500).json({ error: 'server error' })
  }
})

// 清空访问记录（需鉴权）
app.delete('/api/visit', auth, async (req, res) => {
  try {
    await pool.query("INSERT INTO kv (k, v) VALUES ('recent', '{}') ON DUPLICATE KEY UPDATE v = VALUES(v)", ['{}'])
    const version = await bumpVersion()
    broadcast(version)
    res.json({ ok: true, version })
  } catch (e) {
    res.status(500).json({ error: 'server error' })
  }
})

// 钉选（免鉴权，限流）
app.post('/api/pins', rateLimit, async (req, res) => {
  try {
    const { pins } = req.body || {}
    if (!Array.isArray(pins)) return res.status(400).json({ error: 'bad pins' })
    await pool.query("INSERT INTO kv (k, v) VALUES ('pins', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(pins.map(String).slice(0, 200))])
    const version = await bumpVersion()
    broadcast(version)
    res.json({ ok: true, version })
  } catch (e) {
    res.status(500).json({ error: 'server error' })
  }
})

// SSE 实时推送
app.get('/api/events', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders()
  try {
    const v = await getVersion()
    res.write(`data: ${JSON.stringify({ type: 'hello', version: v })}\n\n`)
  } catch { res.write('data: {"type":"hello"}\n\n') }
  sseClients.add(res)
  const hb = setInterval(() => {
    try { res.write(': hb\n\n') } catch { /* noop */ }
  }, 25000)
  req.on('close', () => {
    clearInterval(hb)
    sseClients.delete(res)
  })
})

// 兜底错误
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err && err.message)
  res.status(500).json({ error: 'server error' })
})

// ---------- 自动健康探测：每 10 分钟串行 ping 全部站点 ----------
// 连续 3 次失败 → auto_down=1（前端合并显示「下线」）；成功 → auto_down=0。
// 只写 auto_down 列，不碰手动 down（后台「可用性」开关），两者互不覆盖。
const probeFails = new Map()
// 探测专用：容忍不可信证书（自签/域名不匹配是常态），8s 超时，任何 <500 的响应都算存活
function probeUrl(url) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve(false) }
    if (!/^https?:$/.test(u.protocol)) return resolve(false)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get(url, {
      agent: u.protocol === 'https:' ? iconRelaxAgent : undefined,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; home-nav-probe/1.0)' },
      timeout: 8000
    }, (res) => {
      res.resume()
      resolve(res.statusCode < 500)
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve(false) })
    req.on('error', () => resolve(false))
  })
}
async function probeSites() {
  let list = []
  try {
    ;[list] = await pool.query('SELECT id, url FROM sites')
  } catch (e) {
    console.error('[probe] db error', e.message)
    return
  }
  for (const s of list) {
    if (!s.url || !/^https?:\/\//i.test(s.url)) continue
    const okFlag = await probeUrl(s.url)
    const n = okFlag ? 0 : (probeFails.get(s.id) || 0) + 1
    if (okFlag) probeFails.delete(s.id)
    else probeFails.set(s.id, n)
    try {
      if (n >= 3) await pool.query('UPDATE sites SET auto_down=1 WHERE id=? AND auto_down=0', [s.id])
      else if (okFlag) await pool.query('UPDATE sites SET auto_down=0 WHERE id=? AND auto_down=1', [s.id])
    } catch (e) {
      console.error('[probe] update error', s.id, e.message)
    }
  }
  console.log('[probe] done,', list.length, 'sites @', new Date().toISOString())
}
setInterval(probeSites, 10 * 60 * 1000)
setTimeout(probeSites, 30 * 1000) // 启动 30s 后先跑一轮

async function main() {
  await seedIfEmpty()
  app.listen(PORT, BIND, () => {
    console.log(`[nav-api] listening on http://${BIND}:${PORT}`)
  })
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
