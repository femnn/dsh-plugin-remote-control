// Host 半片：/api/phone-remote 下的手机遥控接口（多设备 + 扫码/配对连接）。
//
// 这台机器（DSH 桌面端）通过局域网里的无线 adb 连手机；浏览器侧的右侧栏面板
// 只跟这里的同源路由说话，真正的 adb 调用全部在宿主里完成。
//
// 设计取舍：
// - 只用 node 内置模块 + 系统 python3(cv2) 解二维码，不引入 @deepseek-ai 依赖。
// - adb 路径优先读插件 config.adbPath，其次逐个探测常见位置。
// - 上传大文件流式落盘，避免读进内存。
// - 多设备：维护 active 序列；各操作默认作用于 active，也可显式指定 device。
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as dnsPromises } from 'node:dns'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import httpMod from 'node:http'
import httpsMod from 'node:https'

const pexec = promisify(execFile)

export const name = 'dsh-phone-remote'
export const inject = ['webServer']

const PREFIX = '/api/phone-remote'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DEFAULTS = {
  adbPath: '',
  ffmpegPath: '',
  defaultTarget: '',
  downloadDir: '/sdcard/Download',
}

function ffmpegCandidates() {
  const home = homedir()
  return [
    join(home, '.local/bin/ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/Applications/Pinky.app/Contents/Helpers/ffmpeg',
  ]
}
let cachedFfmpeg = null
function resolveFfmpeg(config) {
  const explicit = config && typeof config.ffmpegPath === 'string' ? config.ffmpegPath.trim() : ''
  if (explicit && existsSync(explicit)) return explicit
  if (cachedFfmpeg && existsSync(cachedFfmpeg)) return cachedFfmpeg
  for (const candidate of ffmpegCandidates()) {
    if (existsSync(candidate)) { cachedFfmpeg = candidate; return candidate }
  }
  return ''
}

function adbCandidates() {
  const home = homedir()
  return [
    '/Users/kangkang/Documents/电视/tools/platform-tools/adb',
    '/Applications/Pinky.app/Contents/Helpers/adb',
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    join(home, 'Library/Android/sdk/platform-tools/adb'),
    join(home, 'Android/sdk/platform-tools/adb'),
  ]
}

let cachedAdb = null
function resolveAdb(config) {
  const explicit = config && typeof config.adbPath === 'string' ? config.adbPath.trim() : ''
  if (explicit) { try { if (statSync(explicit).isFile()) return explicit } catch { /* fall */ } }
  if (cachedAdb && existsSync(cachedAdb)) return cachedAdb
  for (const candidate of adbCandidates()) { try { if (statSync(candidate).isFile()) { cachedAdb = candidate; return candidate } } catch { /* next */ } }
  return null
}

function pythonCandidates() {
  return ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}
function ok(res, value) { json(res, 200, { ok: true, value }) }
function fail(res, status, error) { json(res, status, { ok: false, error: String(error) }) }

async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('请求体太大'), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('请求不是合法 JSON'), { status: 400 }) }
}

async function pipeBodyToFile(req, dir, filename) {
  const file = join(dir, filename)
  const ws = createWriteStream(file)
  let size = 0
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => { size += chunk.length })
    req.on('error', reject)
    ws.on('error', reject)
    ws.on('finish', resolve)
    req.pipe(ws)
  })
  return { file, size }
}

/** 本机 API 的来路校验：只接受回环来源或 Host 正好是监听地址，再叠加 sec-fetch-site / Origin。 */
function makeTrust(req, bindHost) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  const remote = req.socket?.remoteAddress
  const fromLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  let namesListener = false
  if (typeof bindHost === 'string' && bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
    try {
      const bare = bindHost.includes('%') ? bindHost.slice(0, bindHost.indexOf('%')) : bindHost
      namesListener = new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}`).hostname === hostUrl.hostname
    } catch { /* ignore */ }
  }
  if (!fromLoopback && !namesListener) return false
  if (!namesListener && hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/** 用系统 Bonjour(dns-sd) 抓取某服务类型的 zone 记录（持续输出，约 ms 毫秒后截断）。 */
function dnsSdZone(type, ms = 3500) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn('/usr/bin/dns-sd', ['-Z', type, 'local'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { resolve(''); return }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } resolve(out) }, ms)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', () => { clearTimeout(timer); resolve(out) })
    child.on('exit', () => { clearTimeout(timer); resolve(out) })
  })
}

/** 解析 dns-sd -Z 输出里的 SRV/TXT 记录 → Map<实例全名, {port, host, model, base}>。 */
function parseDnsSdZone(text) {
  const map = new Map()
  const ptrNames = new Map()
  for (const line of String(text || '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 6 && parts[1] === 'SRV') {
      const inst = parts[0]
      const port = Number(parts[4])
      const host = parts[5].replace(/\.$/, '')
      if (Number.isInteger(port) && port > 0) map.set(inst, { port, host, model: '', base: inst.split('._adb')[0] })
    } else if (parts.length >= 3 && parts[1] === 'TXT') {
      const inst = parts[0]
      const txt = parts.slice(2).join(' ')
      const nm = /name=([^"\s]+)/.exec(txt)
      const rec = map.get(inst)
      if (rec && nm) rec.model = nm[1]
    } else if (parts.length >= 3 && parts[1] === 'PTR') {
      // PTR 记录里的实例名常常就是用户看到的名字（电视的 AirPlay 就是）。
      const inst = parts[2]
      if (inst && inst !== '@' && inst !== 'lb._dns-sd._udp') ptrNames.set(inst, inst)
    }
  }
  // 电视/盒子等设备的 AirPlay 广播没有 TXT name=，只有 PTR 实例名，用它当显示名。
  for (const [inst, ptr] of ptrNames) {
    const rec = map.get(inst)
    if (!rec) continue
    if (!rec.model) {
      const raw = ptr.replace(/\._[a-z0-9-]+(?:\._tcp|\._udp)?(?:\.local)?$/i, '')
      const friendly = raw.replace(/\\032/g, ' ').replace(/\\\./g, '.').replace(/\(\d{1,3}(?:\.\d{1,3}){3}\)/g, '').trim()
      rec.model = friendly || rec.host
    }
  }
  return map
}

/**
 * 手机会为同一个 adb 实例广播多条记录（实例名带 \032(2) 之类的序号后缀），
 * 那是同一台设备的不同端口。归并成一条：按设备标识分组，保留端口最大的那条。
 */
function mergeDnsSdRecords(records) {
  const groups = new Map()
  for (const rec of records.values()) {
    // 'adb-10AF951GSG004PZ-hgdkhf\032(2)' → 'adb-10AF951GSG004PZ-hgdkhf'
    const id = String(rec.base || '').replace(/\\032\(\d+\)$/, '').replace(/\(\d+\)$/, '')
    const current = groups.get(id)
    if (!current || rec.port > current.port) groups.set(id, { ...rec, id })
    else if (rec.model && !current.model) groups.set(id, { ...current, model: rec.model })
  }
  return [...groups.values()]
}

/** 把 mDNS 主机名(Android-2.local)解析成 IPv4；失败就退回主机名本身。 */
async function resolveHostV4(host) {
  try {
    const r = await dnsPromises.lookup(host, { family: 4 })
    if (r && r.address) return r.address
  } catch { /* fall through */ }
  return host
}

/** 探测某 IP 的某个 TCP 端口是否开放（只连不写）。 */
function probePort(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let settled = false
    const done = (ok) => { if (settled) return; settled = true; try { sock.destroy() } catch { /* ignore */ } resolve(ok) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    try { sock.connect(port, ip) } catch { done(false) }
  })
}

/** 扫描某手机 IP 的高位端口，找出无线 adb 的连接端口（配对后 mDNS 抓不到时的兜底）。 */
async function scanAdbPorts(ip, { from = 30000, to = 50100, concurrency = 400, timeoutMs = 120, budgetMs = 9000 } = {}) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ''))) return []
  const open = []
  let next = from
  const start = Date.now()
  async function worker() {
    for (;;) {
      if (Date.now() - start > budgetMs) return
      const p = next
      next += 1
      if (p > to) return
      if (await probePort(ip, p, timeoutMs)) open.push(p)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return open.sort((a, b) => a - b)
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const bindHost = typeof ctx.webServer?.host === 'string' ? ctx.webServer.host : undefined
  /** 当前控制的目标序列。 */
  let active = typeof cfg.defaultTarget === 'string' && cfg.defaultTarget ? cfg.defaultTarget : null

  // 记住成功连过的地址：mDNS 停播时也能在「自动发现」里列出并重连。
  const STATE_DIR = join(homedir(), '.dsh', 'phone-remote')
  const STATE_FILE = join(STATE_DIR, 'known.json')
  const NAMES_FILE = join(STATE_DIR, 'names.json')
  const ROSTER_FILE = join(STATE_DIR, 'roster.json')
  let known = []
  try { const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')); if (Array.isArray(raw)) known = raw.filter((x) => typeof x === 'string') } catch { known = [] }
  let names = {}
  try { const raw = JSON.parse(readFileSync(NAMES_FILE, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) names = raw } catch { names = {} }
  // 设备名册：以「设备身份」为键保存名字，手机换了端口也认得出是哪台。
  // id 优先用 adb 的序列号，其次用 IP。
  let roster = {}
  const batteryCache = new Map()   // serial -> {at, val:{level,charging}}（15 秒缓存）
  const usableCache = new Map()    // serial -> {at, ok}（设备命令可用性短缓存）
  // 每台设备只允许一个串流：设备端的 screenrecord 只能有一个，
  // 多个会互相抢视频编码器 → 画面卡顿甚至设备卡死。
  const streamLocks = new Map()    // serial -> {owner, at}
  const bridgeServers = []         // 设备间转串流用的本地 HTTP 服务
  try { const raw = JSON.parse(readFileSync(ROSTER_FILE, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) roster = raw } catch { roster = {} }
  async function saveKnown() {
    try { await mkdir(STATE_DIR, { recursive: true }); await writeFile(STATE_FILE, JSON.stringify([...new Set(known)], null, 2)) } catch { /* ignore */ }
  }
  async function saveNames() {
    try { await mkdir(STATE_DIR, { recursive: true }); await writeFile(NAMES_FILE, JSON.stringify(names, null, 2)) } catch { /* ignore */ }
  }
  async function saveRoster() {
    try { await mkdir(STATE_DIR, { recursive: true }); await writeFile(ROSTER_FILE, JSON.stringify(roster, null, 2)) } catch { /* ignore */ }
  }
  /**
   * 设备的稳定身份。
   *
   * 手机用 mDNS 名字连 adb 时，序列号长这样：
   *   adb-10AF951GSG004PZ-hgdkhf._adb-tls-connect._tcp
   *   adb-10AF951GSG004PZ-hgdkhf (2)._adb-tls-connect._tcp
   * 同一台手机会有多个实例名（端口不同），所以必须剥掉 mDNS 后缀和序号，
   * 只保留 `adb-xxxxxxxx` 这一段，才是跨端口稳定的身份。
   * USB 连接时序列号没有这些后缀，原样使用即可。
   */
  function deviceKey(serial) {
    const text = String(serial || '').trim()
    if (!text) return ''
    if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) return text.split(':')[0]
    // mDNS 实例名：adb-<设备号>.<序号>._adb-tls-connect._tcp
    // 设备号本身可能含连字符（如 10AF951GSG004PZ-hgdkhf），所以不能用 [a-zA-Z0-9] 收紧。
    if (/^adb-/i.test(text)) {
      return text
        .replace(/\s*\(\d+\)/, '')              // 去掉实例序号 (2)
        .replace(/\._adb-tls-[a-z]+\._tcp$/i, '') // 去掉 mDNS 服务后缀
        .replace(/\s*$/, '')
    }
    return text.replace(/:\d+$/, '')
  }
  /** 判断设备类型：glasses / tv / tablet / phone，用于列表图标与操控面板适配。 */
  function deviceKind(d) {
    const s = `${(d && d.model) || ''} ${(d && d.name) || ''} ${(d && d.product) || ''}`.toLowerCase()
    if (/glasses|rg[_-]?glasses|rokid|yodaos|ar\s*lite|ar\s*studio/.test(s)) return 'glasses'
    if (/tv|电视|盒子|box|mitv|投影|projector/.test(s)) return 'tv'
    if (/pad|tablet|平板/.test(s)) return 'tablet'
    return 'phone'
  }
  /**
   * 名册里取设备的名字。
   * 按多种身份依次查，保证手机换端口、换 IP、换 mDNS 实例名后名字都还在：
   *   1) 稳定身份（adb-xxxxxxxx / IP）
   *   2) 已知 IP ↔ 稳定身份的映射
   *   3) 完整序列号（旧数据）
   */
  /**
   * 名册里取设备的名字。
   * 按多种身份依次查，保证手机换端口、换 IP、换 mDNS 实例名后名字都还在：
   *   1) 稳定身份（adb-xxxxxxxx / IP）
   *   2) 已知 IP ↔ 稳定身份的映射
   *   3) 完整序列号（旧数据）
   */
  function rosterName(serial, ip, model) {
    const key = deviceKey(serial)
    if (key) {
      const entry = roster[key]
      if (entry && entry.name) return entry.name
    }
    const address = String(ip || '').trim()
    if (address) {
      const byIp = roster[address]
      if (byIp && byIp.name) return byIp.name
    }
    // 设备换了 IP（DHCP 变化、换了 Wi-Fi）时，旧地址上的名字会失效。
    // 这时按机型在名册里找那台设备的名字，让名字跟着设备走。
    if (model) {
      for (const entry of Object.values(roster)) {
        if (entry.name && entry.model === model) return entry.name
      }
    }
    if (names[serial]) return names[serial]
    // 还没起过名字：先用机型当显示名（比内部标识友好）。
    return String(model || '').trim()
  }

  /**
   * 清理名册里的重复身份与过期条目。
   * 名册里可能有：
   *   - 设备身份键（adb-xxx / IP）
   *   - 该设备的 IP 别名（entry.key 指向身份）
   *   - 历史遗留的机型名键（认不出主人）
   * 只保留「能对上真实设备」的部分，别让设备列表出现幽灵行。
   */
  async function pruneRoster(liveKeys, liveIps) {
    const live = new Set(liveKeys)
    const ips = new Set(liveIps || [])
    let changed = false
    // 每台设备当前生效的 IP
    const currentIp = new Map()
    for (const [key, entry] of Object.entries(roster)) {
      if (!live.has(key)) continue
      if (entry.ip && !currentIp.has(key)) currentIp.set(key, entry.ip)
    }
    for (const [key, entry] of Object.entries(roster)) {
      const isIpAlias = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(key)
      const owner = entry.key || ''
      // 1) 过期 IP 别名：设备现在用的 IP 不是它 → 删掉。
      if (isIpAlias && owner && live.has(owner)) {
        const now = currentIp.get(owner)
        if (now && now !== key) { delete roster[key]; changed = true; continue }
      }
      // 2) 认不出主人的孤儿条目（没有 key 指向谁，也不在现役身份里）→ 删掉。
      //    历史遗留的机型名键（V2507A、IN2010）就属于这一类。
      if (!live.has(key) && !owner) {
        delete roster[key]
        changed = true
        continue
      }
      // 3) 指向已不存在的设备的别名 → 删掉。
      if (owner && !live.has(owner) && !live.has(key)) {
        delete roster[key]
        changed = true
        continue
      }
    }
    if (changed) await saveRoster()
  }
  async function rename(device, name) {
    const input = String(device || '').trim()
    if (!input) throw Object.assign(new Error('缺少设备'), { status: 400 })
    const clean = String(name || '').trim().slice(0, 40)
    // 输入可能是身份键、序列号或旧名字，先解析成真正的身份再改名。
    const serial = (await resolveDeviceIdentity(input)) || input
    const key = deviceKey(serial) || serial
    if (clean) {
      // 名字跟「设备身份」走：手机换了端口、换了 IP，名字也还在。
      const previous = roster[key] || {}
      roster[key] = { ...previous, name: clean, key, lastSerial: previous.lastSerial || serial, model: previous.model || '', ip: previous.ip || '', updatedAt: Date.now() }
      names[serial] = clean
      // 同一身份的其它别名同步这个名字
      for (const [otherKey, entry] of Object.entries(roster)) {
        if (otherKey === key) continue
        if (entry.key === key && entry.name !== clean) roster[otherKey] = { ...entry, name: clean }
      }
      // 清掉指向这台设备的旧键（历史遗留的别的写法），避免列表出现重复行。
      for (const otherKey of Object.keys(roster)) {
        if (otherKey === key) continue
        const entry = roster[otherKey]
        const sameDevice = entry.key === key
          || (entry.lastSerial && deviceKey(entry.lastSerial) === key)
          || (entry.ip && entry.ip === previous.ip && previous.ip)
        if (sameDevice) delete roster[otherKey]
      }
    } else {
      delete names[serial]
      if (key && roster[key]) { delete roster[key].name; roster[key].updatedAt = Date.now() }
    }
    await saveNames(); await saveRoster()
    return { device: key, serial, name: clean }
  }
  async function remember(addr) {
    if (!addr) return
    if (!known.includes(addr)) { known.push(addr); await saveKnown() }
  }
  /** 把一台设备的身份登记进名册：记住它最新的序列号和机型，名字不会丢。 */
  async function registerDevice(serial, model) {
    const key = deviceKey(serial)
    if (!key) return
    const previous = roster[key] || {}
    const name = previous.name || names[serial] || ''
    const ip = ipOfSerial(serial)
    roster[key] = {
      ...previous,
      name,
      lastSerial: serial,
      model: model || previous.model || '',
      // 记下当前 IP：设备换网络后名字仍能对上现在这台。
      ip: ip || previous.ip || '',
      updatedAt: Date.now(),
    }
    await saveRoster()
  }

  /**
   * 序列号里的 IP（如果是 IP:端口 形式）。
   * mDNS 名字（adb-xxx._adb-tls-connect._tcp）本身没有 IP，靠名册里记的映射找。
   */
  function ipOfSerial(serial) {
    const text = String(serial || '').trim()
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(text)
    return match ? match[1] : ''
  }

  /** Bonjour 广播里的「设备身份 → IP」对照（带缓存，短时间内不重复抓）。 */
  let mdnsIndexCache = { at: 0, map: new Map() }
  async function mdnsIpIndex() {
    const now = Date.now()
    if (now - mdnsIndexCache.at < 20000) return mdnsIndexCache.map
    const map = new Map()
    try {
      const zone = await dnsSdZone('_adb-tls-connect._tcp', 3000)
      for (const rec of mergeDnsSdRecords(parseDnsSdZone(zone))) {
        const ip = await resolveHostV4(rec.host)
        if (rec.id && ip) map.set(rec.id, ip)
      }
    } catch { /* ignore */ }
    mdnsIndexCache = { at: now, map }
    return map
  }

  async function adb(args, { timeout = 30000, encoding = 'utf8' } = {}) {
    const bin = resolveAdb(cfg)
    if (!bin) throw Object.assign(new Error('未找到 adb，可在插件配置里设置 adbPath'), { status: 500 })
    try {
      const { stdout, stderr } = await pexec(bin, args, { timeout, maxBuffer: 128 * 1024 * 1024, encoding })
      return { ok: true, stdout, stderr }
    } catch (error) {
      return { ok: false, stdout: error.stdout ?? '', stderr: String(error.stderr || error.message || ''), code: error.code, timedOut: error.killed === true || Boolean(error.signal) }
    }
  }
  const withTarget = (args, serial) => (serial ? ['-s', serial, ...args] : args)

  const ADB_STATES = ['device', 'offline', 'unauthorized', 'recovery', 'sideload', 'bootloader', 'host', 'connecting', 'authorizing']
  async function adbDevices() {
    const list = await adb(['devices', '-l'], { timeout: 8000 })
    if (!list.ok) return []
    return list.stdout.split('\n').slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
      // 序列号里可能带空格（mDNS 名字如 'adb-XXXX (2)._adb-tls-connect._tcp'），
      // 所以不能用空格直接切；要找到状态关键字的位置，把前面整段当序列号。
      const stateRe = new RegExp(`\\s(${ADB_STATES.join('|')})(?:\\s|$)`)
      const hit = stateRe.exec(line)
      let serial = ''
      let state = ''
      if (hit) {
        serial = line.slice(0, hit.index).trim()
        state = hit[1]
      } else {
        const parts = line.split(/\s+/)
        serial = parts[0] || ''
        state = parts[1] || ''
      }
      const model = /model:(\S+)/.exec(line)
      const product = /product:(\S+)/.exec(line)
      return { serial, state, model: model ? model[1] : '', product: product ? product[1] : '' }
    }).filter((d) => {
      if (!d.serial) return false
      if (d.state === 'device') return true
      // 离线条目只保留看起来像真实地址的（IP:端口 / mDNS 实例名），
      // 「机型名:端口」和扫描残留的「adb-xxx:3000N」不要进列表。
      if (/^adb-[^:]+:\d+$/.test(d.serial)) return false
      if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(d.serial)) return true
      if (/^adb-/i.test(d.serial)) return true
      return false
    })
  }

  /**
   * 清理 adb 里的僵尸传输。
   * 端口扫描会为每个「连不上的 IP:端口」留下一条 offline 传输，
   * 越积越多会把设备列表撑爆（曾出现 11 条 adb-xxx:3000N）。
   */
  async function pruneAdbTransports() {
    const list = await adb(['devices'], { timeout: 8000 })
    if (!list.ok) return 0
    // 序列号可能带空格（mDNS 名字），所以按状态关键字切，别按空格切。
    const stateRe = new RegExp(`\\s(${ADB_STATES.join('|')})(?:\\s|$)`)
    const junk = list.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((line) => {
      const hit = stateRe.exec(line)
      if (!hit) return null
      return { serial: line.slice(0, hit.index).trim(), state: hit[1] }
    }).filter((d) => d && d.serial && d.state === 'offline'
      // 「adb-xxx:30000」这类是端口扫描/连 127.0.0.1:5555 时留下的僵尸传输。
      && (/^adb-[^:]+:\d+$/.test(d.serial) || /^adb-[^\s]+ \(?\d*\)?\._adb-tls-[a-z]+\._tcp:\d+$/i.test(d.serial)))
    for (const d of junk) await adb(['disconnect', d.serial], { timeout: 4000 })
    return junk.length
  }
  async function usable(serial) {
    // 短时间内缓存结果，避免对已知连不通的重复 mDNS 传输反复等 6 秒。
    const now = Date.now()
    const c = usableCache.get(serial)
    if (c && now - c.at < (c.ok ? 5000 : 15000)) return c.ok
    const r = await adb(['-s', serial, 'shell', 'id'], { timeout: 6000 })
    const ok = r.ok && /uid=\d+/.test(r.stdout)
    usableCache.set(serial, { at: now, ok })
    return ok
  }

  async function connectCandidate(cand) {
    // 端口扫描时用「IP:端口」；mDNS 序列号不是可连地址，别拿它去 connect
    // （adb 会把每次尝试都记成一条传输，越积越多）。
    if (!/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(String(cand || ''))) {
      return { ok: false, output: `${cand}：不是 IP:端口 形式的可连接地址` }
    }
    const ip = String(cand).split(':')[0]
    // 先把这台机器上该 IP 的僵尸传输清干净：adb 里残留 offline 传输时，
    // `adb connect` 会直接报 "already connected" 而不再重连，必须先 disconnect。
    await dropStaleTransports(ip, cand)
    const timeout = 15000
    let result = await adb(['connect', cand], { timeout })
    let commandOutput = result.timedOut ? `adb connect 等待 ${timeout / 1000} 秒超时` : [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    let check = await adb(['-s', cand, 'get-state'], { timeout: 4000 })
    let online = check.ok && check.stdout.trim() === 'device'
    // adb 对同一 IP 可能同时留着多条传输；连不上就再清一次并重试。
    if (!online) {
      await dropStaleTransports(ip, cand, true)
      result = await adb(['connect', cand], { timeout })
      commandOutput = [commandOutput, result.timedOut ? `重试超时` : [result.stdout, result.stderr].filter(Boolean).join('\n').trim()].filter(Boolean).join('；')
      check = await adb(['-s', cand, 'get-state'], { timeout: 4000 })
      online = check.ok && check.stdout.trim() === 'device'
    }
    const shellOk = online && await usable(cand)
    const state = online ? (shellOk ? '可执行设备命令' : 'ADB 已在线，但设备命令未通过') : (check.stdout.trim() || check.stderr.trim() || '未获取到设备状态')
    return { ok: shellOk, output: `${commandOutput || 'adb connect 无输出'}；状态：${state}` }
  }

  /**
   * 清掉某个 IP 下残留的 offline 传输。
   * 电视/手机换 IP 或掉线后，adb 会一直留着 "IP:5555 offline" 的僵尸传输，
   * 此时 `adb connect` 会回答 "already connected" 并且永远连不上。
   */
  async function dropStaleTransports(ip, exact, force = false) {
    const list = await adb(['devices'], { timeout: 8000 })
    if (!list.ok) return 0
    const stateRe = new RegExp(`\\s(${ADB_STATES.join('|')})(?:\\s|$)`)
    const targets = list.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((line) => {
      const hit = stateRe.exec(line)
      if (!hit) return null
      return { serial: line.slice(0, hit.index).trim(), state: hit[1] }
    }).filter((d) => d && d.serial && d.serial.includes(':')
      && d.serial.split(':')[0] === ip
      && (force ? d.state !== 'device' : d.state === 'offline'))
    for (const d of targets) {
      if (exact && d.serial === exact && !force) {
        // 精确目标：无论状态先 disconnect 一次，确保 connect 能重新握手。
        await adb(['disconnect', d.serial], { timeout: 4000 })
      } else if (d.state !== 'device') {
        await adb(['disconnect', d.serial], { timeout: 4000 })
      }
    }
    return targets.length
  }
  /** 解析目标：显式 device > active > 第一台可用的网络设备。 */
  async function resolveTarget(device) {
    if (device) {
      // 显式指定设备时：先把「名字 / IP / 别名」解析成真实序列号，再做可用性检查，
      // 避免对纯 IP 或名字直接做 -s 探测（会白白超时 6 秒）。
      const raw = await adbDevices()
      let serial = null
      const direct = raw.find((d) => d.serial === device)
      if (direct) serial = direct.serial
      if (!serial) { try { serial = await resolveDeviceIdentity(device) } catch { /* ignore */ } }
      if (!serial && await usable(device)) serial = device
      if (serial) {
        if (await usable(serial)) { active = serial; return serial }
        // 同一台手机在 adb 里常有多个传输（重复 mDNS 实例，其中一个连不通）。
        // 当前选中的序列号不可用时，找同型号/同 product 的其它在线条目，挑能用的。
        const me = raw.find((d) => d.serial === serial)
        if (me && (me.model || me.product)) {
          const twins = raw.filter((d) => d.serial !== serial && d.state === 'device' && d.model === me.model && d.product === me.product)
          for (const t of twins) {
            if (await usable(t.serial)) { active = t.serial; return t.serial }
          }
        }
        // 明确点名了这台但当前连不上：报离线，绝不偷偷换成别的设备去操作。
        throw Object.assign(new Error(`设备「${device}」当前离线`), { status: 409 })
      }
      // 完全解析不到 → 也报错，避免误作用到别的设备。
      throw Object.assign(new Error(`找不到设备「${device}」`), { status: 404 })
    }
    if (active && await usable(active)) return active
    // 网络设备包括 mDNS 序列号（adb-xxx 形式），它们没有冒号，别漏掉。
    const ds = (await adbDevices()).filter((d) => d.state === 'device' && (d.serial.includes(':') || /^adb-/i.test(d.serial)))
    if (ds.length) { active = ds[0].serial; return active }
    return null
  }

  async function status() {
    const bin = resolveAdb(cfg)
    const raw = await adbDevices()
    // 没有有效 active 时，自动选中第一台在线设备，避免面板“明明连着却说没设备”。
    if (!active || !raw.some((d) => d.serial === active && d.state === 'device')) {
      const first = raw.find((d) => d.state === 'device')
      active = first ? first.serial : null
    }
    // 同一台手机在 adb 里可能有多个实例（mDNS 名字带序号、多个端口）。
    // 按稳定身份归并，只保留一条；在线的优先。
    // mDNS 序列号里没有 IP，用 Bonjour 广播把「设备身份 ↔ IP」对上，
    // 这样手机换 IP 后名字仍然认得出来。
    // 同一台手机在 adb 里可能有多个实例（mDNS 名字带序号、多个端口、IP 形式）。
    // 归并成一条：同一 IP 或同一身份 → 一台设备；在线的优先。
    // mDNS 序列号里没有 IP，用 Bonjour 广播把「设备身份 ↔ IP」对上，
    // 这样手机换 IP 后名字仍然认得出来。
    const ipById = await mdnsIpIndex()
    // 把每台在线设备登记进名册：记住当前 IP 和机型。
    // 设备换 IP 后，名字靠「机型」找回，@名字 才继续管用。
    for (const d of raw) {
      if (d.state !== 'device') continue
      const key = deviceKey(d.serial) || d.serial
      const ip = ipOfSerial(d.serial) || ipById.get(key) || (roster[key] && roster[key].ip) || ''
      if (!d.model && !ip) continue
      const existing = roster[key] || {}
      // 「名字就是机型名」说明这台其实还没真正命名过（是拿机型当显示名兜底），
      // 这种要当作未命名，好让同机型那台真名跟过来。
      const unnamed = !existing.name || existing.name === existing.model
      const needsUpdate = existing.model !== d.model || (ip && existing.ip !== ip) || (unnamed && !!d.model)
      if (!needsUpdate) continue
      // 同机型但地址不同 → 是同一台设备换了 IP，把名字带过去。
      // 名册里凡是这个机型的条目，只要带名字就用它（最新的优先）。
      const sameModel = Object.entries(roster)
        .filter(([k, e]) => k !== key && e.model === d.model && e.name && e.name !== e.model)
        .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      const carried = sameModel[0] ? sameModel[0][1].name : ''
      roster[key] = {
        ...existing,
        name: carried || existing.name || '',
        key: existing.key || key,
        lastSerial: d.serial,
        model: d.model || existing.model || '',
        ip: ip || existing.ip || '',
        updatedAt: Date.now(),
      }
    }
    await saveRoster()
    // 先算出每条记录归属的「组」：优先用身份，身份缺失时退回 IP。
    const groupOf = new Map()
    const groupByIp = new Map()
    for (const d of raw) {
      const key = deviceKey(d.serial) || d.serial
      const ip = ipOfSerial(d.serial) || ipById.get(key) || (roster[key] && roster[key].ip) || ''
      let group = key
      if (ip && groupByIp.has(ip)) group = groupByIp.get(ip)
      else if (ip) groupByIp.set(ip, group)
      groupOf.set(d.serial, { group, ip, key })
    }
    const byKey = new Map()
    for (const d of raw) {
      const info = groupOf.get(d.serial) || {}
      const key = info.group || deviceKey(d.serial) || d.serial
      const ip = info.ip || ''
      const existing = byKey.get(key)
      const entry = {
        key,
        serial: d.serial,
        state: d.state,
        model: d.model || '',
        name: rosterName(d.serial, ip, d.model),
        ip,
        online: d.state === 'device',
        active: d.serial === active,
      }
      if (!existing || (entry.online && !existing.online)) byKey.set(key, entry)
      else if (existing.ip && !entry.ip) existing.ip = entry.ip
    }
    for (const [key, entry] of Object.entries(roster)) {
      if (byKey.has(key)) continue
      // 纯 IP 的条目若是某台设备的别名，就不单独成行。
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(key) && entry.key && byKey.has(entry.key)) continue
      // 「身份:端口」这种是扫描时的临时产物，不是真实设备身份，直接忽略。
      if (/^adb-[^:]+:\d+$/.test(key)) continue
      // 名册里的「机型名」这类旧键（不是身份也不是 IP）也不该单独成行：
      // 它通常指向某个真实设备（entry.key / lastSerial 指向）。
      const owner = entry.key || deviceKey(entry.lastSerial || '')
      if (owner && byKey.has(owner)) continue
      if (owner && entry.lastSerial) {
        const hit = byKey.get(owner)
        if (hit) continue
      }
      // 名字跟某台在线设备重名（历史遗留的旧键）→ 不单独成行。
      if (entry.name && [...byKey.values()].some((d) => d.name === entry.name && d.online)) continue
      byKey.set(key, {
        key,
        serial: entry.lastSerial || key,
        state: 'offline',
        model: entry.model || '',
        name: entry.name || '',
        ip: entry.ip || '',
        online: false,
        active: false,
        lastSeen: entry.updatedAt || 0,
      })
    }
    const devicesAll = [...byKey.values()].sort((a, b) => Number(b.online) - Number(a.online) || String(a.name || a.key).localeCompare(String(b.name || b.key)))
    // 同一台设备换 IP 后，旧 IP 会留一条 offline、新 IP 一条 online，名字一样。
    // 只保留在线的那条，别让列表里出现两个「电视」。
    const onlineNames = new Set(devicesAll.filter((d) => d.online).map((d) => d.name).filter(Boolean))
    const devices = devicesAll.filter((d) => d.online || !(d.name && onlineNames.has(d.name)))
    // 把在线设备登记进名册（顺带记住机型与 IP，掉线后名字和机型仍在）。
    for (const d of devices) {
      if (!d.online) continue
      const key = d.key
      const previous = roster[key] || {}
      const name = previous.name || rosterName(d.serial, d.ip, d.model) || names[d.serial] || ''
      // 身份条目本身记住自己的 IP，这样任何一处都能反查。
      if (!previous.name || previous.lastSerial !== d.serial || (d.model && previous.model !== d.model) || previous.ip !== d.ip || previous.key !== key) {
        roster[key] = { ...previous, name, key, lastSerial: d.serial, model: d.model || previous.model || '', ip: d.ip || previous.ip || '', updatedAt: Date.now() }
        await saveRoster()
      }
      // 同时按 IP 记一份别名，IP 变了也能找回名字。
      if (d.ip && d.ip !== key) {
        const byIp = roster[d.ip] || {}
        if (byIp.name !== name || byIp.key !== key) {
          roster[d.ip] = { ...byIp, name, key, lastSerial: d.serial, model: d.model || byIp.model || '', ip: d.ip, updatedAt: Date.now() }
          await saveRoster()
        }
      }
    }
    // 归并同一台手机的多份身份，避免列表里出现重复行。
    await pruneRoster(devices.map((d) => d.key), devices.map((d) => d.ip).filter(Boolean))
    // 归并后重新算一次列表
    const merged = new Map()
    for (const d of devices) {
      const existing = merged.get(d.key)
      if (!existing || (d.online && !existing.online)) merged.set(d.key, d)
    }
    for (const [key, entry] of Object.entries(roster)) {
      if (merged.has(key)) continue
      // 别名条目（entry.key 指向真正的身份）不单独成行，跟着那台设备显示。
      const aliasOf = entry.key && entry.key !== key ? entry.key : ''
      if (aliasOf && merged.has(aliasOf)) continue
      // 自己就是身份、但同时还有一个 IP 别名指向它 → 以身份为准显示一条。
      const selfIsAlias = entry.key && entry.key === key && [...merged.keys()].some((k) => k !== key && roster[k] && roster[k].key === key)
      if (selfIsAlias) continue
      merged.set(key, {
        key,
        serial: entry.lastSerial || key,
        state: 'offline',
        model: entry.model || '',
        name: entry.name || entry.model || '',
        ip: entry.ip || '',
        online: false,
        active: false,
        lastSeen: entry.updatedAt || 0,
      })
    }
    const finalDevices = [...merged.values()].sort((a, b) => Number(b.online) - Number(a.online) || String(a.name || a.key).localeCompare(String(b.name || b.key)))
    // 给在线设备补电量（缓存 15 秒，避免每次 status 都跑 dumpsys battery）。
    const nowBat = Date.now()
    for (const d of finalDevices) {
      if (!d.online) continue
      const c = batteryCache.get(d.serial)
      if (c && nowBat - c.at < 15000) { d.battery = c.val; continue }
      try {
        const r = await adb(withTarget(['shell', 'dumpsys', 'battery'], d.serial), { timeout: 6000 })
        const s = r.stdout || ''
        const lvl = /(?:level|mLevel)\s*[:=]\s*(\d+)/i.exec(s)
        const charging = /(?:AC|USB|Wireless)\s+powered:\s*true/i.test(s)
        const val = lvl ? { level: Number(lvl[1]), charging } : null
        batteryCache.set(d.serial, { at: nowBat, val })
        d.battery = val
      } catch { /* ignore */ }
    }
    return { adbPath: bin, adbFound: Boolean(bin), devices: finalDevices.map((d) => ({ ...d, kind: deviceKind(d) })), active, notes: watchNotes(), keepAwake: [...watcher.keepAwake] }
  }

  async function discover() {
    const connect = []
    const pairing = []
    let raw = ''
    // 1) 首选系统 Bonjour(dns-sd)：adb 自带 mdns 在这台机上时有时无，dns-sd 稳得多。
    //    手机通常广播 _adb-tls-connect；电视/盒子广播传统的 _adb._tcp（端口 5555）。
    try {
      const [zConnect, zPairing, zLegacy] = await Promise.all([
        dnsSdZone('_adb-tls-connect._tcp', 3500),
        dnsSdZone('_adb-tls-pairing._tcp', 3500),
        dnsSdZone('_adb._tcp', 2500),
      ])
      raw = zConnect + '\n' + zPairing + '\n' + zLegacy
      for (const rec of mergeDnsSdRecords(parseDnsSdZone(zConnect))) {
        const ip = await resolveHostV4(rec.host)
        connect.push({ address: `${ip}:${rec.port}`, label: rec.model || rec.host, host: rec.host, id: rec.id })
      }
      for (const rec of mergeDnsSdRecords(parseDnsSdZone(zPairing))) {
        const ip = await resolveHostV4(rec.host)
        pairing.push({ address: `${ip}:${rec.port}`, label: rec.model || rec.base, host: rec.host, id: rec.id })
      }
      // 电视/盒子的 _adb._tcp 服务：直接作为可连接设备。
      for (const rec of mergeDnsSdRecords(parseDnsSdZone(zLegacy))) {
        const ip = await resolveHostV4(rec.host)
        connect.push({ address: `${ip}:${rec.port}`, label: rec.model || rec.host, host: rec.host, id: rec.id, legacy: true })
      }
    } catch { /* ignore */ }
    // Bonjour 可能只发现了其中一种服务，分别用 ADB 的发现结果补齐。
    if (!connect.length || !pairing.length) {
      const r = await adb(['mdns', 'services'], { timeout: 10000 })
      if (r.ok) {
        for (const line of r.stdout.split('\n')) {
          const m = /([0-9]{1,3}(?:\.[0-9]{1,3}){3}):(\d{2,5})/.exec(line)
          if (!m) continue
          const address = `${m[1]}:${m[2]}`
          if (/_adb-tls-connect\._tcp/.test(line)) connect.push({ address, label: m[1] })
          else if (/_adb-tls-pairing\._tcp/.test(line)) pairing.push({ address, label: (line.split('\t')[0] || '').trim() })
          // 电视/盒子的传统 _adb._tcp：作为可连接设备。
          else if (/_adb\._tcp/.test(line)) connect.push({ address, label: (line.split('\t')[0] || '').trim(), legacy: true })
        }
        raw += '\n' + r.stdout
      }
    }
    const dedupe = (arr) => { const seen = new Set(); return arr.filter((x) => seen.has(x.address) ? false : (seen.add(x.address), true)) }
    const devices = (await adbDevices()).map((d) => ({ ...d, active: d.serial === active }))
    // 「可连接设备」只列此刻真实可达的：mDNS 当前广播的 + adb 现在在线的。
    // 历史记录（known）不再混进来，避免同一台手机出现多条过期条目。
    const reachable = [...connect]
    for (const d of devices) if (d.state === 'device' && d.serial.includes(':') && !reachable.some((x) => x.address === d.serial)) reachable.push({ address: d.serial, label: (d.model || '') + ' · 已连接', connected: true })
    // 同一台手机可能有多个端口（Bonjour 广播的 + 已经在用的），按 IP 归并成一条。
    const byDevice = new Map()
    for (const item of reachable) {
      const ip = item.address.split(':')[0]
      const current = byDevice.get(ip)
      if (!current) { byDevice.set(ip, { ...item, ip, ports: [item.address] }); continue }
      current.ports.push(item.address)
      if (item.connected) { current.address = item.address; current.label = item.label; current.connected = true }
    }
    const mergedConnect = [...byDevice.values()].map((item) => ({
      address: item.address,
      label: item.label,
      ip: item.ip,
      ports: item.ports,
      connected: Boolean(item.connected),
    }))
    return { connect: mergedConnect, advertised: dedupe(connect), pairing: dedupe(pairing), raw, devices }
  }

  async function connect(address) {
    const bin = resolveAdb(cfg)
    if (!bin) throw Object.assign(new Error('未找到 adb'), { status: 500 })
    const explicit = address && String(address).trim()
    let candidates
    if (explicit) candidates = [explicit]
    else {
      const d = await discover()
      candidates = [...new Set([...d.devices.filter((i) => i.state === 'device' && i.serial.includes(':')).map((i) => i.serial), ...d.connect.map((i) => i.address)])]
      if (!candidates.length) throw Object.assign(new Error('没发现设备，请确认手机无线调试已开且同 Wi-Fi'), { status: 400 })
    }
    const errors = []
    for (const addr of candidates) {
      const res = await connectCandidate(addr)
      if (!res.ok) { errors.push(`${addr}: ${res.output || '连接失败'}`); continue }
      active = addr
      await remember(addr)
      const model = await adb(['-s', addr, 'shell', 'getprop', 'ro.product.model'], { timeout: 8000 })
      return { target: addr, model: model.ok ? model.stdout.trim() : '' }
    }
    throw Object.assign(new Error(explicit ? `已尝试连接 ${explicit}，但失败：${errors.join('；')}` : `发现 ${candidates.length} 个候选端口，都连不上：${errors.join('；')}`), { status: 400 })
  }

  /** 用配对码配对，然后自动找到连接端口并 adb connect。 */
  async function pair(address, code, connectionAddress) {
    const cleanAddr = String(address || '').trim()
    const cleanCode = String(code || '').replace(/\s+/g, '')
    const direct = String(connectionAddress || '').trim()
    const hostOf = (value) => value.slice(0, value.lastIndexOf(':'))
    const validAddress = (value) => {
      const match = /^(?:\[[\da-f:%]+\]|[\w.-]+):(\d{1,5})$/i.exec(value)
      return match && Number(match[1]) >= 1 && Number(match[1]) <= 65535
    }
    const diag = []
    if (!validAddress(cleanAddr) || !/^\d{6}$/.test(cleanCode)) throw Object.assign(new Error('请输入有效的配对地址和 6 位配对码'), { status: 400 })
    if (direct && (!validAddress(direct) || hostOf(direct) !== hostOf(cleanAddr) || direct === cleanAddr)) {
      throw Object.assign(new Error('连接地址应填写同一台手机「无线调试」主页面上的 IP 和端口'), { status: 400 })
    }
    diag.push('配对地址：' + cleanAddr)
    const r = await adb(['pair', cleanAddr, cleanCode], { timeout: 30000 })
    const out = r.timedOut ? 'adb pair 等待 30 秒超时' : [r.stdout, r.stderr].filter(Boolean).join('\n').trim().replaceAll(cleanCode, '******')
    diag.push('adb pair：' + (out || '(无输出)'))
    if (!/Successfully paired|Already paired/i.test(out)) {
      return { paired: false, connected: null, error: out || '配对失败（配对码可能已过期，请重新打开配对弹窗拿新码）', diag }
    }
    const ip = hostOf(cleanAddr)
    const attempted = new Set([cleanAddr])
    const tryAddresses = async (addresses) => {
      for (const candidate of addresses) {
        if (attempted.has(candidate)) continue
        attempted.add(candidate)
        const result = await connectCandidate(candidate)
        diag.push(`连接 ${candidate}：${result.output} ${result.ok ? '✓' : '×'}`)
        if (result.ok) return candidate
      }
      return null
    }
    let connected = null
    if (direct) {
      connected = await tryAddresses([direct])
    } else {
      const online = (await adbDevices()).filter((d) => d.state === 'device' && d.serial.startsWith(ip + ':'))
      connected = await tryAddresses(online.map((d) => d.serial))
    }
    if (!direct && !connected) {
      const discovery = await discover()
      const advertised = discovery.advertised.filter((d) => d.address.startsWith(ip + ':')).map((d) => d.address)
      diag.push('发现的连接地址：' + (advertised.join(', ') || '无'))
      connected = await tryAddresses(advertised)
    }
    if (!direct && !connected && !ip.startsWith('[')) {
      const ports = await scanAdbPorts(ip, { from: 30000, to: 65535, concurrency: 800, timeoutMs: 100, budgetMs: 9000 })
      diag.push('扫描时可建立 TCP 的端口：' + (ports.join(', ') || '无'))
      connected = await tryAddresses(ports.map((port) => `${ip}:${port}`))
      // 扫描会在 adb 里留下一堆连不上的传输，扫完清掉，免得设备列表被撑爆。
      await pruneAdbTransports()
    }    if (!connected) diag.push('配对已完成。可用手机「无线调试」主页当前显示的 IP 地址和端口直接连接。')
    if (connected) { active = connected; await remember(connected) }
    return { paired: true, connected, address: cleanAddr, output: out, diag }
  }

  async function disconnect(device) {
    const serial = device || active
    if (!serial) return { disconnected: false }
    await adb(['disconnect', serial], { timeout: 8000 })
    if (serial === active) active = null
    return { disconnected: true, target: serial }
  }

  /** 重连：先按原地址连；端口变了就扫该 IP 的高位端口再连。 */
  async function adbReset() {
    await adb(['kill-server'], { timeout: 8000 })
    await sleep(600)
    await adb(['start-server'], { timeout: 8000 })
    active = null
    return { reset: true, devices: (await adbDevices()).map((d) => ({ ...d, active: false, name: names[d.serial] || '' })) }
  }

  // ---- AIUI / Rokid 工程部署（调用官方 aix CLI，把本地工程装到眼镜做真机测试）----
  function resolveAix() {
    const cands = [join(homedir(), '.npm-global/bin/aix'), '/usr/local/bin/aix', '/opt/homebrew/bin/aix']
    for (const c of cands) { try { if (existsSync(c)) return c } catch { /* ignore */ } }
    return 'aix'
  }
  function runAix(args, timeout = 600000) {
    return new Promise((resolve) => {
      const adbBin = resolveAdb(cfg)
      const env = { ...process.env, PATH: `${dirname(adbBin)}:${join(homedir(), '.npm-global/bin')}:${process.env.PATH || ''}` }
      let out = ''; let err = ''
      let child
      try { child = spawn(resolveAix(), args, { env }) } catch (e) { return resolve({ ok: false, code: -1, stdout: '', stderr: String(e) }) }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, timeout)
      child.stdout && child.stdout.on('data', (d) => { out += d })
      child.stderr && child.stderr.on('data', (d) => { err += d })
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out, stderr: err }) })
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, stdout: out, stderr: String(e) }) })
    })
  }
  async function aixDeploy(payload) {
    const serial = await resolveTarget(payload.device)
    if (!serial) throw Object.assign(new Error('还没有连接眼镜'), { status: 409 })
    const action = String(payload.action || 'install')
    // 开启开发者模式不需要工程路径。
    if (action === 'set-dev') {
      const r = await runAix(['device', 'set-dev', '--serial', serial], 60000)
      return { ok: r.ok, action, serial, code: r.code, output: `${r.stdout || ''}${r.stderr || ''}`.trim() }
    }
    const input = String(payload.path || '').trim()
    if (!input) throw Object.assign(new Error('请填写本地 AIUI 工程目录或 .aix 文件路径'), { status: 400 })
    if (!existsSync(input)) throw Object.assign(new Error(`路径不存在：${input}`), { status: 400 })
    let args
    if (action === 'install') args = ['install', input, '--serial', serial]
    else if (action === 'launch') args = ['launch-page', input, ...(payload.page ? [String(payload.page)] : []), '--serial', serial]
    else if (action === 'show') args = ['show', input]
    else if (action === 'check') args = ['check', input]
    else throw Object.assign(new Error('不支持的操作'), { status: 400 })
    const r = await runAix(args)
    return { ok: r.ok, action, input, serial, code: r.code, output: `${r.stdout || ''}${r.stderr || ''}`.trim() }
  }
  async function aixDevice(payload) {
    const serial = await resolveTarget(payload.device)
    if (!serial) throw Object.assign(new Error('还没有连接眼镜'), { status: 409 })
    const r = await runAix(['device', '--serial', serial], 30000)
    return { ok: r.ok, serial, output: `${r.stdout || ''}${r.stderr || ''}`.trim() }
  }
  /** 弹出 macOS 原生选择框，让用户在电脑上直接浏览选文件/目录，返回绝对路径。 */
  function pickPath(kind) {
    return new Promise((resolve) => {
      const isFile = kind === 'file'
      const prompt = isFile ? '选择 AIUI 工程文件（.aix）' : '选择 AIUI 工程目录（含 app.json）'
      const script = isFile
        ? `POSIX path of (choose file with prompt "${prompt}")`
        : `POSIX path of (choose folder with prompt "${prompt}")`
      execFile('osascript', ['-e', script], { timeout: 180000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || err)
          const canceled = /cancel/i.test(msg) || /-128/.test(msg)
          return resolve({ ok: false, canceled, error: canceled ? '已取消' : msg.trim() })
        }
        resolve({ ok: true, path: String(stdout || '').trim().replace(/\/+$/, '') })
      })
    })
  }

  async function reconnect(device) {
    const serial = String(device || active || '').trim()
    if (!serial) throw Object.assign(new Error('缺少设备'), { status: 400 })
    // mDNS 序列号（adb-xxx）里没有 IP，必须从名册/Bonjour 里找真实 IP；
    // 直接 split(':') 会得到主机名，拿去扫端口既扫不到又会留下一堆僵尸传输。
    const key = deviceKey(serial)
    const ip = ipOfSerial(serial) || (roster[key] && roster[key].ip) || (await mdnsIpIndex()).get(key) || ''
    const errors = new Map()
    const tryReconnect = async (address) => {
      if (errors.has(address)) return null
      const result = await connectCandidate(address)
      if (!result.ok) { errors.set(address, result.output); return null }
      active = address
      await remember(address)
      return { connected: address }
    }
    const previous = await tryReconnect(serial)
    if (previous) return previous
    if (!ip) {
      throw Object.assign(new Error(`重连失败：找不到这台手机的局域网 IP（序列号 ${serial} 不是 IP:端口 形式）。请在「无线调试」主页看 IP 地址和端口，或点「重置 adb 服务」后重连。`), { status: 400 })
    }
    const discovery = await discover()
    for (const { address } of discovery.advertised) {
      if (!address.startsWith(`${ip}:`)) continue
      const result = await tryReconnect(address)
      if (result) return result
    }
    const ports = await scanAdbPorts(ip, { from: 30000, to: 65535, concurrency: 800, timeoutMs: 100, budgetMs: 9000 })
    for (const port of ports) {
      const result = await tryReconnect(`${ip}:${port}`)
      if (result) return result
    }
    // 扫描残留的僵尸传输清掉。
    await pruneAdbTransports()
    const detail = Array.from(errors, ([address, error]) => `${address}：${error}`).join('；')
    throw Object.assign(new Error(`重连失败：${detail}。请核对手机「无线调试」主页当前的连接地址。`), { status: 400 })
  }

  async function select(device) {
    if (!device) throw Object.assign(new Error('缺少设备序列号'), { status: 400 })
    if (!(await usable(device))) throw Object.assign(new Error(`设备 ${device} 不可用`), { status: 400 })
    active = device
    return { active }
  }

  // ---- 多设备并行：每台设备各自记住“这次要操作谁” ----
  /** 找出与某个设备身份对应的、当前在线的序列号。 */
  async function resolveDeviceIdentity(identity) {
    const text = String(identity || '').trim()
    if (!text) return null
    const raw = await adbDevices()
    // 直接就是序列号
    const direct = raw.find((d) => d.serial === text)
    if (direct) return direct.serial
    // 稳定身份（adb-xxxxxxxx / IP）
    const byKey = raw.find((d) => deviceKey(d.serial) === deviceKey(text))
    if (byKey) return byKey.serial
    // 名字：名册里按名字找，再按 IP 找
    for (const [key, entry] of Object.entries(roster)) {
      if (entry.name && entry.name === text) {
        const hit = raw.find((d) => (deviceKey(d.serial) === key || ipOfSerial(d.serial) === entry.ip || deviceKey(d.serial) === entry.key))
        // 优先返回在线的那台；名字在多条里出现（旧 IP + 新 IP）时别命中过期的。
        if (hit && hit.state === 'device') return hit.serial
      }
    }
    for (const [key, entry] of Object.entries(roster)) {
      if (entry.name && entry.name === text) {
        const hit = raw.find((d) => deviceKey(d.serial) === key || ipOfSerial(d.serial) === entry.ip || deviceKey(d.serial) === entry.key)
        if (hit) return hit.serial
        if (entry.model) {
          const sameModel = raw.find((d) => d.model === entry.model && d.state === 'device')
          if (sameModel) return sameModel.serial
        }
        if (entry.lastSerial) return entry.lastSerial
      }
    }
    // 名字可能登记在别的键下（例如先按序列号改名、后来才归并到身份键）
    for (const entry of Object.values(roster)) {
      if (entry.name && entry.name === text) {
        const hit = raw.find((d) => deviceKey(d.serial) === entry.key || ipOfSerial(d.serial) === entry.ip)
        if (hit) return hit.serial
        if (entry.lastSerial) return entry.lastSerial
      }
    }
    // 只有 IP
    const ip = ipOfSerial(text) || (text.includes(':') ? text.split(':')[0] : text)
    const byIp = raw.find((d) => ipOfSerial(d.serial) === ip)
    if (byIp) return byIp.serial
    // 名字里带空格时也允许用「去掉 @ 后的前缀」匹配
    const stripped = text.replace(/^@/, '').trim()
    if (stripped !== text) return await resolveDeviceIdentity(stripped)
    return null
  }

  // ---- 看护：掉线自动重连，并记录断开原因 ----
  const watcher = {
    timer: null,
    cleanup: null,
    running: false,
    lastSeen: new Map(),      // key -> {state, at}
    notes: new Map(),         // key -> {reason, at}
    reconnects: 0,
    keepAwake: new Set(),     // 需要防休眠的设备 serial
    lastWake: new Map(),      // serial -> at
    lastGlassesScan: 0,       // 上次扫眼镜的时间
  }
  function watchNote(key, reason) {
    watcher.notes.set(key, { reason, at: Date.now() })
  }
  function watchNotes() {
    return [...watcher.notes.entries()].map(([key, value]) => ({ key, reason: value.reason, at: value.at }))
  }

  async function watcherTick() {
    if (watcher.running) return
    watcher.running = true
    try {
      const raw = await adbDevices()
      for (const d of raw) {
        const key = deviceKey(d.serial) || d.serial
        const previous = watcher.lastSeen.get(key)
        if (previous && previous.state === 'device' && d.state !== 'device') {
          watchNote(key, d.state === 'offline'
            ? '连接断开（手机息屏、无线调试被系统关闭或网络切换，ADB 传输已失效）'
            : `连接断开（ADB 状态：${d.state}）`)
        }
        watcher.lastSeen.set(key, { state: d.state, at: Date.now() })
      }
      // 对曾经在线、现在掉线的设备，尝试自动连回。
      // 注意：只对「曾经在线过、序列号是 IP:端口」这种能直接连的做重连；
      // mDNS 序列号（adb-xxx）没有固定端口，连它只会留下一堆僵尸传输，
      // 那种情况交给用户点「重连」或重新配对。
      const offline = raw.filter((d) => d.state !== 'device' && /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(d.serial))
      for (const d of offline) {
        const key = deviceKey(d.serial) || d.serial
        const previous = watcher.lastSeen.get(key)
        if (!previous || previous.state === 'device') continue
        const age = Date.now() - (previous.at || 0)
        if (age < 8000) continue
        const result = await connectCandidate(d.serial)
        if (result.ok) {
          watcher.reconnects += 1
          watchNote(key, `已自动重连（${d.serial}）`)
          await remember(d.serial)
        }
      }
      // 设备换了 IP（网络切换、DHCP 变化）后，旧 IP 会一直离线。
      // 这里用 mDNS 重新问一次「这台设备现在在哪个 IP」，再连过去。
      await reconnectByMdns()
      // 眼镜走 adb tcpip 5555，不广播 mDNS：换网络后 IP 会变，得主动扫当前网段的 5555 找回。
      await reconnectGlasses()
      // 防休眠：对开启保活的设备，定期补一次「保持连接」，
      // 但**绝不再发 KEYCODE_WAKEUP**——唤醒键会触发人脸/指纹「智能解锁」，
      // 用户断开串流后手机还会自己亮、显示解锁成功，就是这里造成的。
      // 改成用 deviceidle 豁免 + 定期发一个无害的 get-state 探测保持 adb 通道活跃。
      const onlineNow = new Set(raw.filter((d) => d.state === 'device').map((d) => d.serial))
      for (const serial of watcher.keepAwake) {
        if (!onlineNow.has(serial)) continue
        const last = watcher.lastWake.get(serial) || 0
        if (Date.now() - last < 30000) continue
        watcher.lastWake.set(serial, Date.now())
        adb(withTarget(['shell', 'dumpsys', 'deviceidle', 'unforce', '>/dev/null 2>&1'], serial), { timeout: 6000 }).catch(() => {})
      }
    } catch { /* 看护失败不影响面板 */ } finally { watcher.running = false }
  }

  /**
   * 眼镜（Rokid）跨网络自动重连：眼镜经 adb tcpip 5555 连接，不广播 mDNS，
   * 换 WiFi/换网段后 IP 会变。这里记住「曾经连过的眼镜」，一旦它离线，
   * 就扫当前网段的 5555 端口，逐个 adb connect，用 model 认出眼镜并接管。
   */
  async function reconnectGlasses() {
    if (Date.now() - watcher.lastGlassesScan < 45000) return
    // 名册里有没有「眼镜」这个身份，以及它现在是否离线
    const hasGlasses = Object.values(roster).some((e) => /glasses|rg[_-]?glasses|rokid|yodaos/i.test(`${e.model || ''} ${e.name || ''}`))
    if (!hasGlasses) return
    const raw = await adbDevices()
    const onlineGlasses = raw.some((d) => d.state === 'device' && /glasses|rg[_-]?glasses|rokid|yodaos/i.test(d.model || ''))
    if (onlineGlasses) { watcher.lastGlassesScan = Date.now(); return }
    watcher.lastGlassesScan = Date.now()
    const myIp = localIp()
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(myIp)) return
    const prefix = myIp.split('.').slice(0, 3).join('.')
    // 并发探测本网段 :5555
    const probe = (ip) => new Promise((resolve) => {
      const s = net.connect({ host: ip, port: 5555 })
      const done = (ok) => { try { s.destroy() } catch { /* ignore */ } resolve(ok ? ip : null) }
      s.setTimeout(500)
      s.once('connect', () => done(true))
      s.once('timeout', () => done(false))
      s.once('error', () => done(false))
    })
    const ips = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`)
    const hits = (await Promise.all(ips.map(probe))).filter(Boolean)
    for (const ip of hits) {
      const addr = `${ip}:5555`
      if (raw.some((d) => d.serial === addr && d.state === 'device')) continue
      await adb(['connect', addr], { timeout: 8000 }).catch(() => {})
      const chk = await adb(['-s', addr, 'shell', 'getprop', 'ro.product.model'], { timeout: 6000 }).catch(() => null)
      const model = (chk && chk.stdout ? chk.stdout : '').trim()
      if (/glasses|rg[_-]?glasses|rokid|yodaos/i.test(model)) {
        watchNote(addr, `眼镜已重新连接（${model || 'glasses'} @ ${ip}）`)
        break
      } else if (chk && chk.ok) {
        // 不是眼镜的普通设备，不接管
        await adb(['disconnect', addr], { timeout: 4000 }).catch(() => {})
      }
    }
  }

  /**
   * 用 mDNS 找离线设备的新 IP 并连上。
   * 电视/盒子用 _adb._tcp 广播，手机用 _adb-tls-connect._tcp。
   * 只要设备开着 adb 广播，就能自己找回新地址，用户不用手动点。
   */
  async function reconnectByMdns() {
    const raw = await adbDevices()
    const online = new Set(raw.filter((d) => d.state === 'device').map((d) => d.serial))
    const onlineIps = new Set(raw.filter((d) => d.state === 'device').map((d) => d.serial.split(':')[0]))
    let zones = []
    try {
      zones = await Promise.all([
        dnsSdZone('_adb._tcp', 2000),
        dnsSdZone('_adb-tls-connect._tcp', 2000),
      ])
    } catch { return }
    for (const zone of zones) {
      for (const rec of mergeDnsSdRecords(parseDnsSdZone(zone))) {
        const ip = await resolveHostV4(rec.host)
        if (!ip || onlineIps.has(ip)) continue
        const address = `${ip}:${rec.port}`
        if (online.has(address)) continue
        const result = await connectCandidate(address)
        if (result.ok) {
          watcher.reconnects += 1
          watchNote(address, `已按 mDNS 广播自动连上（${rec.model || rec.host || ''} · ${address}）`)
          await remember(address)
          // 设备换了 IP 后，把旧名字带到新地址上，@名字 才继续管用。
          const model = await adb(withTarget(['shell', 'getprop', 'ro.product.model'], address), { timeout: 8000 })
          const modelName = model.ok ? model.stdout.trim() : ''
          if (modelName) {
            const old = Object.values(roster).find((e) => e.model === modelName && e.name)
            const key = deviceKey(address)
            if (key) {
              roster[key] = { ...(roster[key] || {}), name: old ? old.name : (roster[key] && roster[key].name) || '', model: modelName, lastSerial: address, ip: address.split(':')[0], updatedAt: Date.now() }
              await saveRoster()
            }
          }
          onlineIps.add(ip)
          online.add(address)
        }
      }
    }
  }

  function startWatcher() {
    if (watcher.timer) return
    watcher.timer = setInterval(() => { watcherTick().catch(() => {}) }, 6000)
    if (typeof watcher.timer.unref === 'function') watcher.timer.unref()
    // 定期清理 adb 里连不上的僵尸传输（端口扫描、以及别的插件连 127.0.0.1:5555 都会留下）。
    watcher.cleanup = setInterval(() => { pruneAdbTransports().catch(() => {}) }, 20000)
    if (typeof watcher.cleanup.unref === 'function') watcher.cleanup.unref()
  }
  function stopWatcher() {
    if (!watcher.timer) return
    clearInterval(watcher.timer)
    watcher.timer = null
    if (watcher.cleanup) { clearInterval(watcher.cleanup); watcher.cleanup = null }
  }
  startWatcher()

  async function shell(command, device) {
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接手机'), { status: 409 })
    const r = await adb(withTarget(['shell', command], t), { timeout: 30000 })
    return { stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), code: r.ok ? 0 : (r.code ?? 1), timedOut: Boolean(r.timedOut) }
  }

  /**
   * APK 安装任务：先传文件，再在后台跑 adb install，前端轮询进度。
   * adb install 不吐百分比，所以用「已用时间 / 预计总时长」估算，并配合阶段文字。
   */
  const installJobs = new Map()

  async function startInstall(req) {
    const device = req.headers['x-device'] ? String(req.headers['x-device']) : undefined
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接手机'), { status: 409 })
    const rawName = req.headers['x-filename']
    const filename = rawName ? decodeURIComponent(String(rawName)) : `app-${Date.now()}.apk`
    const jobId = `install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const job = {
      id: jobId,
      filename,
      device: t,
      phase: 'uploading',
      progress: 0,
      message: '正在上传到电脑临时目录…',
      done: false,
      ok: false,
      error: '',
      startedAt: Date.now(),
      bytes: 0,
    }
    installJobs.set(jobId, job)
    // 先把文件完整落盘，再回 jobId。
    // 不能在响应发出后才继续读 body —— 那样连接一断，上传就被截断成 0 字节。
    let tmp = ''
    try {
      tmp = await mkdtemp(join(tmpdir(), 'dsh-phone-install-'))
      const { file, size } = await pipeBodyToFile(req, tmp, filename.replace(/[/\\]/g, '_'))
      job.bytes = size
      job.phase = 'installing'
      job.progress = 5
      job.message = `已上传 ${(size / 1048576).toFixed(1)} MB，正在安装…`
      // 安装在后台跑，前端轮询 /install-status 看进度。
      ;(async () => {
        try {
          const r = await adb(withTarget(['install', '-r', file], t), { timeout: 600000 })
          const text = `${r.stdout || ''}${r.stderr || ''}`.trim()
          if (!r.ok || !/Success/i.test(text)) {
            job.ok = false
            job.error = text || '安装失败'
            job.message = '安装失败'
          } else {
            job.ok = true
            job.progress = 100
            job.message = '安装完成'
          }
        } catch (e) {
          job.ok = false
          job.error = String(e.message || e)
          job.message = '安装失败'
        } finally {
          job.done = true
          job.finishedAt = Date.now()
          if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
        }
      })()
    } catch (e) {
      job.ok = false
      job.done = true
      job.error = String(e.message || e)
      job.message = '上传失败'
      job.finishedAt = Date.now()
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
    return { jobId, filename, bytes: job.bytes }
  }

  /** 查询安装进度。 */
  function installStatus(jobId) {
    const job = installJobs.get(String(jobId || ''))
    if (!job) throw Object.assign(new Error('找不到这个安装任务'), { status: 404 })
    // 安装阶段没有真实百分比，用已用时间估算一个平滑的进度。
    if (job.phase === 'installing' && !job.done) {
      const elapsed = Date.now() - job.startedAt
      const estimate = Math.min(92, 5 + Math.round((elapsed / 60000) * 87))
      job.progress = Math.max(job.progress, estimate)
      job.message = `正在安装…（已用 ${Math.round(elapsed / 1000)} 秒）`
    }
    // 清理一小时前的旧任务
    const cutoff = Date.now() - 3600000
    for (const [id, item] of installJobs) if (item.finishedAt && item.finishedAt < cutoff) installJobs.delete(id)
    return { jobId: job.id, phase: job.phase, progress: job.progress, message: job.message, done: job.done, ok: job.ok, error: job.error, bytes: job.bytes, filename: job.filename, device: job.device }
  }

  async function upload(req) {
    const device = req.headers['x-device'] ? String(req.headers['x-device']) : undefined
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接手机'), { status: 409 })
    const rawName = req.headers['x-filename']
    const filename = rawName ? decodeURIComponent(String(rawName)) : `upload-${Date.now()}.bin`
    const destDir = req.headers['x-dest'] ? String(req.headers['x-dest']) : cfg.downloadDir
    // 是否安装由客户端显式通过 x-install 决定，绝不靠文件后缀猜测：
    // 「发送文件」传 x-install=0 时，即使是 .apk 也只 push 到手机存储、不安装。
    const install = String(req.headers['x-install'] || '') === '1'
    const tmp = await mkdtemp(join(tmpdir(), 'dsh-phone-'))
    try {
      const { file, size } = await pipeBodyToFile(req, tmp, filename.replace(/[/\\]/g, '_'))
      if (install) {
        const r = await adb(withTarget(['install', '-r', file], t), { timeout: 600000 })
        const text = `${r.stdout || ''}${r.stderr || ''}`.trim()
        if (!r.ok || !/Success/i.test(text)) throw Object.assign(new Error(text || '安装失败'), { status: 500 })
        return { installed: true, filename, bytes: size, output: text, device: t }
      }
      const remote = `${destDir.replace(/\/$/, '')}/${filename}`
      // 确保目标目录存在（否则 push 会失败），并创建一个专门的「远程操控」文件夹方便查找。
      await adb(withTarget(['shell', `mkdir -p "${destDir.replace(/\/$/, '')}"`], t), { timeout: 8000 }).catch(() => {})
      const r = await adb(withTarget(['push', file, remote], t), { timeout: 600000 })
      if (!r.ok) throw Object.assign(new Error(String(r.stderr || '推送失败')), { status: 500 })
      // 通知媒体库扫描，让文件管理 / 相册立刻能看到新文件（否则可能要等系统自己扫）。
      await adb(withTarget(['shell', `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remote} >/dev/null 2>&1`], t), { timeout: 8000 }).catch(() => {})
      return { pushed: true, remote, bytes: size, device: t }
    } finally { await rm(tmp, { recursive: true, force: true }).catch(() => {}) }
  }

  async function screencap(device) {
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接手机'), { status: 409 })
    const r = await adb(withTarget(['exec-out', 'screencap', '-p'], t), { timeout: 20000, encoding: 'buffer' })
    if (!r.ok || !r.stdout || r.stdout.length === 0) throw Object.assign(new Error(String(r.stderr || '截图失败')), { status: 500 })
    return { dataUrl: `data:image/png;base64,${Buffer.from(r.stdout).toString('base64')}`, device: t }
  }

  async function saveScreenshot(device, savePath) {
    const t = await resolveTarget(device)
    if (!t) throw new Error('还没有连接手机')
    const r = await adb(withTarget(['exec-out', 'screencap', '-p'], t), { timeout: 20000, encoding: 'buffer' })
    if (!r.ok || !r.stdout || !r.stdout.length) throw new Error(String(r.stderr || '截图失败'))
    const dir = savePath ? dirname(savePath) : join(tmpdir(), 'dsh-phone-remote')
    await mkdir(dir, { recursive: true })
    const file = savePath || join(dir, `shot-${Date.now()}.png`)
    await writeFile(file, r.stdout)
    return { path: file, bytes: r.stdout.length, device: t }
  }

  async function uiDump(device) {
    const t = await resolveTarget(device)
    if (!t) throw new Error('还没有连接手机')
    await adb(withTarget(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'], t), { timeout: 20000 })
    const r = await adb(withTarget(['shell', 'cat', '/sdcard/window_dump.xml'], t), { timeout: 20000 })
    return String(r.stdout || r.stderr || '')
  }

  const KEY_BY_NAME = { back: 4, home: 3, recents: 187, power: 26, wakeup: 224, sleep: 223, volumeUp: 24, volumeDown: 25, menu: 82, enter: 66, delete: 67, dpadUp: 19, dpadDown: 20, dpadLeft: 21, dpadRight: 22, dpadCenter: 23, ok: 66 }

  // ---- 群聊指令：把「@某台手机 + 一句话」变成真实操作 ----
  const KEY_WORDS = [
    [/(返回|后退|回退|back)/i, 'back'],
    [/(主页|桌面|home)/i, 'home'],
    [/(多任务|最近任务|recents)/i, 'recents'],
    [/(锁屏|唤醒|点亮|wake)/i, 'wakeup'],
    [/(息屏|熄屏|睡眠|sleep)/i, 'sleep'],
    [/(电源|power)/i, 'power'],
    [/(音量\+|调大音量|增大音量|volume up)/i, 'volumeUp'],
    [/(音量-|调小音量|减小音量|volume down)/i, 'volumeDown'],
    [/(向上|上移|往上|dpad up|上键|up)/i, 'dpadUp'],
    [/(向下|下移|往下|dpad down|下键|down)/i, 'dpadDown'],
    [/(向左|左移|往左|dpad left|左键|left)/i, 'dpadLeft'],
    [/(向右|右移|往右|dpad right|右键|right)/i, 'dpadRight'],
    [/(确认|确定|ok|enter|回车|选择)/i, 'dpadCenter'],
  ]
  // 别名 → 候选包名列表（按厂商/版本尝试，第一个装了的就启动）。
  // 这是常见 App 的内置兜底表；adb 拿不到中文显示名时靠它，companion 的 /apps 能拿到显示名时更准。
  const APP_ALIASES = [
    [/(微信|wechat)/i, ['com.tencent.mm']],
    [/(支付宝|alipay)/i, ['com.eg.android.AlipayGphone', 'com.alipay.android.app']],
    [/(淘宝|taobao)/i, ['com.taobao.taobao']],
    [/(抖音|douyin|tiktok)/i, ['com.ss.android.ugc.aweme', 'com.ss.android.ugc.lifeservices']],
    [/(小红书|rednote|redbook)/i, ['com.xingin.xhs']],
    [/(浏览器|chrome|browser)/i, ['com.android.chrome', 'com.heytap.browser', 'com.vivo.browser', 'com.quark.browser']],
    [/(相机|camera)/i, ['com.android.camera', 'com.coloros.camera', 'com.oplus.camera']],
    [/(设置|settings)/i, ['com.xiaomi.mitv.settings', 'com.android.settings']],
    [/(电话|拨号|dialer)/i, ['com.android.dialer', 'com.coloros.incallui', 'com.android.incallui']],
    [/(短信|信息|messages|sms)/i, ['com.android.mms', 'com.google.android.apps.messaging']],
    [/(相机胶卷|相册|gallery|photos)/i, ['com.coloros.gallery3d', 'com.oplus.gallery', 'com.android.gallery3d', 'com.vivo.gallery']],
    [/(mika)/i, ['com.wangzan101.mika', 'com.mylea.phongent']],
    [/(b站|哔哩|哔哩哔哩|bilibili)/i, ['tv.danmaku.bili']],
    [/(知乎|zhihu)/i, ['com.zhihu.android']],
    [/(微博|weibo)/i, ['com.sina.weibo']],
    [/(快手|kuaishou)/i, ['com.smile.gifmaker', 'com.kuaishou.nebula']],
    [/(拼多多|pinduoduo|pdd)/i, ['com.xunmeng.pinduoduo']],
    [/(京东|jd)/i, ['com.jingdong.app.mall']],
    [/(美团|meituan)/i, ['com.sankuai.meituan', 'com.meituan.longcat.android']],
    [/(大众点评|dianping)/i, ['com.dianping.v1']],
    [/(饿了么|eleme)/i, ['me.ele']],
    [/(高德|amap)/i, ['com.autonavi.minimap']],
    [/(百度地图|baidumap)/i, ['com.baidu.BaiduMap']],
    [/(网易云|cloudmusic|网易云音乐)/i, ['com.netease.cloudmusic']],
    [/(qq音乐|qqmusic)/i, ['com.tencent.qqmusic']],
    [/(优酷|youku)/i, ['com.youku.phone']],
    [/(腾讯视频|qqlive)/i, ['com.tencent.qqlive']],
    [/(爱奇艺|iqiyi)/i, ['com.qiyi.video']],
    [/(qq(?!音乐|视频))/i, ['com.tencent.mobileqq']],
    [/(钉钉|dingtalk)/i, ['com.alibaba.android.rimet']],
    [/(telegram|电报)/i, ['org.telegram.messenger']],
    [/(企业微信|wework)/i, ['com.tencent.wework']],
    [/(飞书|lark|feishu)/i, ['com.ss.android.lark', 'com.larksuite.suite']],
    [/(闲鱼|idlefish)/i, ['com.taobao.idlefish']],
    [/(得物|poizon|dewu)/i, ['com.shizhuang.duapp']],
    [/(携程|ctrip)/i, ['ctrip.android.view', 'com.taobao.trip']],
    [/(12306|铁路)/i, ['com.MobileTicket']],
    [/(滴滴|didi)/i, ['com.sdu.didi.psnger']],
    [/(百度|baidu)/i, ['com.baidu.searchbox']],
    [/(夸克|quark)/i, ['com.quark.browser']],
    [/(deepseek|深度求索)/i, ['com.deepseek.chat']],
    [/(豆包|doubao)/i, ['com.larus.nova']],
    [/(kimi)/i, ['com.moonshot.kimichat']],
    [/(通义|tongyi|qwen)/i, ['com.aliyun.tongyi']],
    [/(智谱|清言|zhipu)/i, ['com.zhipuai.qingyan']],
    [/(wps)/i, ['cn.wps.moffice_eng']],
    [/(网易邮箱|邮箱|mail)/i, ['com.netease.mail', 'com.tencent.androidqqmail', 'com.google.android.gm']],
    [/(地图|maps)/i, ['com.google.android.apps.maps', 'com.autonavi.minimap', 'com.baidu.BaiduMap']],
    [/(youtube)/i, ['com.google.android.youtube']],
    [/(github)/i, ['com.github.android']],
    [/(obsidian)/i, ['md.obsidian']],
    [/(notion)/i, ['notion.id']],
    [/(discord)/i, ['com.discord']],
    [/(whatsapp)/i, ['com.whatsapp']],
    [/(推特|twitter|x\.com)/i, ['com.twitter.android']],
    [/(grok)/i, ['ai.x.grok']],
    [/(chatgpt|openai)/i, ['com.openai.chatgpt']],
    [/(steam)/i, ['com.valvesoftware.android.steam.community']],
    [/(tapTap|taptap)/i, ['com.taptap']],
  ]

  /** 把一句话解析成设备动作。返回 {action, args, describe} 或 null。 */
  function parseCommand(text) {
    const raw = String(text || '').trim()
    if (!raw) return null
    const lower = raw.toLowerCase()
    // 截图
    if (/(截图|截屏|screenshot|看看屏幕|看一下屏幕|看屏幕)/.test(lower)) return { action: 'screencap', args: {}, describe: '截取屏幕' }
    // 界面结构
    if (/(界面结构|ui结构|元素|按钮在哪|看看界面|控件树)/.test(lower)) return { action: 'uidump', args: {}, describe: '导出界面结构' }
    // 音量（放在启动应用之前：「打开音量」之类的说法少见，但「大点声」要能识别）
    if (/(大点声|大声点|声音大点|音量\s*\+|调大音量|增大音量|声音调大|音量调大|volume\s*up)/i.test(raw)) {
      return { action: 'volume', args: { step: 'up', times: 3 }, describe: '调大音量' }
    }
    if (/(小点声|小声点|声音小点|音量\s*-|调小音量|减小音量|声音调小|音量调小|静音|mute|volume\s*down)/i.test(raw)) {
      return { action: 'volume', args: { step: 'down', times: 3 }, describe: '调小音量' }
    }
    // 启动应用
    const app = APP_ALIASES.find(([re]) => re.test(raw))
    if (app && /(打开|启动|进入|运行|open|launch)/.test(lower)) return { action: 'launch', args: { packages: app[1] }, describe: `启动 ${app[1][0]}` }
    // 包名直接启动
    const pkg = /([a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,})/i.exec(raw)
    if (pkg && /(打开|启动|进入|运行|open|launch)/i.test(raw)) return { action: 'launch', args: { packages: [pkg[1]] }, describe: `启动 ${pkg[1]}` }
    // 「打开 XX」且 XX 不是固定别名/包名 → 当作要打开的 App 名字，动态匹配手机已装 App。
    const openApp = /(?:打开|启动|进入|运行|open|launch)\s*[:：]?\s*["“”']?([^\s"“”'，。！？]+?)["“”']?\s*$/.exec(raw)
    if (openApp) return { action: 'launch', args: { queryName: openApp[1] }, describe: `打开 ${openApp[1]}` }
    // 点击坐标
    const tap = /(?:点击|点一下|点按|tap|click)\s*(?:坐标\s*)?\(?\s*(\d{1,4})\s*[,，\s]\s*(\d{1,4})\s*\)?/i.exec(raw)
    if (tap) return { action: 'tap', args: { x: Number(tap[1]), y: Number(tap[2]) }, describe: `点击 (${tap[1]}, ${tap[2]})` }
    // 滑动
    const swipe = /(?:滑动|滑一下|滑|swipe)\s*\(?\s*(\d{1,4})\s*[,，\s]\s*(\d{1,4})\s*(?:到|→|->|to)\s*\(?\s*(\d{1,4})\s*[,，\s]\s*(\d{1,4})\s*\)?/i.exec(raw)
    if (swipe) return { action: 'swipe', args: { x1: Number(swipe[1]), y1: Number(swipe[2]), x2: Number(swipe[3]), y2: Number(swipe[4]) }, describe: `滑动 (${swipe[1]}, ${swipe[2]}) → (${swipe[3]}, ${swipe[4]})` }
    // 向上/向下滑动（滚动）
    const scroll = /(?:向上?滑|往下滑|上滑|下滑|滚动|scroll)/i.exec(raw)
    if (scroll) {
      const up = /(向上?滑|上滑)/.test(raw)
      return { action: 'scroll', args: { up }, describe: up ? '向上滑动' : '向下滑动' }
    }
    // 输入文本
    const type = /(?:输入|打字|输入文字|输入文本|type)\s*[:：]?\s*["“”']?(.+?)["“”']?$/.exec(raw)
    if (type && !/^(点击|点按|滑动|截图|打开|启动)/.test(raw)) return { action: 'text', args: { text: type[1].trim() }, describe: `输入「${type[1].trim()}」` }
    // 系统按键
    const key = KEY_WORDS.find(([re]) => re.test(raw))
    if (key) return { action: 'key', args: { name: key[1] }, describe: `按${({ back: '返回', home: '主页', recents: '多任务', power: '电源', wakeup: '唤醒', sleep: '息屏', volumeUp: '音量+', volumeDown: '音量−', dpadUp: '上', dpadDown: '下', dpadLeft: '左', dpadRight: '右', dpadCenter: '确认', menu: '菜单', delete: '删除' })[key[1]]}` }
    // shell
    const shell = /(?:执行|运行|shell)\s*[:：]?\s*(.+)$/i.exec(raw)
    if (shell) return { action: 'shell', args: { command: shell[1].trim() }, describe: `执行 ${shell[1].trim()}` }
    return null
  }

  /** 在指定设备上执行一条群聊指令。 */
  async function runCommand(device, text) {
    const identity = String(device || '').trim()
    const serial = identity ? await resolveDeviceIdentity(identity) : await resolveTarget('')
    if (!serial) {
      // 列出当前能用的设备名，方便用户直接照着 @。
      const list = await adbDevices()
      const names = [...new Set(list.map((d) => roster[deviceKey(d.serial)] && roster[deviceKey(d.serial)].name).filter(Boolean))]
      const hint = names.length ? `可用的手机有：${names.map((n) => '@' + n).join('、')}` : '还没有连接任何手机'
      throw Object.assign(new Error(`没找到手机「${identity || '（未指定）'}」。${hint}`), { status: identity ? 404 : 400 })
    }
    if (!await usable(serial)) {
      // adb 不可用没关系，看这台手机有没有 companion（App）服务在跑，有就走 App 直连。
      const ip = roster[deviceKey(serial)] && roster[deviceKey(serial)].ip || ipOfSerial(serial)
      let alive = false
      if (ip) { try { alive = Boolean((await companionProbe(ip)).running) } catch { alive = false } }
      if (!alive) {
        const result = await connectCandidate(serial)
        if (!result.ok) throw Object.assign(new Error(`手机「${identity || serial}」当前离线（adb 连不上，App 服务也没在跑），请打开它的「手机遥控伴侣」无障碍或重新连 adb`), { status: 409 })
      }
    }
    const command = parseCommand(text)
    if (!command) throw Object.assign(new Error(`没听懂「${text}」，可以试试：截图 / 打开微信 / 返回 / 输入：你好 / 点击 500 800 / 大点声 / 向上滑`), { status: 400 })
    const target = await resolveDeviceIdentity(identity) || serial
    // 目标设备的 IP（companion 模式用），以及它的 companion 服务是否在跑。
    const targetIp = roster[deviceKey(target)] && roster[deviceKey(target)].ip || ipOfSerial(target)
    let companionAlive = false
    let companionProbe2 = null
    if (targetIp) {
      try { companionProbe2 = await companionProbe(targetIp); companionAlive = Boolean(companionProbe2.running) } catch { companionAlive = false }
    }
    const viaCompanion = async (action, payload) => {
      const r = await companionCommand(companionProbe2.ip, action, payload)
      return r
    }

    // ---- 根据手机上的已装 App，把用户说的“打开 XX”解析成真实包名 ----
    // 像 Mika/PhoneGo 一样：动态读手机 App 目录（显示名→包名），按名字模糊匹配。
    const appListCache = new Map()   // ip -> {at, apps:[{label,package}]}
    const getInstalledApps = async (deviceSerial, devIp) => {
      const cache = appListCache.get(devIp)
      if (cache && Date.now() - cache.at < 30000) return cache.apps
      let apps = []
      // 优先 companion（不依赖 adb）；没有就退回 adb。
      if (devIp) {
        try {
          const probe = await companionProbe(devIp)
          if (probe.running) {
            const r = await companionCommand(probe.ip, 'apps')
            if (r && Array.isArray(r.apps)) apps = r.apps
          }
        } catch { /* 忽略 */ }
      }
      if (!apps.length && deviceSerial) {
        // 只有这台 adb 传输真的可用才去读，否则会挂在死传输上。
        try {
          if (await usable(deviceSerial)) {
            const r = await adb(withTarget(['shell', 'cmd', 'package', 'query-activities', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER'], deviceSerial), { timeout: 12000 })
            if (r.ok && r.stdout) {
              apps = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('/'))
                .map((l) => ({ package: l.split('/')[0].trim() }))
              // 拿不到显示名就用包名兜底；companion 才带真实显示名。
            }
          }
        } catch { /* 忽略 */ }
      }
      appListCache.set(devIp || deviceSerial || '?', { at: Date.now(), apps })
      return apps
    }
    // 显示名/别名模糊匹配：返回第一个命中的包名。
    const resolveAppPackage = (query, apps) => {
      const q = String(query || '').toLowerCase().replace(/[`"'（）()\s]/g, '')
      if (!q || !apps.length) return null
      // 1) 精确包名
      const exact = apps.find((a) => a.package.toLowerCase() === q)
      if (exact) return exact.package
      // 2) 显示名完全匹配
      const byLabel = apps.find((a) => (a.label || '').toLowerCase().replace(/[\s]/g, '') === q)
      if (byLabel) return byLabel.package
      // 3) 显示名包含
      const contains = apps.find((a) => {
        const label = (a.label || '').toLowerCase().replace(/[\s]/g, '')
        return label.includes(q) || q.includes(label)
      })
      if (contains) return contains.package
      // 4) 包名包含
      const pkg = apps.find((a) => a.package.toLowerCase().includes(q))
      if (pkg) return pkg.package
      return null
    }
    if (command.action === 'screencap') {
      const shot = await screencap(target)
      return { ok: true, action: command.action, describe: command.describe, device: target, dataUrl: shot.dataUrl }
    }
    if (command.action === 'uidump') {
      // 优先 adb 的控件树；adb 断了就退回 companion。
      if (companionAlive) {
        const r = await viaCompanion('tree')
        const nodes = r && r.nodes ? r.nodes : []
        const xml = `<hierarchy rotation="0" mode="companion">${nodes.map((n) => `<node text="${String(n.text || n.desc || '').replace(/[<>&"]/g, '')}" class="${n.cls || 'View'}" clickable="${n.clickable}" />`).join('')}</hierarchy>`
        return { ok: true, action: command.action, describe: command.describe, device: target, output: xml, via: 'companion' }
      }
      const xml = await uiDump(target)
      return { ok: true, action: command.action, describe: command.describe, device: target, output: xml }
    }
    if (command.action === 'launch') {
      let packages = command.args.packages || [command.args.package].filter(Boolean)
      // 静态别名没命中时（packages 仍是 null 或空），动态读手机 App 目录按名字匹配。
      const queryName = command.args.queryName || command.args.package || ''
      if (!packages.length && queryName) {
        const apps = await getInstalledApps(target, targetIp)
        const resolved = resolveAppPackage(queryName, apps)
        if (resolved) packages = [resolved]
        else {
          // 真没这个 App：列出相近的，并提示可以去应用商店装。
          const near = apps.filter((a) => (a.label || '').toLowerCase().includes(String(queryName).toLowerCase().slice(0, 2))).slice(0, 5).map((a) => a.label)
          const hint = near.length ? `没找到「${queryName}」，相近的有：${near.join('、')}。` : `没找到「${queryName}」。`
          throw Object.assign(new Error(`${hint}这台手机没装这个 App，请先在应用商店搜索「${queryName}」安装，装好后再说「打开 ${queryName}」我就能打开它。`), { status: 404 })
        }
      }
      if (!packages.length) throw Object.assign(new Error(`没找到要打开的 App`), { status: 400 })
      if (companionAlive) {
        // 依次试候选包，第一个能启动的就行。
        for (const pkg of packages) {
          try { await viaCompanion('launch', { package: pkg }) } catch { /* 下一个 */ }
        }
        return { ok: true, action: command.action, describe: command.describe, device: target, via: 'companion', packages }
      }
      let lastErr = ''
      const tried = new Set()
      for (const pkg of packages) {
        tried.add(pkg)
        try {
          const result = await launch(pkg, target)
          if (result && result.ok !== false) return { ok: true, action: command.action, describe: command.describe, device: target, output: result.output, packages }
        } catch (e) { lastErr = String(e.message || e) }
      }
      // 静态候选包都启动不了时，用动态 App 目录按名字再找一次
      // （例如电视上的「设置」其实是 com.xiaomi.mitv.settings，不是 com.android.settings）。
      if (queryName) {
        try {
          const apps = await getInstalledApps(target, targetIp)
          const resolved = resolveAppPackage(queryName, apps)
          if (resolved && !tried.has(resolved)) {
            const result = await launch(resolved, target)
            if (result && result.ok !== false) return { ok: true, action: command.action, describe: command.describe, device: target, output: result.output, packages: [resolved] }
          }
        } catch (e) { lastErr = String(e.message || e) }
      }
      throw Object.assign(new Error(`无法启动 ${packages[0]}：${lastErr}`), { status: 400 })
    }
    if (command.action === 'shell') {
      const result = await shell(command.args.command, target)
      return { ok: true, action: command.action, describe: command.describe, device: target, output: `${result.stdout}${result.stderr ? '\n[stderr] ' + result.stderr : ''}` }
    }
    if (command.action === 'volume') {
      const up = command.args.step === 'up'
      // 部分厂商（如 vivo）没有 `media` 命令，这里用音量键事件，最通用。
      const keycode = up ? 24 : 25
      const times = Math.max(1, Number(command.args.times) || 3)
      let last = ''
      for (let i = 0; i < times; i += 1) {
        const r = await adb(withTarget(['shell', 'input', 'keyevent', String(keycode)], target), { timeout: 8000 })
        last = `${r.stdout || ''}${r.stderr || ''}`.trim()
        if (!r.ok && last) break
        await sleep(120)
      }
      return { ok: true, action: command.action, describe: `${command.describe}（${times} 格）`, device: target, output: last }
    }
    if (command.action === 'scroll') {
      // 在屏幕中部按方向滑动：上滑 = 看下面的内容，下滑 = 回上面的内容。
      const up = command.args.up
      const x = 630, y = up ? 1900 : 900
      const y2 = up ? 900 : 1900
      const result = await input({ kind: 'swipe', x1: x, y1: y, x2: x, y2, device: target })
      return { ok: result.ok, action: command.action, describe: command.describe, device: target, output: result.output }
    }
    if (command.action === 'tap' || command.action === 'swipe' || command.action === 'text' || command.action === 'key') {
      if (companionAlive) {
        const payload = command.action === 'tap' ? { x: command.args.x, y: command.args.y }
          : command.action === 'swipe' ? { x1: command.args.x1, y1: command.args.y1, x2: command.args.x2, y2: command.args.y2 }
            : command.action === 'key' ? { key: command.args.name }
              : { text: command.args.text }
        await viaCompanion(command.action, payload)
        return { ok: true, action: command.action, describe: command.describe, device: target, via: 'companion' }
      }
      const result = await input({ kind: command.action, ...command.args, device: target })
      return { ok: result.ok, action: command.action, describe: command.describe, device: target, output: result.output }
    }
    throw Object.assign(new Error('不支持的指令'), { status: 400 })
  }

  async function input(payload) {
    const t = await resolveTarget(payload.device)
    if (!t) throw Object.assign(new Error('还没有连接手机'), { status: 409 })
    const kind = payload.kind
    let args
    if (kind === 'tap') args = ['input', 'tap', String(Number(payload.x) || 0), String(Number(payload.y) || 0)]
    else if (kind === 'swipe') args = ['input', 'swipe', String(Number(payload.x1) || 0), String(Number(payload.y1) || 0), String(Number(payload.x2) || 0), String(Number(payload.y2) || 0), String(Number(payload.ms) || 300)]
    else if (kind === 'key') { const code = KEY_BY_NAME[payload.name] ?? Number(payload.code); if (!code) throw Object.assign(new Error('未知按键'), { status: 400 }); args = ['input', 'keyevent', String(code)] }
    else if (kind === 'text') { const text = String(payload.text ?? ''); if (!text) throw Object.assign(new Error('文本为空'), { status: 400 }); const encoded = `'${text.replace(/ /g, '%s').replace(/'/g, "'\\''")}'`; args = ['input', 'text', encoded] }
    else throw Object.assign(new Error('不支持的输入类型'), { status: 400 })
    const r = await adb(withTarget(['shell', ...args], t), { timeout: 15000 })
    return { ok: r.ok, output: `${r.stdout || ''}${r.stderr || ''}`.trim(), device: t }
  }

  async function launch(pkg, device) {
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接手机'), { status: 409 })
    const clean = String(pkg || '').trim()
    if (!clean) throw Object.assign(new Error('请填写包名'), { status: 400 })
    const r = await adb(withTarget(['shell', 'monkey', '-p', clean, '-c', 'android.intent.category.LAUNCHER', '1'], t), { timeout: 20000 })
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim()
    if (/No activities found|monkey aborted/i.test(text)) throw Object.assign(new Error(`无法启动 ${clean}：${text}`), { status: 400 })
    return { output: text, device: t }
  }

  /**
   * 让电视切到「无线投屏 → 电脑投屏」的等待页（用电视自带的那套投屏）。
   * 小米电视的投屏 App 是 com.xiaomi.mitv.smartshare，左侧有「电脑投屏」标签，
   * 这里直接用 adb 点进去，电视就开始等电脑投屏。
   * 电脑端再从「控制中心 → 屏幕镜像」里选这台电视（macOS 原生 AirPlay，电视也是 AirPlay 接收端）。
   */
  /**
   * 防休眠开关。开启后：关掉屏保 + 豁免 Doze（保持 adb/应用不被打断），并加入看护定时保活。
   * 注意：这里**刻意不**设置「屏幕常亮 / 超长息屏时间」——那会让手机自己一直亮着、
   * 反复触发人脸解锁；串流时才临时开常亮，结束即恢复。
   * 主要解决「电视长时间不动自己进休眠导致断连」的问题。
   */
  async function keepAwake(device, on) {
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接设备'), { status: 409 })
    const want = on !== false
    const cmds = want
      ? [
          'dumpsys deviceidle unforce >/dev/null 2>&1',
          'settings put secure screensaver_enabled 0',
          'settings put secure screensaver_activate_on_sleep 0',
          'settings put secure screensaver_activate_on_dock 0',
        ]
      : [
          'dumpsys deviceidle reset >/dev/null 2>&1',
          'settings put secure screensaver_enabled 1',
        ]
    const out = []
    for (const c of cmds) {
      const r = await adb(withTarget(['shell', c], t), { timeout: 8000 })
      out.push(`${c} → ${(r.stdout || r.stderr || '').trim() || (r.ok ? 'ok' : 'fail')}`)
    }
    if (want) {
      watcher.keepAwake.add(t)
      await adb(withTarget(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], t), { timeout: 6000 }).catch(() => {})
    } else {
      watcher.keepAwake.delete(t)
    }
    return { device: t, keepAwake: want, steps: out }
  }

  /** 按比例点按：fx,fy 是画面里的相对坐标（0~1），换算成设备真实分辨率后点击。 */
  async function tapFrac(device, fx, fy) {
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接设备'), { status: 409 })
    let w = 0, h = 0
    const r = await adb(withTarget(['shell', 'wm', 'size'], t), { timeout: 8000 })
    const m = /(\d{2,5})x(\d{2,5})/.exec(r.stdout || '')
    if (m) { w = Number(m[1]); h = Number(m[2]) }
    if (!w || !h) throw Object.assign(new Error('读不到设备分辨率'), { status: 500 })
    const x = Math.max(0, Math.min(w - 1, Math.round(Number(fx) * w)))
    const y = Math.max(0, Math.min(h - 1, Math.round(Number(fy) * h)))
    await adb(withTarget(['shell', 'input', 'tap', String(x), String(y)], t), { timeout: 8000 })
    return { device: t, x, y }
  }

  /** 读取本机 DSH 当前接入的模型（Magpie 网关，OpenAI 兼容），给「AI 操控」用。 */
  function readLlm() {
    try {
      const env = readFileSync(join(homedir(), '.dsh', '.env'), 'utf8')
      const km = /MAGPIE_GATEWAY_KEY\s*=\s*(.+)/.exec(env)
      const key = km ? km[1].trim().replace(/^["']|["']$/g, '') : ''
      if (!key) return null
      const set = readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
      const bm = /baseURL:\s*(http[^\s#]+)/.exec(set)
      const baseURL = bm ? bm[1] : 'http://127.0.0.1:3425/v1'
      let model = 'group/flash'
      if (/id:\s*group\/flash\b/.test(set)) model = 'group/flash'
      return { baseURL, key, model }
    } catch { return null }
  }
  function httpPostJson(urlStr, headers, bodyObj, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(urlStr) } catch (e) { reject(e); return }
      const lib = u.protocol === 'https:' ? httpsMod : httpMod
      const payload = Buffer.from(JSON.stringify(bodyObj))
      const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers: { ...headers, 'content-length': payload.length } }, (res) => {
        const ch = []
        res.on('data', (d) => ch.push(d))
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))) } catch (e) { reject(new Error('网关返回无法解析')) } })
      })
      req.on('error', reject)
      req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('AI 超时')) } catch { /* ignore */ } })
      req.write(payload); req.end()
    })
  }
  /**
   * AI 操控：把用户的一句话交给本机接入的大模型，模型转成一组设备指令，逐条用 runCommand 执行。
   * 复用 runCommand 的「打开XX / 返回 / 向右 / 确认 / 输入：xx / 点击 x y / 大点声」等能力。
   */
  /** 抓当前界面的可操作元素（uiautomator），返回 [{i,text,desc,x,y,clickable}]。 */
  async function dumpUi(serial) {
    try {
      await adb(withTarget(['shell', 'uiautomator dump /sdcard/_dsh_ui.xml >/dev/null 2>&1'], serial), { timeout: 15000 })
      const r = await adb(withTarget(['exec-out', 'cat', '/sdcard/_dsh_ui.xml'], serial), { timeout: 12000 })
      const xml = String(r.stdout || '')
      // 从 XML 文本里正则抽 node，避免引第三方 XML 解析库（属性顺序固定）。
      const elems = []
      const re = /<node\b([^>]*?)\/?>/g
      let m
      let idx = 0
      while ((m = re.exec(xml))) {
        const attrs = m[1]
        const get = (k) => { const mm = new RegExp(k + '="([^"]*)"').exec(attrs); return mm ? mm[1] : '' }
        const text = get('text')
        const desc = get('content-desc')
        const clickable = get('clickable') === 'true'
        const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(get('bounds'))
        const label = (text || desc || '').trim()
        if (!bounds) { continue }
        const [x1, y1, x2, y2] = [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])]
        if (x2 <= x1 || y2 <= y1) continue
        if (!label && !clickable) continue
        // 只保留有文字/描述、或明确可点击的节点
        elems.push({ i: idx++, text: text.trim(), desc: desc.trim(), label, clickable, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) })
        if (elems.length > 120) break
      }
      return elems.filter((e) => e.label || e.clickable)
    } catch { return [] }
  }

  /**
   * AI 操控（像 Pinky 那样「看屏幕 → 操作 → 看结果 → 循环」）。
   * 每一步把当前界面元素列表交给本机模型，模型选下一步动作（按元素/按键/输入/滑动/完成），
   * 执行后重新看屏幕，直到模型判断完成或步数用尽。这样比「盲翻译成固定指令」可靠得多。
   */
  /** 二进制 adb 采集（返回 Buffer）。 */
  function adbCaptureBin(args) {
    return new Promise((resolve) => {
      let cap
      try { cap = spawn(resolveAdb(cfg), args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true }) } catch { resolve(null); return }
      const chunks = []
      cap.stdout.on('data', (d) => chunks.push(d))
      cap.on('error', () => resolve(null))
      cap.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null))
    })
  }
  /** 快速截一张 PNG：设备端存文件再传回（比 exec-out 直连快约 3 倍）。 */
  async function capturePngFast(serial) {
    const f = '/sdcard/_dsh_frame.png'
    await new Promise((resolve) => {
      let c
      try { c = spawn(resolveAdb(cfg), ['-s', serial, 'shell', `screencap -p ${f}`], { stdio: 'ignore', detached: true }) } catch { resolve(); return }
      c.on('close', resolve); c.on('error', resolve)
    })
    return adbCaptureBin(['-s', serial, 'exec-out', 'cat', f])
  }
  /** PNG → 小尺寸 JPEG（给视觉模型看，减小体积）。 */
  function pngToSmallJpeg(png, maxW) {
    return new Promise((resolve) => {
      if (!png || png.length < 100) { resolve(null); return }
      const ff = resolveFfmpeg(cfg)
      let proc
      try { proc = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', `scale=${maxW || 420}:-2`, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true }) } catch { resolve(null); return }
      const out = []
      proc.stdout.on('data', (d) => out.push(d))
      proc.on('error', () => resolve(null))
      proc.on('close', () => resolve(out.length ? Buffer.concat(out) : null))
      try { proc.stdin.on('error', () => {}); proc.stdin.write(png); proc.stdin.end() } catch { resolve(null) }
    })
  }
  /** 取设备屏幕像素尺寸。 */
  async function deviceSize(serial) {
    try {
      const wm = await adb(withTarget(['shell', 'wm', 'size'], serial), { timeout: 6000 })
      const m = /(\d+)x(\d+)/.exec(wm.stdout || '')
      if (m) return { w: Number(m[1]), h: Number(m[2]) }
    } catch { /* ignore */ }
    return { w: 1080, h: 1920 }
  }

  /**
   * AI 操控（真·看图决策，像 Pinky/Mika）：每一步把「当前屏幕截图」交给多模态大模型，
   * 模型看图后给出下一步动作（点某处/输入/按键/滑动/完成）并描述它看到了什么，
   * 执行后重新截图，循环到完成。这就是大模型真正在执行，而不是查控件树或盲翻译。
   */
  async function aiControl(device, text) {
    const t = await resolveTarget(device)
    const goal = String(text || '').trim()
    if (!goal) throw Object.assign(new Error('请先说要做什么'), { status: 400 })
    const llm = readLlm()
    if (!llm) throw Object.assign(new Error('没有找到本机模型配置（~/.dsh/.env 的 MAGPIE_GATEWAY_KEY）'), { status: 500 })
    const raw = await adbDevices()
    const dev = raw.find((d) => d.serial === t)
    const model = dev ? dev.model : ''
    const isTv = /tv|mitv|box|电视/i.test(model + ' ' + t)
    // 不主动唤醒屏幕（那会触发人脸/指纹解锁）。截图在息屏时也能拍到锁屏画面，
    // 模型看到锁屏会自己决定要不要滑动解锁。
    const { w: DW, h: DH } = await deviceSize(t)

    const sys = `你是手机操控智能体，正在看一台${isTv ? '安卓电视' : '安卓手机'}（型号 ${model || '未知'}，屏幕 ${DW}x${DH}）的实时截图。
用户会给你任务，你要「看截图 → 决定下一步 → 执行 → 再看」，一步步把任务做完。
每次回复严格只输出一个 JSON 对象，字段如下（不要额外文字）：
{
  "see": "你在这张截图上看到了什么（一句话，比如：桌面，有微信/设置图标）",
  "action": "tap" | "input" | "key" | "swipe" | "done",
  "x": 0-100 的数字（tap 时：点击位置横坐标，按屏幕宽度百分比）,
  "y": 0-100 的数字（tap 时：纵坐标百分比）,
  "text": "要输入的文字（input 时）",
  "name": "back|home|menu|up|down|left|right"（key 时）,
  "dir": "up|down|left|right"（swipe 时）,
  "summary": "完成时的总结（done 时）"
}
规则：
1. 坐标用「屏幕百分比」：左上角(0,0)、右下角(100,100)，凭你在图上看到的位置估。
2. 要打开某个 App，就在图上找到它的图标点它（图标可能在桌面或需要滑动找）。
3. 需要输入文字时，先 tap 输入框，下一步再 input。
4. 任务完成就 action=done 并给 summary。
5. 别乱点；每一步的 see 要诚实描述你看到的画面。`
    const trace = []
    let summary = ''
    const history = []  // {role, content}
    const maxSteps = 9
    for (let step = 0; step < maxSteps; step++) {
      const png = await capturePngFast(t)
      const jpg = await pngToSmallJpeg(png, 480)
      if (!jpg) { trace.push({ ok: false, see: '', desc: '截图失败' }); break }
      const b64 = jpg.toString('base64')
      const histText = trace.length ? '\n\n已做过的步骤：\n' + trace.map((x, i) => `${i + 1}. ${x.see ? '看到「' + x.see + '」，' : ''}${x.desc}`).join('\n') : ''
      const userContent = [
        { type: 'text', text: `任务：${goal}${histText}\n\n这是当前屏幕截图，请判断并给出下一步动作 JSON：` },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
      ]
      const body = { model: llm.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }], temperature: 0.2, max_tokens: 400 }
      let data
      try { data = await httpPostJson(llm.baseURL.replace(/\/$/, '') + '/chat/completions', { 'content-type': 'application/json', authorization: 'Bearer ' + llm.key }, body) }
      catch (e) { throw Object.assign(new Error('调用模型失败：' + e.message), { status: 502 }) }
      const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
      let a = {}
      try { const mm = /\{[\s\S]*\}/.exec(content); if (mm) a = JSON.parse(mm[0]) } catch { /* ignore */ }
      if (!a || !a.action) { trace.push({ ok: false, see: content.slice(0, 50), desc: '模型没给出有效动作' }); break }
      const see = a.see || ''
      if (a.action === 'done') { summary = a.summary || '完成'; trace.push({ ok: true, see, desc: '完成：' + summary }); break }
      let desc = ''
      try {
        if (a.action === 'tap') {
          const px = Math.round((Number(a.x) || 0) / 100 * DW)
          const py = Math.round((Number(a.y) || 0) / 100 * DH)
          await adb(withTarget(['shell', 'input', 'tap', String(px), String(py)], t), { timeout: 10000 })
          desc = `点击(约${Math.round(Number(a.x))}%,${Math.round(Number(a.y))}%)`
        } else if (a.action === 'input') {
          const txt = String(a.text || '')
          if (!txt) throw new Error('输入为空')
          const encoded = txt.replace(/ /g, '%s').replace(/'/g, "'\\''")
          await adb(withTarget(['shell', 'input', 'text', `'${encoded}'`], t), { timeout: 12000 })
          desc = `输入「${txt}」`
        } else if (a.action === 'key') {
          const code = isTv ? ({ back: 4, home: 3, menu: 82, up: 19, down: 20, left: 21, right: 22 }[a.name]) : ({ back: 4, home: 3, menu: 82 }[a.name])
          if (!code) throw new Error('未知按键 ' + a.name)
          await adb(withTarget(['shell', 'input', 'keyevent', String(code)], t), { timeout: 8000 })
          desc = '按' + a.name
        } else if (a.action === 'swipe') {
          const dir = a.dir || 'up'
          const cx = Math.round(DW / 2), cy = Math.round(DH / 2)
          let x1 = cx, y1 = cy, x2 = cx, y2 = cy
          if (dir === 'up') { y1 = Math.round(DH * 0.72); y2 = Math.round(DH * 0.28) }
          else if (dir === 'down') { y1 = Math.round(DH * 0.28); y2 = Math.round(DH * 0.72) }
          else if (dir === 'left') { x1 = Math.round(DW * 0.72); x2 = Math.round(DW * 0.28) }
          else { x1 = Math.round(DW * 0.28); x2 = Math.round(DW * 0.72) }
          await adb(withTarget(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), '300'], t), { timeout: 10000 })
          desc = '向' + dir + '滑'
        } else { throw new Error('未知动作 ' + a.action) }
        trace.push({ ok: true, see, desc })
      } catch (e) {
        trace.push({ ok: false, see, desc: (desc || a.action) + ' 失败：' + e.message })
      }
      await sleep(1000)
    }
    if (!summary && trace.length) summary = '已执行 ' + trace.filter((x) => x.ok).length + ' 步'
    return { model: llm.model, goal, isTv, size: { w: DW, h: DH }, steps: trace, summary: summary || '未完成', vision: true }
  }

  /**
   * 桥：把 A 设备的画面投到 B 设备上。
   * 做法：A 的屏幕 → 本机 MJPEG 流（本地 HTTP 端口）→ B 上用能播网络视频的 App 打开这个地址。
   * 支持两种模式：
   *   - 'stream'：B 打开 B 浏览器/播放器的 MJPEG 地址（需 B 上有浏览器）
   *   - 'push'  ：B 上安装/启动一个支持 MJPEG 的播放器并打开该地址
   */
  async function bridgeStream(fromDevice, toDevice, opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const from = await resolveTarget(fromDevice)
    if (!from) throw Object.assign(new Error('来源设备没连上'), { status: 409 })
    const to = await resolveTarget(toDevice)
    if (!to) throw Object.assign(new Error('目标设备没连上'), { status: 409 })
    const ffmpeg = resolveFfmpeg(cfg)
    const bin = resolveAdb(cfg)
    if (!ffmpeg || !bin) throw Object.assign(new Error('缺少 adb 或 ffmpeg'), { status: 500 })
    // 目标设备的 IP（给本地 HTTP 服务用）
    let toIp = ipOfSerial(to) || ''
    if (!toIp) {
      try {
        const idx = await mdnsIpIndex()
        toIp = idx.get(deviceKey(to)) || ''
      } catch { /* ignore */ }
    }
    if (!toIp) throw Object.assign(new Error('拿不到目标设备 IP'), { status: 500 })
    const port = 8790 + (Math.floor(Math.random() * 40))
    const url = `http://${localIp()}:${port}/stream.mjpeg`
    // 手机/电视的浏览器大多不认 MJPEG 直链，所以再给一个 HTML 页面，
    // 用 <img src=mjpeg> 显示，浏览器打开这个页面就能看到画面。
    const pageUrl = `http://${localIp()}:${port}/`
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>远程画面</title><style>html,body{margin:0;height:100%;background:#000;display:flex;align-items:center;justify-content:center}
img{max-width:100%;max-height:100%;object-fit:contain}</style></head>
<body><img src="/stream.mjpeg" alt="远程画面" onerror="document.body.innerHTML='<p style=\'color:#fff;font:16px sans-serif\'>画面流已断开</p>'"></body></html>`
    // 起一个本地 HTTP 服务：把 A 的屏幕转成 MJPEG 边推边发。
    const server = httpMod.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(html)
        return
      }
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=ffmpeg', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' })
      const size = '640x360'
      const cmd = `"${bin}" -s "${from}" exec-out screenrecord --output-format=h264 --time-limit 170 --size ${size} - | ` +
        `"${ffmpeg}" -hide_banner -loglevel error -f h264 -i pipe:0 -vf fps=10 -c:v mjpeg -q:v 9 -flush_packets 1 -f mpjpeg -`
      const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
      ownedChildren.add(child)
      child.on('close', () => ownedChildren.delete(child))
      child.stdout.on('data', (d) => { try { res.write(d) } catch { /* ignore */ } })
      req.on('close', () => {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* ignore */ }
        // 设备端也要收尾，否则残留的 screenrecord 会占住编码器（电视会卡死/黑屏）。
        adb(withTarget(['shell', 'pkill -9 screenrecord 2>/dev/null; pkill -9 -f "screenrecord --output-format" 2>/dev/null || true'], from), { timeout: 6000 }).catch(() => {})
      })
    })
    await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve))
    // 在目标设备上用浏览器打开这个 HTML 页面（浏览器 + <img> 最通用）
    let opened = ''
    const tryOpen = async (pkg, mime) => {
      const args = ['-s', to, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', pageUrl]
      if (mime) args.push('-t', mime)
      if (pkg) args.push('-n', pkg)
      const r = await adb(args, { timeout: 15000 })
      const txt = `${r.stdout || ''}${r.stderr || ''}`.trim()
      if (!/Error:|Exception|unable to resolve/i.test(txt)) { opened = txt; return true }
      return false
    }
    // 优先系统浏览器
    const browserPkgs = ['com.android.chrome', 'com.vivo.browser', 'com.android.browser', 'com.miui.player', 'com.huawei.browser']
    let done = false
    for (const bp of browserPkgs) { if (await tryOpen(bp)) { done = true; break } }
    if (!done) done = await tryOpen('', null)
    // 记录服务，插件卸载时关掉
    bridgeServers.push({ server, port, from, to, children: [] })
    return {
      from, to, url, pageUrl, port, opened,
      note: done
        ? '已在目标设备上打开画面流。若没自动播放，请手动用它的浏览器打开这个地址。'
        : `设备没有自动选择播放器，请手动用它的浏览器打开：${pageUrl}`,
    }
  }
  function localIp() {
    try {
      const nets = networkInterfaces()
      for (const list of Object.values(nets)) {
        for (const n of list || []) {
          if (n && n.family === 'IPv4' && !n.internal) return n.address
        }
      }
    } catch { /* ignore */ }
    return '127.0.0.1'
  }

  /**
   * 电脑画面投到某台设备（手机/电视）。
   * 做法：本机 ffmpeg 采集 Mac 屏幕 → MJPEG → 本地 HTTP 服务 → 目标设备用播放器/浏览器打开。
   * 这条路不依赖设备有没有 AirPlay，任何能播网络视频的设备都行。
   */
  async function pcStreamTo(device, opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const to = await resolveTarget(device)
    if (!to) throw Object.assign(new Error('目标设备没连上'), { status: 409 })
    const ffmpeg = resolveFfmpeg(cfg)
    if (!ffmpeg) throw Object.assign(new Error('未找到 ffmpeg（采集电脑画面需要它）'), { status: 500 })
    let toIp = ipOfSerial(to) || ''
    if (!toIp) {
      try { const idx = await mdnsIpIndex(); toIp = idx.get(deviceKey(to)) || '' } catch { /* ignore */ }
    }
    if (!toIp) throw Object.assign(new Error('拿不到目标设备 IP'), { status: 500 })
    const port = 8830 + (Math.floor(Math.random() * 40))
    const url = `http://${localIp()}:${port}/pc.mjpeg`
    const pageUrl = `http://${localIp()}:${port}/`
    const width = Number(o.width) > 0 ? Number(o.width) : 960
    const height = Number(o.height) > 0 ? Number(o.height) : 540
    // 设备上的浏览器不认 MJPEG 直链，给一个 HTML 页面用 <img> 显示，浏览器打开就能看。
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>电脑画面</title><style>html,body{margin:0;height:100%;background:#000;display:flex;align-items:center;justify-content:center}
img{max-width:100%;max-height:100%;object-fit:contain}</style></head>
<body><img src="/pc.mjpeg" alt="电脑画面"></body></html>`
    const server = httpMod.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(html)
        return
      }
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=ffmpeg', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' })
      const cmd = `"${ffmpeg}" -hide_banner -loglevel error -f avfoundation -framerate 15 -pix_fmt uyvy422 -i "${o.screen || '2:none'}" ` +
        `-vf "scale=${width}:${height},fps=10" -c:v mjpeg -q:v 8 -flush_packets 1 -f mpjpeg -`
      const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
      ownedChildren.add(child)
      child.on('close', () => ownedChildren.delete(child))
      child.stdout.on('data', (d) => { try { res.write(d) } catch { /* ignore */ } })
      req.on('close', () => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* ignore */ } })
    })
    await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve))
    // 让目标设备用浏览器打开这个页面
    let opened = ''
    const tryOpen = async (pkg) => {
      const args = ['-s', to, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', pageUrl]
      if (pkg) args.push('-n', pkg)
      const r = await adb(args, { timeout: 15000 })
      const txt = `${r.stdout || ''}${r.stderr || ''}`.trim()
      if (!/Error:|unable to resolve|Exception/i.test(txt)) { opened = txt; return true }
      return false
    }
    let done = false
    for (const bp of ['com.android.chrome', 'com.vivo.browser', 'com.android.browser', 'com.microsoft.emmx']) { if (await tryOpen(bp)) { done = true; break } }
    if (!done) done = await tryOpen('')
    bridgeServers.push({ server, port, to })
    const okOpen = done && !/Error:|unable to resolve|Exception/i.test(opened)
    return {
      to, url, pageUrl, port,
      opened,
      note: okOpen
        ? '已在设备上打开电脑画面。若没自动播放，请手动用它的浏览器打开这个地址。'
        : `设备没有自动选择浏览器，请手动用它的浏览器打开：${pageUrl}`,
    }
  }

  async function startCast(device, mode) {
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接电视'), { status: 409 })
    const wantComputer = String(mode || 'computer') !== 'phone'
    const pkg = 'com.xiaomi.mitv.smartshare'
    const out = []
    // 先把投屏 App 拉到前台。
    const main = await adb(withTarget(['shell', 'am', 'start', '-n', `${pkg}/.MainActivity`], t), { timeout: 20000 })
    out.push(`${main.stdout || ''}${main.stderr || ''}`.trim())
    await sleep(1500)
    if (wantComputer) {
      // 左侧「电脑投屏」大约在屏幕高度的 45% 处（1920x1080 下约 y=480, x=162）。
      const size = await adb(withTarget(['shell', 'wm', 'size'], t), { timeout: 8000 })
      const m = /(\d{2,5})x(\d{2,5})/.exec(size.stdout || '')
      const w = m ? Number(m[1]) : 1920
      const h = m ? Number(m[2]) : 1080
      const x = Math.round(w * 0.085)
      const y = Math.round(h * 0.445)
      const tap = await adb(withTarget(['shell', 'input', 'tap', String(x), String(y)], t), { timeout: 10000 })
      out.push(`已点击「电脑投屏」（${x},${y}）${(tap.stdout || '').trim()}`)
      await sleep(1200)
    }
    // 顺便查一下这台设备在局域网里的 AirPlay 名字（电脑端选它时要认这个名）。
    let airplay = ''
    try {
      const zone = await dnsSdZone('_airplay._tcp', 2000)
      const ip = (t || '').split(':')[0]
      for (const rec of mergeDnsSdRecords(parseDnsSdZone(zone))) {
        const rip = await resolveHostV4(rec.host)
        if (rip && ip && rip === ip) { airplay = rec.model || rec.host || ''; break }
      }
    } catch { /* ignore */ }
    const ip = (t || '').split(':')[0]
    return {
      device: t,
      mode: wantComputer ? '电脑投屏' : '手机投屏',
      airplayName: airplay,
      ip,
      steps: out.filter(Boolean),
      hint: wantComputer
        ? `电视已切到「电脑投屏」。现在在电脑上打开 控制中心 → 屏幕镜像，选「${airplay || '这台电视'}」即可投屏（macOS 原生 AirPlay，电视端已就绪）。`
        : '电视已切到「手机投屏」。',
    }
  }

  async function listDir(dir, device) {
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接手机'), { status: 409 })
    const path = String(dir || cfg.downloadDir)
    const r = await adb(withTarget(['shell', 'ls', '-la', path], t), { timeout: 15000 })
    return { path, listing: `${r.stdout || ''}${r.stderr || ''}`.trim(), device: t }
  }

  /** 结构化列出设备目录，供面板当文件管理器用（返回子目录/文件、父目录）。 */
  async function browseDir(dir, device) {
    const t = await resolveTarget(device)
    if (!t) throw Object.assign(new Error('还没有连接设备'), { status: 409 })
    let path = String(dir || '/sdcard').trim() || '/sdcard'
    path = path.replace(/\/+$/, '') || '/'
    // 用尾斜杠让 ls 跟随符号链接（/sdcard 常是指向 /storage/emulated/0 的软链）。
    const lsTarget = path === '/' ? '/' : path + '/'
    const r = await adb(withTarget(['shell', 'ls', '-la', lsTarget], t), { timeout: 15000 })
    const out = `${r.stdout || ''}`
    const entries = []
    for (const line of out.split('\n')) {
      const s = line.trim()
      if (!s || /^total\s/i.test(s)) continue
      const toks = s.split(/\s+/)
      const dateIdx = toks.findIndex((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
      if (dateIdx < 0) continue
      const name = toks.slice(dateIdx + 2).join(' ')
      if (!name || name === '.' || name === '..') continue
      let nm = name
      if (s[0] === 'l' && nm.includes(' -> ')) nm = nm.split(' -> ')[0]
      entries.push({ name: nm, dir: s[0] === 'd', size: Number(toks[dateIdx - 1]) || 0 })
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    const parent = path === '/' ? '' : (path.replace(/\/[^/]+$/, '') || '/')
    const err = !entries.length && r.stderr ? String(r.stderr).trim() : ''
    return { path, parent, entries, error: err, device: t }
  }

  /** 用系统 python3 + cv2 解二维码，返回识别到的文本。 */
  async function decodeQr(buffer) {
    const tmp = await mkdtemp(join(tmpdir(), 'dsh-qr-'))
    const file = join(tmp, 'qr.png')
    await writeFile(file, buffer)
    const py = pythonCandidates().find((p) => { try { return statSync(p).isFile() } catch { return false } }) || 'python3'
    const script = [
      'import sys, json, cv2',
      'img = cv2.imread(sys.argv[1])',
      'if img is None:',
      '    print(json.dumps({"ok": False, "error": "无法读取图片"})); sys.exit(0)',
      'found = ""',
      'for name in ("QRCodeDetector", "QRCodeDetectorAruco"):',
      '    det = getattr(cv2, name, None)',
      '    if det is None:',
      '        continue',
      '    try:',
      '        d = det()',
      '        data, pts, _ = d.detectAndDecode(img)',
      '        if data:',
      '            found = data',
      '            break',
      '    except Exception:',
      '        pass',
      'if found:',
      '    print(json.dumps({"ok": True, "text": found}))',
      'else:',
      '    print(json.dumps({"ok": False, "error": "没有识别到二维码"}))',
    ].join('\n')
    try {
      const r = await pexec(py, ['-c', script, file], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 })
      let parsed
      try { parsed = JSON.parse(String(r.stdout || '').trim() || '{}') } catch { parsed = { ok: false, error: 'python 输出异常：' + String(r.stdout || r.stderr || '') } }
      return parsed
    } catch (error) {
      return { ok: false, error: String(error.stderr || error.message || '二维码识别失败') }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** 解析二维码文本并执行连接/配对。支持 Android 配对二维码与常见地址/JSON 形式。 */
  async function handleQrText(text) {
    const raw = String(text || '').trim()
    if (!raw) throw Object.assign(new Error('二维码内容为空'), { status: 400 })
    // 1) Android 无线调试配对二维码：WIFI:T:ADB;S:<服务名>;P:<配对码>;;
    const wifi = /WIFI:[^;]*;S:([^;]+);(?:[^;]*;)?P:([^;]+);/i.exec(raw)
    if (wifi) {
      const service = wifi[1].trim()
      const code = wifi[2].trim()
      const m = await discover()
      const hit = m.pairing.find((e) => service.includes(e.label) || e.label.includes(service) || service === e.label) || m.pairing[0]
      if (!hit) throw Object.assign(new Error('已读到配对二维码，但没有发现配对服务。请在手机上停留在“配对设备”页面后重试。'), { status: 400 })
      const result = await pair(hit.address, code)
      return { text: raw, mode: 'wifi-pair', service, ...result }
    }
    // 2) 从文本里抽 IP:端口 与可能的 6 位配对码
    const addrMatch = /([0-9]{1,3}(?:\.[0-9]{1,3}){3}):(\d{2,5})/.exec(raw)
    if (!addrMatch) throw Object.assign(new Error('二维码里没找到 IP:端口'), { status: 400 })
    const address = `${addrMatch[1]}:${addrMatch[2]}`
    const codeMatch = /(?:code|pwd|pin|配对码)[=:：\s]*(\d{4,8})/i.exec(raw) || /#(\d{4,8})\b/.exec(raw) || /(?:^|[^\d])(\d{6})(?:[^\d]|$)/.exec(raw)
    const code = codeMatch ? codeMatch[1] : ''
    if (code) { const result = await pair(address, code); return { text: raw, mode: 'pair', code, ...result } }
    const result = await connect(address)
    return { text: raw, mode: 'connect', ...result }
  }

  /** 生成一个二维码 PNG（base64 dataUrl）。用于分享连接地址等。 */
  async function qrGenerate(text) {
    const content = String(text || '').trim()
    if (!content) throw Object.assign(new Error('二维码内容为空'), { status: 400 })
    const tmp = await mkdtemp(join(tmpdir(), 'dsh-qrgen-'))
    const file = join(tmp, 'qr.png')
    const py = pythonCandidates().find((p) => { try { return statSync(p).isFile() } catch { return false } }) || 'python3'
    try {
      const r = await pexec(py, ['-c', 'import sys, qrcode; qrcode.make(sys.argv[1]).save(sys.argv[2])', content, file], { timeout: 20000 })
      if (!existsSync(file)) throw new Error(String(r.stderr || '生成失败（可能缺少 python qrcode 库）'))
      const buf = await readFile(file)
      return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, text: content }
    } finally { await rm(tmp, { recursive: true, force: true }).catch(() => {}) }
  }

  // ---- 手机端 App（手机遥控伴侣）直连：不依赖 adb ----
  // App 的无障碍服务在手机上开一个端口（首选 8765，被占用时自动顺延）。
  const COMPANION_TOKEN = 'dsh-phone'
  const COMPANION_PORT_FROM = 8765
  const COMPANION_PORT_TO = 8785

  /** 探测某台手机上的 App 控制服务：找到就返回实际端口。 */
  async function companionProbe(ip) {
    const host = String(ip || '').trim()
    if (!host) throw Object.assign(new Error('缺少手机 IP'), { status: 400 })
    for (let port = COMPANION_PORT_FROM; port <= COMPANION_PORT_TO; port += 1) {
      const result = await companionRequest(host, port, 'GET', '/ping')
      if (result.ok && result.body && result.body.ok) {
        return { running: true, port: Number(result.body.port) || port, ip: host }
      }
    }
    return { running: false, port: 0, ip: host }
  }

  /** 调用手机 App 的控制接口。 */
  async function companionRequest(ip, port, method, path, payload) {
    const url = `http://${ip}:${port}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    try {
      const init = { method, headers: { 'x-token': COMPANION_TOKEN }, signal: controller.signal }
      if (payload !== undefined) {
        init.headers = { ...init.headers, 'content-type': 'application/json' }
        init.body = JSON.stringify(payload)
      }
      const resp = await fetch(url, init)
      const text = await resp.text()
      let body = null
      try { body = JSON.parse(text) } catch { body = { raw: text } }
      return { ok: resp.ok, status: resp.status, body }
    } catch (e) {
      return { ok: false, status: 0, body: null, error: String(e.message || e) }
    } finally { clearTimeout(timer) }
  }

  /** 通过 App 操控手机（点按/滑动/输入/按键/启动/控件树）。 */
  async function companionCommand(ip, action, payload) {
    const probe = await companionProbe(ip)
    if (!probe.running) throw Object.assign(new Error('手机上的「手机遥控伴侣」服务没在运行，请先开启无障碍'), { status: 409 })
    const routes = {
      tree: ['GET', '/tree'],
      apps: ['GET', '/apps'],
      tap: ['POST', '/tap'],
      swipe: ['POST', '/swipe'],
      text: ['POST', '/text'],
      key: ['POST', '/key'],
      launch: ['POST', '/launch'],
    }
    const route = routes[action]
    if (!route) throw Object.assign(new Error('不支持的操作'), { status: 400 })
    const result = await companionRequest(probe.ip, probe.port, route[0], route[1], route[0] === 'GET' ? undefined : payload)
    if (!result.ok) throw Object.assign(new Error(`App 服务返回 ${result.status}`), { status: 502 })
    return { ...result.body, port: probe.port, ip: probe.ip }
  }

  // ---- 实时画面：screenrecord(H.264) → ffmpeg(MJPEG multipart) → 浏览器 <img> ----
  // 手机/电视都是 adb 设备，通用。
  // 每台设备只跑一个采集进程，多个查看者共享同一批帧
  // （设备端 screenrecord 只能有一个，第二个会抢编码器把画面搞卡/搞黑）。
  const liveHubs = new Map()   // serial -> {res:Set, stop:boolean, child, lastFrame}
  // 本插件起过的所有采集进程（shell/adb/ffmpeg）。插件重装或卸载时必须全部杀掉，
  // 否则它们会继续占着设备的视频编码器 → 新流黑屏、设备卡死。
  const ownedChildren = new Set()

  async function liveStream(req, res, url) {
    const ffmpeg = resolveFfmpeg(cfg)
    if (!ffmpeg) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('未找到 ffmpeg，请在插件配置里设置 ffmpegPath（实时画面需要它把屏幕编码成视频流）')
      return
    }
    const bin = resolveAdb(cfg)
    const device = url.searchParams.get('device') || ''
    const serial = await resolveTarget(device).catch(() => null)
    if (!serial) {
      res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('没有可用的设备')
      return
    }
    const quality = String(Math.min(20, Math.max(2, Number(url.searchParams.get('q')) || 9)))
    // 清晰度不重要、流畅优先：按设备真实宽高比缩到长边约 640，低清 screenrecord 带宽小、帧率高。
    let size = /^\d{2,4}x\d{2,4}$/.test(url.searchParams.get('size') || '') ? url.searchParams.get('size') : ''
    let tw = 0, th = 0
    if (!size) {
      let dw = 0, dh = 0
      try {
        const wm = await adb(withTarget(['shell', 'wm', 'size'], serial), { timeout: 8000 })
        const m = /(\d{2,5})x(\d{2,5})/.exec(wm.stdout || '')
        if (m) { dw = Number(m[1]); dh = Number(m[2]) }
      } catch { /* ignore */ }
      if (dw && dh) {
        const long = Math.max(dw, dh)
        const scale = Math.min(1, 640 / long)
        const even = (n) => Math.max(16, Math.round(n * scale / 16) * 16)
        size = `${even(dw)}x${even(dh)}`
      } else {
        size = '640x360'
      }
    }
    try { const [w, h] = size.split('x').map(Number); tw = w; th = h } catch { /* ignore */ }

    // ---- 每台设备一个「采集中心」(hub)，多个查看者共享同一批帧 ----
    // 设备端 screenrecord 同时只能有一个，多开会抢视频编码器 → 画面卡/黑屏/设备卡死。
    let hub = liveHubs.get(serial)
    if (!hub) {
      hub = { res: new Set(), stop: false, child: null, lastFrame: null, lastFrameAt: 0, started: false }
      liveHubs.set(serial, hub)
      startLiveHub(serial, hub, { bin, ffmpeg, size, tw, th, quality })
    }
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=ffmpeg',
      'cache-control': 'no-cache, no-store, must-revalidate',
      pragma: 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    })
    hub.res.add(res)
    // 先写一个 1x1 的占位 JPEG，把 HTTP 响应头立刻冲出去
    // （否则浏览器要等到第一帧真画面才收到头，看起来像「打不开」）。
    try {
      const blank = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDziiiimI//2Q==', 'base64')
      res.write(`--ffmpeg\r\nContent-Type: image/jpeg\r\nContent-Length: ${blank.length}\r\n\r\n`)
      res.write(blank)
      res.write('\r\n')
    } catch { /* ignore */ }
    const drop = () => {
      hub.res.delete(res)
      // 没人看了就停掉采集，别让设备端 screenrecord 一直占着编码器。
      if (!hub.res.size) {
        hub.stop = true
        try { if (hub.child) process.kill(-hub.child.pid, 'SIGKILL') } catch { /* ignore */ }
        liveHubs.delete(serial)
        adb(withTarget(['shell', 'pkill -9 screenrecord 2>/dev/null; pkill -9 -f "screenrecord --output-format" 2>/dev/null || true'], serial), { timeout: 6000 }).catch(() => {})
        // 没人在看了，把「常亮」彻底恢复，别让屏幕一直自己亮着。
        adb(withTarget(['shell', 'svc power stayon false'], serial), { timeout: 6000 }).catch(() => {})
        adb(withTarget(['shell', 'settings put system screen_off_timeout 600000'], serial), { timeout: 6000 }).catch(() => {})
      }
      try { res.end() } catch { /* ignore */ }
    }
    req.on('close', drop)
    res.on('close', drop)
    res.on('error', drop)
  }

  /** 采集中心的循环：只跑一个 screenrecord，把帧分发给所有查看者。 */
  function startLiveHub(serial, hub, o) {
    const { bin, ffmpeg, size, tw, th, quality } = o
    const killDeviceScreenrecord = () => adb(withTarget([
      'shell', 'pkill -9 screenrecord 2>/dev/null; pkill -9 -f "screenrecord --output-format" 2>/dev/null || true',
    ], serial), { timeout: 6000 }).catch(() => {})
    const wake = () => adb(withTarget(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], serial), { timeout: 8000 }).catch(() => {})
    const push = (buf) => {
      if (!buf || buf.length < 200) return
      hub.lastFrame = buf
      hub.lastFrameAt = Date.now()
      for (const r of hub.res) {
        try {
          r.write(`--ffmpeg\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`)
          r.write(buf)
          r.write('\r\n')
        } catch { /* 断开时忽略 */ }
      }
    }
    const runScreenrecord = () => new Promise((resolve) => {
      if (hub.stop) { resolve(0); return }
      const cmd = `"${bin}" -s "${serial}" exec-out screenrecord --output-format=h264 --time-limit 12 --size ${size} - | ` +
        `"${ffmpeg}" -hide_banner -loglevel error -f h264 -i pipe:0 -vf fps=10 -c:v mjpeg -q:v ${quality} -flush_packets 1 -f mpjpeg -`
      let finished = false
      const done = () => { if (!finished) { finished = true; hub.child = null; resolve(1) } }
      try { hub.child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'], detached: true }) } catch { done(); return }
      ownedChildren.add(hub.child)
      hub.child.on('close', () => ownedChildren.delete(hub.child))
      // ffmpeg 的 mpjpeg 输出自带 --ffmpeg 边界，整段转发即可。
      hub.child.stdout.on('data', (d) => {
        if (hub.stop) return
        // 只有真的带出 JPEG 画面才算「有实时帧」；
        // 仅输出个边界头（画面静止时）不算，否则定时截图会被误抑制。
        if (d.includes(0xff) && d.includes(0xd8)) hub.lastFrameAt = Date.now()
        for (const r of hub.res) { try { r.write(d) } catch { /* ignore */ } }
      })
      hub.child.on('close', done)
      hub.child.on('error', done)
    })
    // 兜底：设备息屏/静止时 screenrecord 可能不出帧，用一张 screencap 截图顶上。
    const grabShot = () => new Promise((resolve) => {
      if (hub.stop) { resolve(null); return }
      // 快照：设备端先存文件再传回（比 exec-out 直连快约 3 倍），再做缩放转 MJPEG。
      const f = '/sdcard/_dsh_live.png'
      let cap1
      try { cap1 = spawn(bin, ['-s', serial, 'shell', `screencap -p ${f}`], { stdio: 'ignore', detached: true }) } catch { resolve(null); return }
      ownedChildren.add(cap1); cap1.on('close', () => ownedChildren.delete(cap1))
      cap1.on('error', () => resolve(null))
      cap1.on('close', () => {
        if (hub.stop) { resolve(null); return }
        let cap
        try { cap = spawn(bin, ['-s', serial, 'exec-out', 'cat', f], { stdio: ['ignore', 'pipe', 'ignore'], detached: true }) } catch { resolve(null); return }
        ownedChildren.add(cap); cap.on('close', () => ownedChildren.delete(cap))
        const chunks = []
        cap.stdout.on('data', (d) => chunks.push(d))
        cap.on('error', () => resolve(null))
        cap.on('close', () => {
          const png = Buffer.concat(chunks)
          if (hub.stop || png.length < 100 || png[1] !== 0x50) { resolve(null); return }
          let ff
          try {
            const args = ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0']
            if (tw && th) args.push('-vf', `scale=${tw}:${th}`)
            args.push('-q:v', quality, '-f', 'image2pipe', '-c:v', 'mjpeg', '-')
            ff = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'ignore'], detached: true })
          } catch { resolve(null); return }
          const out = []
          ff.stdout.on('data', (d) => out.push(d))
          ff.on('error', () => resolve(null))
          ff.on('close', () => resolve(out.length ? Buffer.concat(out) : null))
          try { ff.stdin.on('error', () => {}); ff.stdin.write(png); ff.stdin.end() } catch { resolve(null) }
        })
      })
    })
    ;(async () => {
      await killDeviceScreenrecord()
      // 串流期间临时开「插电即常亮」，避免息屏后录到黑屏。
      // 注意：只在开始时唤醒一次屏幕（不再周期性唤醒），结束时会恢复。
      adb(withTarget(['shell', 'svc power stayon true'], serial), { timeout: 6000 }).catch(() => {})
      adb(withTarget(['shell', 'settings put system screen_off_timeout 2147483647'], serial), { timeout: 6000 }).catch(() => {})
      await wake()
      let lastWake = Date.now()
      // screenrecord 只在画面「有变化」时出帧；画面静止时它会一直不出。
      // 所以另开一个定时截图，保证观看者任何时候都能看到当前画面。
      // grabbing 标记防止截图/编码重叠（2 秒一张，重叠会又去抢编码器）。
      let grabbing = false
      const ticker = setInterval(() => {
        if (hub.stop || grabbing) return
        // 最近 1 秒内已经有实时帧了，就不重复用截图刷。
        if (Date.now() - hub.lastFrameAt < 600) return
        grabbing = true
        grabShot().then((shot) => { if (shot) push(shot) }).catch(() => {}).finally(() => { grabbing = false })
      }, 500)
      if (typeof ticker.unref === 'function') ticker.unref()
      while (!hub.stop) {
        const online = await usable(serial).catch(() => false)
        if (!online) { await sleep(1500); continue }
        // 不再周期性发 KEYCODE_WAKEUP：那会反复触发人脸/指纹「智能解锁」。
        // 靠 keepAwake 里设的超长息屏时间防止自动灭屏就够了。
        const started = Date.now()
        await runScreenrecord()
        if (hub.stop) break
        // 这一段不满 2 秒就结束 = 没出帧（多半画面静止），补一张截图保底（不唤醒）。
        if (Date.now() - started < 2000) {
          if (!grabbing) {
            grabbing = true
            try { push(await grabShot()) } finally { grabbing = false }
          }
          await sleep(600)
        } else {
          await sleep(200)
        }
      }
      clearInterval(ticker)
      await killDeviceScreenrecord()
      // 恢复手机原本的亮屏设置（别让用户手机一直亮着）。
      adb(withTarget(['shell', 'svc power stayon false'], serial), { timeout: 6000 }).catch(() => {})
      adb(withTarget(['shell', 'settings put system screen_off_timeout 600000'], serial), { timeout: 6000 }).catch(() => {})
    })().catch(() => {})
  }

  async function handle(req, res, url) {
    const path = url.pathname.slice(PREFIX.length) || '/'
    if (path === '/live') return liveStream(req, res, url)
    if (path === '/status') return ok(res, await status())
    if (path === '/discover') return ok(res, await discover())
    if (path === '/select') { const b = await readJson(req); return ok(res, await select(String(b.device || ''))) }
    if (path === '/connect') { const b = await readJson(req); return ok(res, await connect(b.address)) }
    if (path === '/pair') { const b = await readJson(req); return ok(res, await pair(b.address, b.code, b.connectionAddress)) }
    if (path === '/disconnect') { const b = await readJson(req); return ok(res, await disconnect(b.device)) }
    if (path === '/reconnect') { const b = await readJson(req); return ok(res, await reconnect(b.device)) }
    if (path === '/rename') { const b = await readJson(req); return ok(res, await rename(b.device, b.name)) }
    if (path === '/adb-reset') return ok(res, await adbReset())
    if (path === '/aix-deploy') { const b = await readJson(req); return ok(res, await aixDeploy(b)) }
    if (path === '/aix-device') { const b = await readJson(req); return ok(res, await aixDevice(b)) }
    if (path === '/pick') { const b = await readJson(req); return ok(res, await pickPath(b.kind)) }
    if (path === '/command') { const b = await readJson(req); return ok(res, await runCommand(b.device, b.text)) }
    if (path === '/watcher') return ok(res, { notes: watchNotes(), reconnects: watcher.reconnects })
    if (path === '/companion') { const b = await readJson(req); return ok(res, await companionProbe(b.ip)) }
    if (path === '/companion-command') { const b = await readJson(req); return ok(res, await companionCommand(b.ip, b.action, b.payload)) }
    if (path === '/shell') { const b = await readJson(req); return ok(res, await shell(String(b.command || ''), b.device)) }
    if (path === '/list') { const b = await readJson(req); return ok(res, await listDir(b.path, b.device)) }
    if (path === '/browse') { const b = await readJson(req); return ok(res, await browseDir(b.path, b.device)) }
    if (path === '/input') { const b = await readJson(req); return ok(res, await input(b)) }
    if (path === '/launch') { const b = await readJson(req); return ok(res, await launch(b.package, b.device)) }
    if (path === '/cast') { const b = await readJson(req); return ok(res, await startCast(b.device, b.mode)) }
    if (path === '/keepawake') { const b = await readJson(req); return ok(res, await keepAwake(b.device, b.on)) }
    if (path === '/tapfrac') { const b = await readJson(req); return ok(res, await tapFrac(b.device, b.fx, b.fy)) }
    if (path === '/ai') { const b = await readJson(req); return ok(res, await aiControl(b.device, b.text)) }
    if (path === '/bridge') { const b = await readJson(req); return ok(res, await bridgeStream(b.from, b.to, b.opts)) }
    if (path === '/pcstream') { const b = await readJson(req); return ok(res, await pcStreamTo(b.device, b.opts)) }
    if (path === '/screencap') { const b = await readJson(req); return ok(res, await screencap(b.device)) }
    if (path === '/upload') return ok(res, await upload(req))
    if (path === '/install-start') return ok(res, await startInstall(req))
    if (path === '/install-status') { const b = await readJson(req); return ok(res, installStatus(b.jobId)) }
    if (path === '/qr') {
      const chunks = []
      let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 20 * 1024 * 1024) throw Object.assign(new Error('二维码图片太大'), { status: 413 }); chunks.push(chunk) }
      const decoded = await decodeQr(Buffer.concat(chunks))
      if (!decoded.ok) return ok(res, { decoded: false, error: decoded.error })
      let acted = null, actionError = null
      try { acted = await handleQrText(decoded.text) } catch (e) { actionError = String(e.message || e) }
      return ok(res, { decoded: true, text: decoded.text, acted, actionError })
    }
    if (path === '/qrgen') { const b = await readJson(req); return ok(res, await qrGenerate(b.text)) }
    return fail(res, 404, '接口不存在')
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        try {
          if (!makeTrust(req, bindHost)) { fail(res, 403, '未授权'); return }
          const url = new URL(req.url ?? '/', 'http://localhost')
          await handle(req, res, url)
        } catch (error) {
          if (res.headersSent) { res.end(); return }
          fail(res, error?.status || 500, (error && (error.message || error)) || '未知错误')
        }
      },
    }),
    'dsh-phone-remote: /api/phone-remote routes',
  )

  // 插件卸载时停掉看护定时器。
  ctx.effect(() => () => stopWatcher(), 'dsh-phone-remote: watcher cleanup')
  // 插件卸载/重装时必须做三件事，否则旧实例会一直占着设备的视频编码器
  // → 新开的串流黑屏、设备卡死（电视上尤其明显）：
  //   1) 杀掉本插件起过的所有采集进程
  //   2) 停掉所有采集中心
  //   3) 清掉设备端残留的 screenrecord，并关掉转串流的 HTTP 服务
  ctx.effect(() => () => {
    for (const c of ownedChildren) {
      try { process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch { /* ignore */ } }
    }
    ownedChildren.clear()
    for (const hub of liveHubs.values()) {
      hub.stop = true
      try { if (hub.child) process.kill(-hub.child.pid, 'SIGKILL') } catch { /* ignore */ }
    }
    liveHubs.clear()
    for (const b of bridgeServers) { try { b.server.close() } catch { /* ignore */ } }
    bridgeServers.length = 0
    adb(['devices'], { timeout: 8000 }).then((list) => {
      if (!list.ok) return
      for (const line of list.stdout.split('\n').slice(1)) {
        const m = /(\S+)\s+device$/.exec(line.trim())
        if (!m) continue
        adb(['-s', m[1], 'shell', 'pkill -9 -f "screenrecord" 2>/dev/null || true'], { timeout: 6000 }).catch(() => {})
      }
    }).catch(() => {})
  }, 'dsh-phone-remote: live cleanup')

  // ---- 给 Agent 的操控工具 ----
  ctx.inject(['tools'], (sctx) => {
    const obj = (properties, required) => ({ type: 'object', properties, ...(required && required.length ? { required } : {}) })
    const textOut = (schema, toText) => ({ schema, render: (_a, v) => [{ type: 'text', text: toText(v) }] })
    const DEV = { type: 'string', description: '可选：目标设备序列号（多台手机时指定）。省略则用当前选中设备。' }

    const defs = [
      {
        name: 'phone_devices',
        description: '列出当前通过无线 adb 连接的所有手机，含机型、地址、是否当前选中。',
        parameters: obj({}),
        output: textOut(obj({ active: { type: 'string' }, devices: { type: 'array', items: obj({ serial: { type: 'string' }, state: { type: 'string' }, model: { type: 'string' }, active: { type: 'boolean' } }) } }, ['devices']),
          (v) => `当前设备：${v.active || '（未选）'}\n` + (v.devices || []).map((d) => `${d.active ? '●' : '○'} ${d.model || ''} ${d.serial} [${d.state}]`).join('\n')),
        async execute() { const s = await status(); return { active: s.active || '', devices: s.devices } },
      },
      {
        name: 'phone_apps',
        description: '列出手机里已安装的 App（显示名 + 包名）。打开某个软件前先查一下，能拿到真实包名；也可以直接用 phone_command 说「打开 XX」，会自动匹配。',
        parameters: obj({ device: { type: 'string', description: '可选：设备名或序列号。省略则用当前选中设备' } }),
        output: textOut(obj({ apps: { type: 'array', items: obj({ label: { type: 'string' }, package: { type: 'string' } }) } }), (v) => (v.apps || []).map((a) => `${a.label} → ${a.package}`).join('\n') || '没有读到 App 列表'),
        async execute(args) {
          const identity = String(args.device || '').trim()
          const serial = identity ? await resolveDeviceIdentity(identity) : await resolveTarget('')
          const ip = (serial && roster[deviceKey(serial)] && roster[deviceKey(serial)].ip) || ipOfSerial(serial || '')
          let apps = []
          if (ip) {
            try {
              const probe = await companionProbe(ip)
              if (probe.running) {
                const r = await companionCommand(probe.ip, 'apps')
                if (r && Array.isArray(r.apps)) apps = r.apps
              }
            } catch { /* 忽略 */ }
          }
          if (!apps.length && serial) {
            try {
              if (await usable(serial)) {
                const r = await adb(withTarget(['shell', 'cmd', 'package', 'query-activities', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER'], serial), { timeout: 12000 })
                if (r.ok && r.stdout) {
                  apps = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('/')).map((l) => ({ label: l.split('/')[0].trim(), package: l.split('/')[0].trim() }))
                }
              }
            } catch { /* 忽略 */ }
          }
          return { apps, device: serial || identity }
        },
      },
      {
        name: 'phone_connect',
        description: '连接手机（无线 adb）。不传地址时自动发现并连接；已连设备会被复用。',
        parameters: obj({ address: { type: 'string', description: '可选「IP:端口」。省略则自动发现' } }),
        output: textOut(obj({ target: { type: 'string' }, model: { type: 'string' } }), (v) => `已连接 ${v.model || ''} ${v.target}`.trim()),
        async execute(args) { return await connect(args.address) },
      },
      {
        name: 'phone_pair',
        description: '用配对码把一台新手机配对上（无线调试 → 使用配对码配对设备，读出 IP:端口 与 6 位配对码）。',
        parameters: obj({ address: { type: 'string', description: '配对地址 IP:端口' }, code: { type: 'string', description: '6 位配对码' } }, ['address', 'code']),
        output: textOut(obj({ paired: { type: 'boolean' }, connected: { type: 'string' }, output: { type: 'string' } }), (v) => v.connected ? `配对成功并已连接 ${v.connected}` : `配对完成，但未自动连上，请点自动发现。`),
        async execute(args) { return await pair(args.address, args.code) },
      },
      {
        name: 'phone_select',
        description: '切换当前控制的目标手机（多台时）。',
        parameters: obj({ device: { type: 'string', description: '设备序列号 IP:端口' } }, ['device']),
        output: textOut(obj({ active: { type: 'string' } }), (v) => `已切换控制 ${v.active}`),
        async execute(args) { return await select(args.device) },
      },
      {
        name: 'phone_screenshot',
        description: '截取手机当前屏幕并保存为 PNG，返回文件路径。随后用 read_image 查看。',
        parameters: obj({ device: DEV, savePath: { type: 'string', description: '可选：保存绝对路径' } }),
        output: textOut(obj({ path: { type: 'string' }, bytes: { type: 'number' }, device: { type: 'string' } }, ['path', 'bytes']), (v) => `截图已保存：${v.path}（${v.bytes} 字节，设备 ${v.device}）。用 read_image 打开查看。`),
        async execute(args) { return await saveScreenshot(args.device, args.savePath) },
      },
      {
        name: 'phone_tap', description: '点击手机屏幕坐标（像素）。',
        parameters: obj({ x: { type: 'number' }, y: { type: 'number' }, device: DEV }, ['x', 'y']),
        output: textOut(obj({ ok: { type: 'boolean' } }), (v) => v.ok ? '已点击' : '点击失败'),
        async execute(args) { const r = await input({ kind: 'tap', x: args.x, y: args.y, device: args.device }); return { ok: r.ok } },
      },
      {
        name: 'phone_swipe', description: '从一点滑到另一点（滚动/翻页/拖动）。',
        parameters: obj({ x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, durationMs: { type: 'number', description: '默认 300' }, device: DEV }, ['x1', 'y1', 'x2', 'y2']),
        output: textOut(obj({ ok: { type: 'boolean' } }), (v) => v.ok ? '已滑动' : '滑动失败'),
        async execute(args) { const r = await input({ kind: 'swipe', ...args }); return { ok: r.ok } },
      },
      {
        name: 'phone_type', description: '向当前焦点输入框输入文本（先点一下输入框再调用）。',
        parameters: obj({ text: { type: 'string' }, device: DEV }, ['text']),
        output: textOut(obj({ ok: { type: 'boolean' } }), (v) => v.ok ? '已输入' : '输入失败'),
        async execute(args) { const r = await input({ kind: 'text', text: args.text, device: args.device }); return { ok: r.ok } },
      },
      {
        name: 'phone_key', description: '发送系统按键：back/home/recents/enter/power/volumeUp/volumeDown。',
        parameters: obj({ key: { type: 'string' }, device: DEV }, ['key']),
        output: textOut(obj({ ok: { type: 'boolean' } }), (v) => v.ok ? '已发送按键' : '按键失败'),
        async execute(args) { const numeric = Number(args.key); const r = await input(Number.isFinite(numeric) && String(args.key).trim() !== '' ? { kind: 'key', code: numeric, device: args.device } : { kind: 'key', name: args.key, device: args.device }); return { ok: r.ok } },
      },
      {
        name: 'phone_launch', description: '启动手机上的 App。可以给包名（如 com.tencent.mm），也可以给显示名（如 微信）——给显示名时会自动读这台手机已装的 App 目录来匹配真实包名。',
        parameters: obj({ package: { type: 'string', description: '包名或 App 显示名' }, device: DEV }, ['package']),
        output: textOut(obj({ output: { type: 'string' }, package: { type: 'string' } }), (v) => v.output || `已启动 ${v.package || ''}`),
        async execute(args) {
          const wanted = String(args.package || '').trim()
          // 中文/别名交给 runCommand 的「打开 XX」解析器（内置别名表 + 动态 App 目录），
          // 只有纯包名才直接 launch。
          if (/^[\w.]+$/.test(wanted)) {
            try {
              const r = await launch(wanted, args.device)
              return { output: r.output, package: wanted }
            } catch { /* 落到下面的名称解析 */ }
          }
          const r = await runCommand(args.device, `打开 ${wanted}`)
          return { output: r.output || r.describe || '', package: (r.packages && r.packages[0]) || wanted }
        },
      },
      {
        name: 'phone_cast', description: '把电视切到「无线投屏 → 电脑投屏」等待页（用电视自带的投屏功能）。执行后电脑端打开 控制中心 → 屏幕镜像，选返回的 airplayName 即可把电脑画面投到电视上。',
        parameters: obj({ device: DEV, mode: { type: 'string', description: 'computer（默认，电脑投屏）或 phone（手机投屏）' } }),
        output: textOut(obj({ mode: { type: 'string' }, airplayName: { type: 'string' }, ip: { type: 'string' }, hint: { type: 'string' } }), (v) => v.hint || `已切到${v.mode || ''}`),
        async execute(args) {
          const r = await startCast(args.device, args.mode)
          return { mode: r.mode, airplayName: r.airplayName, ip: r.ip, hint: r.hint, steps: r.steps }
        },
      },
      {
        name: 'phone_command', description: '用一句话指挥手机（像对助理说话）：「打开微信」「截图」「返回」「大点声」「输入：你好」「点击 500 800」「向上滑」「界面结构」。多台手机时用 device 指定。',
        parameters: obj({ text: { type: 'string', description: '中文指令' }, device: DEV }, ['text']),
        output: textOut(obj({ describe: { type: 'string' }, dataUrl: { type: 'string' }, output: { type: 'string' } }), (v) => v.describe || v.output || '已执行'),
        async execute(args) {
          const r = await runCommand(args.device, args.text)
          return { describe: r.describe || '', dataUrl: r.dataUrl || '', output: r.output || '', via: r.via || 'adb' }
        },
      },
      {
        name: 'phone_ui', description: '导出当前界面 UI 层级（uiautomator XML），节点带 bounds 坐标，可据此精确点按。',
        parameters: obj({ device: DEV }),
        output: textOut(obj({ xml: { type: 'string' } }), (v) => v.xml || '（空）'),
        async execute(args) { return { xml: await uiDump(args.device) } },
      },
      {
        name: 'phone_companion_probe', description: '探测手机上「手机遥控伴侣」App 的控制服务是否在运行（不依赖 adb），返回实际端口。',
        parameters: obj({ ip: { type: 'string', description: '手机在局域网里的 IP' } }, ['ip']),
        output: textOut(obj({ running: { type: 'boolean' }, port: { type: 'number' }, ip: { type: 'string' } }), (v) => v.running ? `App 服务在运行：${v.ip}:${v.port}` : 'App 服务没在运行（请在手机上开启无障碍）'),
        async execute(args) { return await companionProbe(args.ip) },
      },
      {
        name: 'phone_companion', description: '通过手机上的「手机遥控伴侣」App 操控手机（不依赖 adb）。action: tree/tap/swipe/text/key/launch。',
        parameters: obj({
          ip: { type: 'string', description: '手机在局域网里的 IP' },
          action: { type: 'string', description: 'tree | tap | swipe | text | key | launch' },
          x: { type: 'number' }, y: { type: 'number' },
          x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
          text: { type: 'string' }, key: { type: 'string' }, package: { type: 'string' },
        }, ['ip', 'action']),
        output: textOut(obj({ ok: { type: 'boolean' }, output: { type: 'string' }, nodes: { type: 'array' } }), (v) => v.output || (v.nodes ? `${v.nodes.length} 个控件` : '完成')),
        async execute(args) {
          const payload = {
            tap: { x: args.x, y: args.y },
            swipe: { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2 },
            text: { text: args.text },
            key: { key: args.key },
            launch: { package: args.package },
          }[args.action] || {}
          return await companionCommand(args.ip, args.action, payload)
        },
      },
      {
        name: 'phone_shell', description: '在手机上执行一条 adb shell 命令并返回输出。',
        parameters: obj({ command: { type: 'string' }, device: DEV }, ['command']),
        output: textOut(obj({ stdout: { type: 'string' }, stderr: { type: 'string' }, code: { type: 'number' } }, ['stdout', 'stderr', 'code']), (v) => `[exit ${v.code}]\n${v.stdout}${v.stderr ? '\n[stderr] ' + v.stderr : ''}`),
        async execute(args) { const r = await shell(args.command, args.device); return { stdout: r.stdout, stderr: r.stderr, code: r.code } },
      },
      {
        name: 'phone_push', description: '把本机文件推送到手机指定目录。',
        parameters: obj({ localPath: { type: 'string' }, remoteDir: { type: 'string', description: '默认 /sdcard/Download' }, device: DEV }, ['localPath']),
        output: textOut(obj({ remote: { type: 'string' }, bytes: { type: 'number' } }, ['remote', 'bytes']), (v) => `已推送 ${v.bytes} 字节 → ${v.remote}`),
        async execute(args) {
          const t = await resolveTarget(args.device)
          if (!t) throw new Error('还没有连接手机')
          const dir = (args.remoteDir || cfg.downloadDir).replace(/\/$/, '')
          const remote = `${dir}/${basename(args.localPath)}`
          const r = await adb(withTarget(['push', args.localPath, remote], t), { timeout: 600000 })
          if (!r.ok) throw new Error(String(r.stderr || '推送失败'))
          let bytes = 0; try { bytes = statSync(args.localPath).size } catch { /* ignore */ }
          return { remote, bytes }
        },
      },
    ]

    sctx.effect(() => {
      const disposers = []
      for (const def of defs) { try { disposers.push(sctx.tools.register(def)) } catch (error) { try { console.error('[dsh-phone-remote] 工具注册失败', def.name, error) } catch { /* ignore */ } } }
      return () => { for (const fn of disposers) { try { fn() } catch { /* ignore */ } } }
    }, 'dsh-phone-remote: agent tools')
  })
}
