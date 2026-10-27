// EditLens mod: the /editlens command (panes here, the rest through bin/start.js), the line above
// the prompt, and the Details and Settings panes. The server keeps GET /summary open until something
// changes (25 s at most; an older server is polled every 2 s). Unknown values are left out, never
// shown as "—" or NaN. Needs Claude Code 2.1.287+ (desktop 2.1.286+).

const PANE = 'editlens-details'
const SETTINGS_PANE = 'editlens-settings'
const POLL_MS = 2000
const WAIT_S = 25 // how long the server may keep a GET /summary open until something changes
const LONG_FAILS_MAX = 3 // long requests failing one after another, plain ones working: back to the 2 s poll
const DASH = '—'

let summary = null // the latest GET /summary answer, with this session's own figures
let raw = null // the latest GET /summary answer as the server sent it
let seq = null // the summary's number in that answer (null: none yet, or an older server)
let instance = null // the server's start id in that answer (null: none yet, or an older server)
let polling = false // a GET /summary is in progress (never two at the same time)
let pollFails = 0 // failed requests, one after another
let pollSkip = 0 // ticks to wait before the next request
let longFails = 0 // long requests that failed, one after another
let off = false // the server didn't answer
let shown = '' // what was drawn last, to redraw only on a change
let port = 4317
let portByEnv = false // EDITLENS_PORT sets the port, not the Port setting
let options = {} // the plugin's settings, as Claude Code gave them to register()
let schema = {} // userConfig from plugin.json
let pluginVersion = null // this installed plugin's version, from plugin.json
let started = false
let reported = '' // the settings last sent to the server
const applied = new Set() // page requests already made in Claude Code
let busy = null // what /editlens is doing now, shown in the line
const drawnAt = {} // surface -> when it last asked to draw the line above the prompt (for /editlens details)
let noticeSeen = -1 // the last pairing notice shown (-1: none read yet)
let pairedFlash = null // { id, name }: "✓ Paired with ◆ name" on the line above the prompt for FLASH_MS
const pairedCodes = new Map() // a pairing code's id -> the notice of the computer that used it
export const FLASH_MS = 10000
let booting = null // 'starting' while this file starts the live server; the reason when that failed
let selectedSetting = null // the Settings pane's row with the focus (its description shows)
let refocus = false // the Settings pane's kept row gets the focus ring back once it is drawn
let settingsDrawn = false // the Settings pane was drawn since this file was loaded
let local = null // this session's model, context window and cost, from Claude Code itself
let armed = null // { key, value, at }: the Settings pane's first press on a change that needs two

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

export function fmtTokens(v) {
  const n = finite(v)
  if (n === null) return DASH
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

function fmtPct(v) {
  const n = finite(v)
  return n === null ? DASH : Math.round(n) + '%'
}

const MODE_LABELS = { default: 'Ask', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', dontAsk: "Don't ask", bypassPermissions: 'Bypass permissions' }
const STATE_LABELS = { working: 'Working', idle: 'Idle', stopped: 'Stopped', closed: 'Closed', starting: 'Starting', signin: 'Needs sign-in', unknown: DASH }

export function modeLabel(m) {
  return (m && MODE_LABELS[m]) || DASH
}

export function stateLabel(s) {
  return STATE_LABELS[s] || DASH
}

function modelLabel(m) {
  if (typeof m !== 'string' || !m) return DASH
  const x = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(m)
  if (!x) return m
  return x[1][0].toUpperCase() + x[1].slice(1) + ' ' + x[2] + (x[3] && x[3].length <= 2 ? '.' + x[3] : '')
}

// A Link takes https or http://localhost only; a page on 127.0.0.1 opens the same server there.
export function linkHref(url) {
  if (typeof url !== 'string' || !url) return null
  // Only an address is tried: a value such as "○ Manual" is never passed to URL.
  if (!/^https?:\/\/\S+$/i.test(url)) return null
  let u
  try {
    u = new URL(url)
  } catch (err) {
    // By name: URL is Claude Code's, so its TypeError is not this file's TypeError.
    if (err && err.name === 'TypeError') return null
    throw err
  }
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]')) u.hostname = 'localhost'
  if (u.username || u.password) return null
  if (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost')) return u.href
  return null
}

export const OFF_TEXT = "isn't running. Run /editlens to start it and connect your page."

// In Manual the page can't run Claude. -> the short how-to, or null in page control.
export function accessText(s) {
  if (!s || s.control === 'page') return null
  const pc = s.pageControl && typeof s.pageControl === 'object' ? s.pageControl : {}
  if (s.pageControlError) return 'Page control stopped: ' + s.pageControlError
  if (pc.installed === false) return 'Page control is off. Run /editlens control (sets it up once, about a minute).'
  if (pc.signedIn === false) return 'Page control needs sign-in. Run /editlens control, then Sign in on the page.'
  return 'Page control is off. Run /editlens control to run Claude from the page.'
}

function ctxColor(pct) {
  return pct === null ? 'subtle' : pct >= 80 ? 'error' : pct >= 50 ? 'warning' : 'success'
}

// A meter (10 cells by default) in box-drawing lines (every Windows font has them; some lack ▰ ▱).
// -> [filled, empty]
export function meter(pct, size = 10) {
  const n = finite(pct)
  const filled = n === null ? 0 : Math.max(0, Math.min(size, Math.round((n / 100) * size)))
  return ['━'.repeat(filled), '─'.repeat(size - filled)]
}

const MODE_COLORS = { default: 'permission', acceptEdits: 'autoAccept', plan: 'planMode', auto: 'autoAccept', dontAsk: 'warning', bypassPermissions: 'error' }

// What a tool call ran (command, script, address or file) for the desktop hover card, or null.
const DETAIL_KEYS = [['command', null], ['code', 'javascript'], ['script', 'javascript'], ['function', 'javascript'], ['url', null], ['file_path', null], ['path', null], ['pattern', null], ['query', null], ['text', null]]
export function toolDetail(tool, input) {
  if (!input || typeof input !== 'object') return null
  for (const [key, lang] of DETAIL_KEYS) {
    const v = input[key]
    if (typeof v !== 'string' || !v.trim()) continue
    // Code takes at most 10000 characters, with tab and newline the only control characters.
    const source = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 10000)
    const name = String(tool || '')
    const language = key === 'command' ? (/powershell/i.test(name) ? 'powershell' : 'bash') : lang
    return { label: key === 'command' ? 'Command' : key === 'url' ? 'Address' : key === 'file_path' || key === 'path' ? 'File' : key === 'pattern' || key === 'query' ? 'Search' : key === 'text' ? 'Text' : 'Code', source, language }
  }
  return null
}

// Paired computers: ◆ name, green when the computers are connected. -> [{ id, parts }]
export function pairedOf(s) {
  const p = s && s.paired && typeof s.paired === 'object' ? s.paired : {}
  const out = []
  for (const h of (Array.isArray(p.joined) ? p.joined : []).slice(0, 3)) {
    if (!h || typeof h.name !== 'string') continue
    const up = h.state === 'connected'
    out.push({ id: 'pair-' + h.name, parts: [{ text: '◆ ', color: up ? 'success' : 'warning' }, { text: h.name + (up ? '' : h.state === 'unreachable' ? " · can't connect" : ' · reconnecting'), dim: up, color: up ? undefined : 'warning' }] })
  }
  const by = (Array.isArray(p.host) ? p.host : []).filter((h) => h && typeof h.name === 'string')
  // A pairing is for one folder: in another folder the line names that folder. Computers are
  // counted by name, so two pairings of one computer count once (Details lists both).
  const here = by.filter((h) => h.here !== false)
  const names = [...new Set(here.map((h) => h.name))]
  if (here.length) {
    const mark = { text: '◆ ', color: here.some((h) => h.connected) ? 'success' : 'subtle' }
    out.push({ id: 'pair-host', parts: [mark, { text: (names.length === 1 ? names[0] : names.length === 2 ? names.join(' and ') : names.length + ' computers') + ' paired', dim: true }],
      ...(names.length === 2 ? { short: [mark, { text: '2 computers paired', dim: true }] } : {}) })
  }
  else if (by.length) {
    const folder = by.length === 1 && typeof by[0].folder === 'string' && by[0].folder ? by[0].folder : ''
    const mark = { text: '◆ ', color: 'subtle' }
    out.push({ id: 'pair-host', parts: [mark, { text: (by.length === 1 ? by[0].name : by.length + ' computers') + ' paired for ' + (folder || 'other folders'), dim: true }], short: [mark, { text: 'paired for ' + (folder || 'other folders'), dim: true }] })
  }
  return out
}

// How to open the page from the user's own computer when no browser opens here (summary.openFrom),
// or null. Only while no page of the project is open: an open page's own address works.
export function openFromOf(s) {
  const o = s && s.openFrom && typeof s.openFrom === 'object' ? s.openFrom : null
  if (!o || (Array.isArray(s.pages) && s.pages.length)) return null
  if (o.paired && typeof o.paired === 'object' && typeof o.paired.name === 'string') return { paired: { name: o.paired.name, url: linkHref(o.paired.url) } }
  if (typeof o.ssh === 'string' && o.ssh && typeof o.url === 'string') {
    const other = o.other && typeof o.other.name === 'string' && typeof o.other.folder === 'string' ? { name: o.other.name, folder: o.other.folder } : null
    // sshKey: the same line with -i and a key file (an older server sends none).
    const sshKey = typeof o.sshKey === 'string' && o.sshKey ? o.sshKey : null
    return { ssh: o.ssh, sshKey, url: o.url, other }
  }
  return null
}

// Cells a string uses. Everything the line draws itself is one cell per character; outside names
// (a file, a computer) are cut by the row's own truncation if too long.
export function cells(text) {
  return [...String(text || '')].length
}

const GAP = 3 // between parts of the line
// When each part is shortened or removed as the row narrows: higher means sooner. Others always stay.
const SHORTEN_AT = { ctx: 7.5, mode: 7, asks: 6, busy: 6, off: 6, 'pair-host': 7.3 }
const DROP_AT = { effort: 5.7, update: 3.2, tokens: 10, agents: 9, pair: 7.2, 'task-notice': 7, files: 6.5, signin: 6.5, access: 3, ctx: 5.5, state: 5, 'b-control': 4, 'b-manual': 4, 'b-connect': 4, 'b-open': 3.5 }
const BUTTON_GAP = 2 // between buttons

// Short busy words: what /editlens is doing, a longer note that is removed first, and an optional
// shorter note used before that.
export const BUSY = {
  'task-user': ['Setting up the task account', 'installing Claude Code for it can take a few minutes'],
  control: ['Starting page control', 'the first time downloads @anthropic-ai/claude-agent-sdk (made by Anthropic) from registry.npmjs.org, about 30 MB', 'the first time downloads @anthropic-ai/claude-agent-sdk, about 30 MB'],
  stop: ['Stopping', ''], restart: ['Restarting EditLens', 'then it does what /editlens does'], manual: ['Switching to Manual', ''], pair: ['Pairing', ''], connect: ['Connecting your page', ''],
}

// Effort levels as people read them (lib/effort.js LABELS; the mod imports nothing).
export const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
// One effort shape (summary.effort) as a word: the level Claude uses, "Effort not used" for a model
// without effort, or '' when nothing is known.
export function effortWord(e) {
  if (!e || typeof e !== 'object') return ''
  if (e.supported === false) return 'Effort not used'
  return EFFORT_LABELS[e.used] || EFFORT_LABELS[e.level] || ''
}

// The line above the prompt, always one row, fitted to `cols` cells (✦ included). -> [{ id, parts:
// [{ text, color, bold, dim, pill }] } or { id, button: { key, label, word | href | open } }]
// Least important parts are removed first: tokens, paired computer, context meter, Claude's state,
// buttons, Page control or Manual, waiting questions. The row cuts what is still too long.
export function bandItems({ s, busy, off, booting, cols, flash }) {
  const width = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 80
  const items = []
  const add = (id, parts, short, mid) => items.push({ id, parts, short, mid })
  const button = (id, b) => items.push({ id, button: b })
  const more = { key: 'details', label: 'Details', open: 'details' }
  // A computer just paired (either side): green, first, for FLASH_MS, never removed.
  if (flash && typeof flash.name === 'string') add('flash', [{ text: '✓ Paired with ◆ ' + flash.name, color: 'success' }])
  const waiting = !flash && s && s.paired && s.paired.waiting && typeof s.paired.waiting === 'object' ? s.paired.waiting : null
  if (busy) {
    const [what, note, midNote] = BUSY[busy] || [String(busy), '']
    const head = { text: what + '…', color: 'claude' }
    add('busy', [head, ...(note ? [{ text: ' · ' + note, dim: true }] : [])], [head], midNote ? [head, { text: ' · ' + midNote, dim: true }] : undefined)
  } else if (off) {
    if (booting === 'starting') add('off', [{ text: 'Starting…', dim: true }])
    else {
      const why = typeof booting === 'string' && booting ? booting : 'run /editlens to start it'
      add('off', [{ text: '✕ ', color: 'error' }, { text: 'Not running', bold: true }, { text: ' · ' + why, dim: true }], [{ text: '✕ ', color: 'error' }, { text: 'Not running', bold: true }])
      button('start', { key: 'start', label: 'Start', word: null })
      button('more', more)
    }
  } else if (s) {
    const asks = finite(s.permissions) || 0
    if (asks) add('asks', [{ text: ' ! ' + asks + (asks === 1 ? ' question ' : ' questions '), pill: true }, { text: ' waiting on your page', bold: true }],
      [{ text: ' ! ' + asks + (asks === 1 ? ' question ' : ' questions '), pill: true }, { text: ' on your page', bold: true }])
    const pages = Array.isArray(s.pages) ? s.pages : []
    const linked = pages.length > 0 || Boolean(s.connection)
    const page = s.control === 'page'
    if (!linked && !asks && !page) add('nopage', [{ text: 'No page connected', dim: true }])
    else {
      const mode = page ? [{ text: '● ', color: 'success' }, { text: 'Page control', bold: true }] : [{ text: '○ ' }, { text: 'Manual', bold: true }]
      add('mode', page && s.mode ? [...mode, { text: ' · ' + modeLabel(s.mode), dim: true }] : mode, mode)
    }
    if (s.pageControlError) add('access', [{ text: '✕ ', color: 'error' }, { text: 'Page control stopped', color: 'error' }])
    else if (!page && s.pageControl && s.pageControl.signedIn === false && s.pageControl.installed !== false) add('signin', [{ text: '! ', color: 'warning' }, { text: 'Page control needs sign-in', dim: true }])
    const up = updateInfo(s)
    if (up) add('update', [{ text: '! ', color: 'warning' }, { text: up.installed + ' installed, ' + up.running + ' running', dim: true }])
    // A pairing code waits for the other computer (removed once used or cancelled).
    if (waiting) {
      const left = finite(waiting.minutesLeft)
      add('pair-open', [{ text: '◆ ', color: 'warning' }, { text: 'Pairing open' + (left ? ' · ' + left + ' min' : ''), dim: true }])
    }
    // A task that waits or did not start, here or on a paired computer (summary.taskNotices).
    const tn = Array.isArray(s.taskNotices) && s.taskNotices[0] && typeof s.taskNotices[0].short === 'string' ? s.taskNotices[0] : null
    if (tn) add('task-notice', [{ text: tn.state === 'refused' ? '✕ ' : '! ', color: tn.state === 'refused' ? 'error' : 'warning' }, { text: tn.short + (s.taskNotices.length > 1 ? ' · ' + (s.taskNotices.length - 1) + ' more in Details' : ''), dim: true }])
    if (linked || page) {
      for (const p of pairedOf(s)) add(p.id, p.parts, p.short)
      add('state', [{ text: stateLabel(s.state), color: s.state === 'working' ? 'claude' : s.state === 'signin' ? 'warning' : undefined, dim: s.state !== 'working' && s.state !== 'signin' }])
      // The effort level, one dim word (page control's, or this terminal's own).
      const word = effortWord(s.effort)
      if (word) add('effort', [{ text: word, dim: true }])
      const running = finite(s.agentsRunning) || 0
      if (running) add('agents', [{ text: running + (running === 1 ? ' agent' : ' agents'), color: 'claude' }])
      const t = s.tokens || {}
      const pct = finite(t.percent)
      if (pct !== null) {
        const [full, empty] = meter(pct)
        const hot = pct >= 80
        const tail = [{ text: ' ' + fmtPct(pct), color: hot ? 'error' : undefined, dim: !hot }, ...(hot ? [{ text: ' · /compact', dim: true }] : [])]
        add('ctx', [{ text: 'context ', dim: true }, { text: full, color: ctxColor(pct) }, { text: empty, dim: true }, ...tail], [{ text: fmtPct(pct), color: hot ? 'error' : undefined, dim: !hot }])
      }
      const total = totalTokens(s)
      if (total !== null) add('tokens', [{ text: fmtTokens(total) + ' tokens', dim: true }])
      const files = integrationFiles(s)
      if (files.length) add('files', [{ text: '! ', color: 'warning' }, { text: 'in ' + files.join(', '), dim: true }])
    }
    // Disconnect is in Details; with no page, connecting is shown first.
    for (const a of actionButtons(s).filter((x) => x.key !== 'stop' && (linked || page || x.key !== 'control'))) button('b-' + a.key, a.href ? { key: a.key, label: a.label, href: a.href } : a.open ? { key: a.key, label: a.label, open: a.open } : { key: a.key, label: a.label, word: a.word })
    button('more', more)
  } else {
    add('off', [{ text: 'Starting…', dim: true }])
  }
  // Fit: each step shortens or removes one part, least important first, until the row fits.
  const shown = (it) => it.useShort ? it.short : it.useMid ? it.mid : it.parts
  const size = (list) => 2 + list.reduce((n, it, i) => {
    const w = it.button ? cells(it.button.label) : cells(shown(it).map((p) => p.text).join(''))
    const gap = i === 0 ? 0 : it.button && list[i - 1].button ? BUTTON_GAP : GAP
    return n + gap + w
  }, 0)
  const steps = []
  for (const it of items) {
    // The middle form is tried just before the short one.
    if (it.mid && SHORTEN_AT[it.id]) steps.push({ at: SHORTEN_AT[it.id] + 0.01, it, mid: true })
    if (it.short && SHORTEN_AT[it.id]) steps.push({ at: SHORTEN_AT[it.id], it, short: true })
    const at = DROP_AT[it.id] || (it.id.startsWith('pair-') ? DROP_AT.pair : 0)
    if (at) steps.push({ at, it })
  }
  steps.sort((x, y) => y.at - x.at)
  let list = items.slice()
  for (const step of steps) {
    if (size(list) <= width) break
    if (step.mid) step.it.useMid = true
    else if (step.short) step.it.useShort = true
    else list = list.filter((it) => it !== step.it)
  }
  return list.map((it) => it.button ? { id: it.id, button: it.button } : { id: it.id, parts: shown(it) })
}

function verParts(v) {
  const p = String(v || '').split('.').map(Number)
  return p.length === 3 && p.every((n) => Number.isInteger(n) && n >= 0) ? p : null
}
// a later than b ("0.24.32" > "0.24.14"); an unreadable version is never later.
export function laterVersion(a, b) {
  const x = verParts(a)
  const y = verParts(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}
// A newer EditLens is installed (this plugin, or what a hook told the server) than the one running:
// -> { installed, running, busy, text, step } | null. An older server never says so itself.
export function updateInfo(s) {
  if (!s || typeof s.version !== 'string') return null
  const installed = [s.installed, s.pluginVersion].filter((v) => laterVersion(v, s.version)).sort((a, b) => (laterVersion(a, b) ? -1 : 1))[0]
  if (!installed) return null
  const busy = s.updateBusy === 'tasks' ? 'tasks' : s.updateBusy === 'page control' || s.control === 'page' ? 'page control' : null
  const step = busy === 'tasks' ? 'it updates when the tasks finish; /editlens restart updates now (the tasks stop)'
    : busy ? 'it updates when page control stops, and starts again; /editlens restart updates now'
      : '/editlens restart uses it'
  return { installed, running: s.version, busy, text: 'EditLens ' + installed + ' is installed, but an older one (' + s.version + ') is still running', step }
}

// The line while the server doesn't respond.
export function offLine(state) {
  if (state === 'starting') return 'EditLens is starting…'
  if (typeof state === 'string' && state) return "EditLens didn't start (" + state + '). Run /editlens to try again.'
  return 'EditLens ' + OFF_TEXT
}

// One line: "Page control · Working · Accept edits · 2 agents running · 1.2M tokens".
export function bandText(s) {
  if (!s) return offLine(null)
  const bits = [s.control === 'page' ? 'Page control' : 'Manual', stateLabel(s.state)]
  if (s.mode) bits.push(modeLabel(s.mode))
  const running = finite(s.agentsRunning) || 0
  if (running) bits.push(running + (running === 1 ? ' agent running' : ' agents running'))
  const total = totalTokens(s)
  bits.push((total === null ? DASH : fmtTokens(total)) + ' tokens')
  if (finite(s.permissions)) bits.push(s.permissions === 1 ? '1 question waiting' : s.permissions + ' questions waiting')
  const files = integrationFiles(s)
  if (files.length) bits.push('! in ' + files.join(', '))
  if (accessText(s)) bits.push('Page control off')
  return bits.join(' · ')
}

// Project files that load EditLens (a reminder to remove it when the work is done).
export function integrationFiles(s) {
  const list = s && Array.isArray(s.integrations) ? s.integrations : []
  return [...new Set(list.map((i) => i && i.rel).filter((r) => typeof r === 'string' && r))]
}

export function totalTokens(s) {
  const t = s && s.tokens
  if (!t) return null
  const main = finite(t.main)
  const sub = finite(t.subagents)
  if (main === null && sub === null) return null
  // Two large counts can add up to Infinity: then the total is unknown.
  const sum = (main || 0) + (sub || 0)
  return Number.isFinite(sum) ? sum : null
}

// A setting's value, checked against its field: the value, or undefined when missing or invalid.
export function checkSetting(field, raw) {
  if (!field || raw === undefined || raw === null) return undefined
  // An array or object is never a value: ["off"] and ["1"] would read as text (Sol L5).
  if (typeof raw === 'object' || typeof raw === 'function') return undefined
  if (field.type === 'boolean') {
    // The same spellings lib/settings.js check() takes, so the mod and the hooks agree.
    if (typeof raw === 'boolean') return raw
    const b = String(raw).trim().toLowerCase()
    if (b === 'true' || b === '1' || b === 'on' || b === 'yes') return true
    if (b === 'false' || b === '0' || b === 'off' || b === 'no') return false
    return undefined
  }
  if (field.type === 'number') {
    // Digits only for text ("1e3", "0x10" don't count), as lib/config.js reads the port.
    const n = typeof raw === 'number' ? raw : /^-?\d{1,15}$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN
    if (!Number.isInteger(n)) return undefined
    if ((typeof field.min === 'number' && n < field.min) || (typeof field.max === 'number' && n > field.max)) return undefined
    return n
  }
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return undefined
  return Array.isArray(field.options) && !field.options.includes(s) ? undefined : s
}

// A setting's value, checked against its field; the default when invalid (no NaN, no blanks).
export function settingValue(field, raw) {
  if (!field) return undefined
  const v = checkSetting(field, raw)
  return v === undefined ? field.default : v
}

// Where the value in use differs from the setting shown, as plain lines (bin/start.js prints the
// same for /editlens settings): the port kept until Claude Code restarts or set by EDITLENS_PORT,
// the safety check turned off by EDITLENS_GUARD, and a value that is not valid (raw: as given).
export function effectNotes({ schema: sch, raw, env, port: used }) {
  const all = sch || {}
  const given = raw || {}
  const vars = env || {}
  const values = settingsOf(all, given)
  const out = []
  // The kept port only against a setting given here (a command run from Bash gets none).
  const byEnv = strictInt(vars.EDITLENS_PORT, 1, 65535) === used
  if (all.port && strictInt(used, 1, 65535) !== null && used !== values.port && (byEnv || checkSetting(all.port, given.port) !== undefined)) {
    out.push(byEnv
      ? 'EditLens uses port ' + used + ': EDITLENS_PORT overrides the Port setting (' + values.port + ').'
      : 'EditLens uses port ' + used + ' until Claude Code restarts (the Port setting is ' + values.port + ').')
  }
  if (all.safety_check && values.safety_check && checkSetting(all.safety_check, vars.EDITLENS_GUARD) === false) {
    out.push('The safety check is off: EDITLENS_GUARD=' + String(vars.EDITLENS_GUARD).trim() + ' turns it off.')
  }
  for (const [k, f] of Object.entries(all)) {
    const r = given[k]
    if (r === undefined || r === null || checkSetting(f, r) !== undefined) continue
    const shown = String(r).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40)
    out.push((f.title || k) + ': "' + shown + '" is not a valid value, so the default is used.')
  }
  return out
}

export function settingsOf(sch, opts) {
  const out = {}
  for (const [k, f] of Object.entries(sch || {})) out[k] = settingValue(f, opts ? opts[k] : undefined)
  return out
}

// Least strict choices: pressing a value in the Settings pane never selects them (one press would
// apply them immediately). They are chosen in /config.
export const PANE_SKIPS = { permission_mode: ["Don't ask"], task_account: ['Root (unsafe)'] }
// On/off values that allow more: the pane applies them only on a second press, after a warning.
export const CONFIRM = {
  safety_check: { value: false, warning: 'Claude can then replace most of a file without asking.', label: 'Press again to turn off', button: 'Turn off?' },
  remote_tasks: { value: true, warning: 'Paired computers can then run Claude on this computer.', label: 'Press again to turn on', button: 'Turn on?' },
  paired_answers: { value: true, warning: "A computer that joined this one can then allow Claude's actions here.", label: 'Press again to turn on', button: 'Turn on?' },
}
export const CONFIRM_MS = 10000

// The value a setting's button moves to: on/off, or the next option (never one in PANE_SKIPS).
export function nextValue(field, value, key) {
  if (!field) return undefined
  if (field.type === 'boolean') return !value
  if (Array.isArray(field.options) && field.options.length) {
    const skip = (key && PANE_SKIPS[key]) || []
    const i = field.options.indexOf(value)
    for (let step = 1; step <= field.options.length; step++) {
      const to = field.options[(i + step + field.options.length) % field.options.length]
      if (!skip.includes(to)) return to === value ? undefined : to
    }
  }
  // A small range (Tasks at once, 1 to 8): the next number, then back to the lowest.
  if (smallRange(field)) {
    const n = Number.isInteger(value) ? value : field.default
    return n >= field.max ? field.min : n + 1
  }
  return undefined
}

// A number setting with few values (Tasks at once): the pane steps through them. The port's
// range is too large to step, so it is changed in /config.
export function smallRange(field) {
  return Boolean(field && field.type === 'number' && Number.isInteger(field.min) && Number.isInteger(field.max) && field.max > field.min && field.max - field.min <= 15)
}

// A press on a setting's value: 'confirm' when this change needs a second press (and none was made
// in the last CONFIRM_MS), else 'change'. armed: { key, value, at } from the first press, or null.
export function pressAction(key, to, armed, now) {
  const c = CONFIRM[key]
  if (!c || c.value !== to) return 'change'
  const again = armed && armed.key === key && armed.value === to && now - armed.at >= 0 && now - armed.at < CONFIRM_MS
  return again ? 'change' : 'confirm'
}

export function shownValue(field, value) {
  if (!field) return DASH
  if (field.type === 'boolean') return value ? 'On' : 'Off'
  return value === undefined || value === null || value === '' ? DASH : String(value)
}

function current() {
  return settingsOf(schema, options)
}

// Expected failures (no server yet, a missing file) go to the debug log once each, not silently.
const noted = new Set()
function debugOnce($, what, err) {
  const line = 'EditLens: ' + what + ': ' + err.message
  if (noted.has(line) || noted.size > 50) return
  noted.add(line)
  $.ui.log(line, { to: 'debug' })
}

async function loadSchema($) {
  try {
    const m = JSON.parse(await $.fs.read($.plugin.root + '/.claude-plugin/plugin.json'))
    schema = m && m.userConfig && typeof m.userConfig === 'object' ? m.userConfig : {}
    pluginVersion = m && typeof m.version === 'string' && /^\d+\.\d+\.\d+$/.test(m.version) ? m.version : null
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not read the settings list', err)
    schema = {}
  }
}

async function stateDir($) {
  const own = await $.env.get('EDITLENS_STATE_DIR')
  if (own) return own
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? home + '/.claude/editlens' : null
}

// The live server's key for hooks (a file it writes for this computer's user).
async function token($) {
  const dir = await stateDir($)
  if (!dir) return null
  try {
    return (await $.fs.read(dir + '/token-' + port)).trim()
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'no server token yet', err)
    return null
  }
}

// A Claude EditLens started (page control or a task, EDITLENS_DRIVEN) has its defaults, not the
// user's settings: its mod never changes or reports settings.
async function driven($) {
  return (await $.env.get('EDITLENS_DRIVEN')) === '1'
}

// Tells the server the settings Claude Code has, when they changed (never from a driven Claude).
let reporting = false
async function report($) {
  if (reporting || (await driven($))) return
  const values = current()
  const text = JSON.stringify(values)
  if (text === reported) return
  const key = await token($)
  if (!key) return
  reporting = true
  try {
    const res = await $.http.fetch('http://127.0.0.1:' + port + '/settings/report', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': key }, body: JSON.stringify({ values, from: 'mod' }),
    })
    if (res.ok) reported = text
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not report the settings', err)
  } finally {
    reporting = false
  }
}

// A tool call ended: if Claude Code asked the user about it (the page lists those questions, from
// the PermissionRequest hook), the page's entry is removed. A call that needed an answer took at
// least a person's reaction time, so quick calls send nothing.
const ASKED_MIN_MS = 300
async function toolEnded($, e) {
  const key = await token($)
  if (!key) return
  try {
    await $.http.fetch('http://127.0.0.1:' + port + '/event', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': key },
      body: JSON.stringify({ type: 'ask-done', sessionId: (await $.session.id()) || null, agentId: e.agentId || null, tool: e.tool, input: e.input === undefined ? null : e.input }),
    })
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not report a finished tool call', err)
  }
}

// One fixed key per setting: the plugin directory reads a settings change only when its key is
// written out, so no key is built from text. The permission mode is changed only in the Settings
// pane's hook. -> Claude Code's answer, or null for a key not changed here
function configSet($, k, value) {
  switch (k) {
    case 'start': return $.config.set({ key: 'editlens.start', value })
    case 'effort': return $.config.set({ key: 'editlens.effort', value })
    case 'safety_check': return $.config.set({ key: 'editlens.safety_check', value })
    case 'remote_tasks': return $.config.set({ key: 'editlens.remote_tasks', value })
    case 'paired_answers': return $.config.set({ key: 'editlens.paired_answers', value })
    case 'task_account': return $.config.set({ key: 'editlens.task_account', value })
    case 'tasks_at_once': return $.config.set({ key: 'editlens.tasks_at_once', value })
    case 'subagent_copies': return $.config.set({ key: 'editlens.subagent_copies', value })
    case 'permission_glow': return $.config.set({ key: 'editlens.permission_glow', value })
    case 'highlight': return $.config.set({ key: 'editlens.highlight', value })
    case 'hover_code': return $.config.set({ key: 'editlens.hover_code', value })
    case 'pick_box': return $.config.set({ key: 'editlens.pick_box', value })
    case 'dictation': return $.config.set({ key: 'editlens.dictation', value })
    case 'follow_page': return $.config.set({ key: 'editlens.follow_page', value })
    case 'expand_code_view': return $.config.set({ key: 'editlens.expand_code_view', value })
    case 'wait': return $.config.set({ key: 'editlens.wait', value })
    case 'line_above_prompt': return $.config.set({ key: 'editlens.line_above_prompt', value })
    case 'theme': return $.config.set({ key: 'editlens.theme', value })
    case 'text_size': return $.config.set({ key: 'editlens.text_size', value })
    case 'editor': return $.config.set({ key: 'editlens.editor', value })
    case 'auto_connect': return $.config.set({ key: 'editlens.auto_connect', value })
    case 'port': return $.config.set({ key: 'editlens.port', value })
    default: return null
  }
}

// Changes one setting in Claude Code (it saves it and reloads this file with the new value).
async function setSetting($, k, value) {
  const field = schema[k]
  if (!field || settingValue(field, value) !== value) return 'That value does not fit.'
  if (k === 'permission_mode') return 'Change it in /editlens settings.'
  return settingAnswer(configSet($, k, value))
}

// Claude Code's answer to a settings change. -> null when made, else why not
async function settingAnswer(made) {
  try {
    const out = await made
    return out && out.deny ? String(out.deny) : null
  } catch (err) {
    if (!(err instanceof Error)) throw err
    return err.message
  }
}

// A change from the Settings pane: a toast only when it fails, in plain words.
async function changeSetting($, k, field, value) {
  settingFailed($, k, field, await setSetting($, k, value))
}

function settingFailed($, k, field, err) {
  if (err) $.ui.toast('✦ ✕ Couldn\'t change ' + settingName(k, field) + ' · ' + plainReason(err))
}

// The name the Settings pane gives a setting.
function settingName(k, field) {
  for (const [, , list] of SETTING_GROUPS) for (const [key, label] of list) if (key === k) return label
  return (field && field.title) || k
}

// An error as plain words: a policy denial says who blocks it.
export function plainReason(err) {
  const t = String(err || '').trim()
  if (/polic/i.test(t)) return "your admin's policy blocks it"
  return t || 'Claude Code said no'
}

// What the page may change: a copy of lib/settings.js PAGE_EDITABLE (the mod can't load it;
// test/terminal-controls.test.js checks they match). Anything else in /summary is ignored, so
// a program on the port can't turn off the safety check or change permissions.
export const PAGE_EDITABLE = ['start', 'effort', 'permission_glow', 'highlight', 'hover_code', 'pick_box', 'dictation', 'follow_page', 'expand_code_view', 'wait', 'line_above_prompt', 'theme', 'text_size', 'editor', 'tasks_at_once']

// The page's requests the mod may make: page-editable keys only, each request once.
export function pendingToApply(list, seen) {
  if (!Array.isArray(list)) return []
  return list.filter((p) => p && typeof p === 'object' && (typeof p.id === 'string' || Number.isInteger(p.id)) &&
    !seen.has(p.id) && typeof p.key === 'string' && PAGE_EDITABLE.includes(p.key))
}

// Changes requested in the page panel's Settings, made in Claude Code (the user's, never a driven one).
async function applyPending($, list) {
  if (await driven($)) return
  for (const p of pendingToApply(list, applied)) {
    if (applied.has(p.id) || !Object.hasOwn(schema, p.key)) continue
    applied.add(p.id)
    // Only recent ones matter (a request is done or discarded within seconds).
    if (applied.size > 200) applied.delete(applied.values().next().value)
    const err = await setSetting($, p.key, p.value)
    if (!err) continue
    $.ui.log('✦ ✕ Couldn\'t change ' + settingName(p.key, schema[p.key]) + ' · ' + plainReason(err))
    await refuse($, p.id)
  }
}

// Tells the server Claude Code refused a page's request, so it removes it (the value in effect stays).
// Only the id: values sent with it would replace the ones in effect.
async function refuse($, id) {
  const key = await token($)
  if (!key) return
  try {
    await $.http.fetch('http://127.0.0.1:' + port + '/settings/report', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': key }, body: JSON.stringify({ from: 'mod', refused: [id] }),
    })
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not report a refused setting', err)
  }
}

// $.session.usage() and the model, for /editlens usage. -> { usage, model } or null
async function sessionUsage($) {
  try {
    const [usage, model] = await Promise.all([$.session.usage(), $.session.model()])
    return { usage, model: typeof model === 'string' ? model : null }
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not read the session usage', err)
    return null
  }
}

const LIMIT_NAMES = { five_hour: 'Session', seven_day: 'Weekly', spend_limit: 'Spend' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// "resets 18:00" today, "resets Mon" later this week, or '' for a time that isn't one.
export function resetsText(iso, now) {
  const at = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (!Number.isFinite(at) || !Number.isFinite(now) || at < now) return ''
  const d = new Date(at)
  if (at - now < 20 * 3600000) return 'resets ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  return 'resets ' + DAYS[d.getDay()]
}

// /editlens usage rows from Claude Code's own numbers: the context window, then each plan limit.
// -> { head: note, rows: [{ label, percent, note }] }; only rows with a value.
export function usageRows(u, model, now) {
  const rows = []
  const c = u && u.context && typeof u.context === 'object' ? u.context : {}
  const window = finite(c.window)
  const used = finite(c.tokens)
  const pct = finite(c.percent) ?? (used !== null && window ? Math.min(100, (used / window) * 100) : null)
  if (pct !== null) rows.push({ label: 'Context', percent: pct, note: used !== null && window ? fmtTokens(used) + ' of ' + fmtWindow(window) : '' })
  for (const l of Array.isArray(u && u.rateLimits) ? u.rateLimits : []) {
    const p = l && finite(l.percentUsed)
    if (p === null || !LIMIT_NAMES[l.kind]) continue
    rows.push({ label: LIMIT_NAMES[l.kind], percent: p, note: resetsText(l.resetsAt, now) })
  }
  const name = model ? modelLabel(String(model).replace(/\[1m\]$/i, '')) : ''
  const head = [name, window ? fmtWindow(window) + ' context' : ''].filter((x) => x && x !== DASH).join(' · ')
  return { head, rows, limits: rows.some((r) => r.label !== 'Context') }
}

// bin/start.js's usage output with this session's own numbers in place of the server's.
export function withUsage(list, got, now) {
  if (!got || !got.usage) return list
  const { head: ownHead, rows: ownRows, limits } = usageRows(got.usage, got.model, now)
  // The server's Context row measures against the user's auto-compact window: it is kept.
  const compact = list.find((r) => r.k === 'meter' && r.label === 'Context' && r.source === 'autocompact')
  const rows = compact ? [{ label: 'Context', percent: compact.percent, note: compact.note }, ...ownRows.filter((r) => r.label !== 'Context')] : ownRows
  if (!rows.length) return list
  const own = rows.map((r) => ({ k: 'meter', ...r, plain: meterPlain(r) }))
  const rest = list.filter((r) => r.k !== 'meter')
  const kept = rest.find((r) => r.k === 'head')
  const name = got.model ? modelLabel(String(got.model).replace(/\[1m\]$/i, '')) : ''
  const head = compact && kept ? [name, kept.note].filter((x) => x && x !== DASH).join(' · ') : ownHead
  const at = rest.findIndex((r) => r.k === 'head')
  const top = at < 0 ? [] : [{ ...rest[at], note: head || rest[at].note, plain: ['✦ ' + (rest[at].title || 'EditLens') + (head || rest[at].note ? '  · ' + (head || rest[at].note) : '')] }]
  const after = rest.slice(at + 1)
  while (after.length && after[0].k === 'blank') after.shift()
  const blank = { k: 'blank', plain: [''] }
  const note = limits ? [{ k: 'text', text: 'Plan limits are for your whole account.', dim: true, plain: ['Plan limits are for your whole account.'] }] : []
  return [...top, blank, ...own, ...note, blank, ...after]
}

// A meter record's plain line, as lib/say.js writes it.
function meterPlain(r) {
  const [filled, rest] = meter(r.percent, 16)
  const p = finite(r.percent)
  return [String(r.label).padEnd(COLS.usage) + filled + rest + '  ' + (p === null ? '' : fmtPct(p)).padStart(4) + (r.note ? '   ' + r.note : '')]
}

// The session's own numbers: exact from the start, with the window of the model chosen in Claude
// Code ([1m] = 1M), while the transcript has nothing before the first reply.
async function sessionLocal($) {
  try {
    const [u, model] = await Promise.all([$.session.usage(), $.session.model()])
    const c = u && u.context && typeof u.context === 'object' ? u.context : {}
    return { model: typeof model === 'string' && model ? model : null, window: finite(c.window), used: finite(c.tokens), percent: finite(c.percent), usd: u && u.cost ? finite(u.cost.usd) : null }
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not read the session usage', err)
    return null
  }
}

// Every 2 s: a new GET /summary when none is in progress and no failure says to wait, else only
// this session's own numbers (no request).
async function tick($) {
  await keepPort($)
  if (refocusLater) {
    const again = refocusLater
    refocusLater = null
    await focusAgain($, again, ' on the next tick')
  }
  // Settings not yet reported (a report that failed) are sent on this tick, not after a held answer (S6).
  if (raw) report($).catch((err) => debugOnce($, 'could not report the settings', err instanceof Error ? err : new Error(String(err))))
  reloadSessionsPane($).catch((err) => debugOnce($, 'could not reload the Sessions pane', err instanceof Error ? err : new Error(String(err))))
  if (polling || pollSkip > 0) {
    if (!polling) pollSkip--
    return refreshLocal($)
  }
  // A server that keeps requests open: not awaited, so the next ticks keep local numbers current.
  if (seq !== null && longFails < LONG_FAILS_MAX) {
    refresh($, true).catch((err) => debugOnce($, 'could not get the summary', err instanceof Error ? err : new Error(String(err))))
    return
  }
  return refresh($)
}

// Ticks to skip after `fails` failed requests one after another: 2 s, 4 s, 8 s, then every 10 s.
export function backoffTicks(fails) {
  const n = Number.isInteger(fails) && fails > 0 ? fails : 0
  return n ? Math.min(2 ** (n - 1), 5) - 1 : 0
}

// The summary's number from an answer (a whole number), or null (an older server: the 2 s poll).
export function seqOf(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null
}

// hold: the server may keep the request open until the summary changes (WAIT_S at most).
// sends: false from a drawing, where a report would end when Claude Code draws again (S6).
async function refresh($, hold = false, { sends = true } = {}) {
  // One request at a time, kept until its answer is applied: a second one could otherwise make
  // the page's setting changes in the wrong order. The one in progress returns any change.
  if (polling) return refreshLocal($)
  polling = true
  try {
    await refreshOnce($, hold, sends)
  } finally {
    polling = false
  }
}

async function refreshOnce($, hold, sends) {
  const held = hold && seq !== null
  let summaryNext = null
  try {
    // The task account may only report edits; the server refuses it /summary.
    if ((await $.env.get('EDITLENS_TASK_ACCOUNT')) === '1') return
    const sid = await $.session.id()
    const cwd = await $.session.cwd()
    let surfaces = []
    try {
      surfaces = await $.session.surfaces()
    } catch (err) {
      if (!(err instanceof Error)) throw err
      debugOnce($, 'could not list the surfaces', err)
    }
    const now = Date.now()
    const drawn = Object.keys(drawnAt).filter((k) => now - drawnAt[k] < 60000)
    // driven: the server never counts this mod as the one that makes the page's changes.
    const q = '?session=' + encodeURIComponent(sid || '') + '&cwd=' + encodeURIComponent(cwd || '') + '&mod=1' +
      ((await driven($)) ? '&driven=1' : '') + '&surfaces=' + encodeURIComponent((surfaces || []).join(',')) + '&drawn=' + encodeURIComponent(drawn.join(',')) +
      (held ? '&since=' + seq + '&wait=' + WAIT_S : '')
    const key = await token($)
    const res = await $.http.fetch('http://127.0.0.1:' + port + '/summary' + q, key ? { headers: { 'x-editlens-token': key } } : undefined)
    if (res.ok) summaryNext = JSON.parse(res.text)
  } catch (err) {
    // Connection refused, a timeout or a broken response: the server isn't there (yet).
    summaryNext = null
    if (!(err instanceof Error)) throw err
    debugOnce($, 'no answer from the live server', err)
  }
  if (summaryNext === null || typeof summaryNext !== 'object') {
    pollFails++
    pollSkip = backoffTicks(pollFails)
    // A long request failed: the next one is a plain request, which shows whether the server is there.
    // If long requests keep failing while plain ones work: back to the 2 s poll.
    if (held) {
      longFails++
      seq = null
      return
    }
    show($, null)
    return
  }
  pollFails = 0
  pollSkip = 0
  if (held) longFails = 0
  // A lower number than before means a restarted server: its answer is used like any other.
  seq = seqOf(summaryNext.seq)
  // A new instance is a restarted server, which numbers its requests and notices from 1 again.
  const inst = typeof summaryNext.instance === 'string' && summaryNext.instance ? summaryNext.instance : null
  if (inst !== null && instance !== null && inst !== instance) {
    forgetIds()
    reported = '' // the restarted server has no settings from before: report() sends them again
  }
  if (inst !== null) instance = inst
  const { seq: _seq, changed: _changed, instance: _instance, ...body } = summaryNext
  raw = body
  local = await sessionLocal($)
  show($, withLocal(withPlugin(raw), local))
  if (sends) await report($)
  await applyPending($, body.settingsPending)
  showNotices($, body.pairing, body.pageKey)
}

// Ids from the server before it restarted: its new ids may be the same numbers.
function forgetIds() {
  applied.clear()
  noticeSeen = -1
  pairedCodes.clear()
}

// Draws the line and panes again when what they show changed.
function show($, next) {
  const was = shown
  summary = next
  off = next === null
  if (off) raw = null
  if (!off && booting) booting = null
  shown = JSON.stringify(next)
  if (shown !== was) $.ui.invalidate('ui.render')
}

// The server's summary with this installed plugin's version (for "installed, but an older one runs").
function withPlugin(s) {
  return pluginVersion ? { ...s, pluginVersion } : s
}

// While a request is open: this session's own numbers from Claude Code, and the running time of
// working agents in the Details pane.
async function refreshLocal($) {
  if (!raw) return
  local = await sessionLocal($)
  const was = shown
  show($, withLocal(withPlugin(raw), local))
  if (shown === was && Array.isArray(raw.agents) && raw.agents.some((a) => a && a.status === 'working')) $.ui.invalidate('ui.render')
}

// "Paired with laptop-1" and the like, once each. Ones from before this session started are skipped.
function showNotices($, list, pageKey) {
  const items = Array.isArray(list) ? list.filter((n) => n && Number.isInteger(n.id) && typeof n.text === 'string')
    .map((n) => ({ ...n, text: keyedWindowLinks(n.text, pageKey, port) })) : []
  if (noticeSeen < 0) {
    // A notice with no usable time counts as old (never toasted on every start).
    noticeSeen = Math.max(0, ...items.filter((n) => !Number.isFinite(Number(n.at)) || Date.now() - Number(n.at) > 30000).map((n) => n.id))
  }
  for (const n of items) if (n.kind === 'paired' && typeof n.pairing === 'string' && typeof n.name === 'string') pairedCodes.set(n.pairing, n)
  for (const n of items) {
    if (n.id <= noticeSeen) continue
    noticeSeen = n.id
    $.ui.toast(noticeText(n.text))
    if (n.kind === 'paired' && typeof n.name === 'string') {
      // Green on the line above the prompt for 10 s, and the success block (the computer that
      // joined already shows it as its /editlens join reply).
      const flash = { id: n.id, name: n.name }
      pairedFlash = flash
      $.clock.after(FLASH_MS, () => {
        if (pairedFlash !== flash) return
        pairedFlash = null
        $.ui.invalidate('ui.render')
      })
      if (!n.joined) $.ui.log(plainOf(pairedRecords(n)))
      $.ui.invalidate('ui.render')
    } else $.ui.log(noticeText(n.text))
  }
}

// A computer paired with this one (a pairing notice): the success block. -> records
export function pairedRecords(n) {
  const name = String((n && n.name) || '')
  const rows = n && n.joined
    ? [['You can', 'open its page, give Claude there tasks'], ['Next', '/editlens control ' + name, true], ['Remove', '/editlens join off ' + name, true]]
    : [['It can', "open this project's page, give Claude here tasks"],
        ['You answer', n && n.answers ? 'its permission questions; it can too, in its EditLens window' : 'its permission questions'],
        ...(n && n.site === false ? [['Page', 'not connected here yet: /editlens connects it']] : []), ['Remove', '/editlens join off ' + name, true]]
  const width = fieldWidth(rows.map((r) => r[0]))
  return [rec({ k: 'head', title: '', status: 'ok', word: 'Paired with ◆ ' + name }), ...rows.map(([label, value, cmd]) => rec({ k: 'field', label, value, width, ...(cmd ? { cmd: true } : {}) }))]
}

// A /editlens pair reply whose code was used: drawn as the success block instead. -> records or null
export function pairDone(list) {
  const head = Array.isArray(list) ? list.find((r) => r && r.k === 'head' && typeof r.pairing === 'string') : null
  const n = head ? pairedCodes.get(head.pairing) : null
  return n ? pairedRecords(n) : null
}

// A notice as a toast: ✦, then ✓ unless it starts with its own mark (Claude Code names the plugin).
export function noticeText(text) {
  const t = String(text || '').trim().replace(/^EditLens:\s*/, '')
  return '✦ ' + (/^[✓✕!◆●○]/.test(t) ? t : '✓ ' + t)
}

// A command that went wrong says so instead of failing silently.
function failed(err) {
  if (!(err instanceof Error)) throw err
  return output(errorRecords(err))
}

// Records made here (not by bin/start.js), as lib/say.js makes them: each with its plain lines.
export function rec(r) {
  if (r.k === 'blank') return { ...r, plain: [''] }
  if (r.k === 'head') {
    const title = typeof r.title === 'string' ? r.title : 'EditLens'
    const state = r.status ? ({ ok: '✓', warn: '!', fail: '✕' }[r.status] || '') + ' ' + (r.word || '') : ''
    return { ...r, plain: ['✦ ' + [title, state].filter(Boolean).join('  ') + (r.note ? '  · ' + r.note : '')] }
  }
  if (r.k === 'field') return { ...r, plain: [fieldLabel(r.label, r.width) + String(r.value || '') + (r.note ? '  ' + r.note : '')] }
  const p = r.k === 'done' ? '✓ ' + r.text + (r.note ? '  ' + r.note : '')
    : r.k === 'fail' ? '✕ ' + r.what + (r.detail ? ': ' + r.detail : '')
      : r.k === 'fix' ? ('! Fix  ' + (r.before ? r.before + ' ' : '') + (r.cmd ? (r.run ? 'Run ' : '› ') + r.cmd : '') + (r.after ? (/^[,.;]/.test(r.after) ? '' : ' ') + r.after : '')).trim()
        : String(r.text || '')
  return { ...r, plain: [p] }
}

// -> { text }, its records kept so the CommandOutput hook draws them in colour.
function output(list) {
  const text = plainOf(list)
  remember(text, list)
  return { text }
}

// A message from another program in plain words: a copy of lib/plainerr.js plainMessage (the mod
// can't load it; test/console-design.test.js checks they agree). -> text ('' for nothing)
const CODE_WORDS = { ENOENT: 'it was not found', EACCES: 'permission was denied', EPERM: 'the system did not allow it', ETIMEDOUT: 'there was no response in time', ECONNREFUSED: 'nothing is running there', ECONNRESET: 'the connection was closed', EPIPE: 'the connection was closed', EADDRINUSE: 'the port is already in use', EHOSTUNREACH: "can't connect to that computer", ENOTFOUND: "that name can't be found", ENOSPC: 'the disk is full', EROFS: 'the disk is read-only' }
export function plainWords(text) {
  let t = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) || ''
  t = t.replace(/^(?:(?:\w*Error|Uncaught \w+):\s*)+/, '').replace(/^Claude Code returned an error result:\s*/i, '').replace(/\b\w*Error:\s*/g, '')
  if (/no conversation found/i.test(t)) return 'this chat has nothing saved yet, so there is nothing to continue'
  t = t.replace(/\s*(?:with\s+)?(?:session\s+)?id:?\s*(?=[0-9a-f]{8}-)/gi, ' ').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
  t = t.replace(/\b(?:connect|listen|read|write|open|getaddrinfo|spawn(?:Sync)? \S+)\s+(E[A-Z_]{3,})(?:\s+(\S+))?/g, (m, code, where) => (CODE_WORDS[code] ? CODE_WORDS[code] + (where ? ` (${where.replace(/^'|'$/g, '')})` : '') : m))
  t = t.replace(/\b(E[A-Z]{3,}[A-Z_]*)\b/g, (code) => CODE_WORDS[code] || code)
  t = t.replace(/\s+([:,.;])/g, '$1').replace(/[\s:;,]+$/, '').replace(/\s{2,}/g, ' ').trim()
  return t.length > 160 ? t.slice(0, 159).replace(/\s+\S*$/, '') + '…' : t
}

// What went wrong running /editlens, in plain words, with its fix.
export function errorRecords(err) {
  const msg = String((err && err.message) || err || '')
  if (/ENOENT/.test(msg)) return [rec({ k: 'fail', what: "EditLens can't run", detail: "Node isn't found" }), rec({ k: 'fix', before: 'Install Node 18 or newer, then restart Claude Code' })]
  if (/timed? ?out|timeout/i.test(msg)) return [rec({ k: 'fail', what: '/editlens took too long and stopped' }), rec({ k: 'fix', run: true, cmd: '/editlens', after: "again; page control's first start can take a few minutes" })]
  return [rec({ k: 'fail', what: "EditLens can't run", detail: plainWords(msg) || 'no reason given' }), rec({ k: 'fix', run: true, cmd: '/editlens details', after: 'to see whether the server is running' })]
}

// A whole number written only with digits, in range, as lib/config.js strictInt. -> number or null
export function strictInt(raw, min, max) {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d{1,9}$/.test(s)) return null
  const n = Number(s)
  return n >= min && n <= max ? n : null
}

// The port, as lib/config.js picks it: a valid EDITLENS_PORT, else the Port setting, else 4317.
export function portFrom(envValue, setting) {
  return strictInt(envValue, 1, 65535) ?? strictInt(setting, 1024, 65535) ?? 4317
}

// The /editlens menu line: Claude Code shows the plugin's name beside it, so no "EditLens:" here.
const COMMAND_HELP = 'Connect your page, stop, control, manual, undo, effort, settings, status'

// The port Claude Code started this session with, kept in <state>/session-ports/<session id> for
// this file's reloads after a setting change, the hooks and the status line: a Port setting changed
// later applies after a restart (lib/config.js reads the same file).
const SESSION_ID = /^[\w-]{1,100}$/
let keptFor = null // the session id the port was last kept for (a /clear continues under another)

async function keptFile($) {
  const dir = await stateDir($)
  const sid = await $.session.id()
  return dir && typeof sid === 'string' && SESSION_ID.test(sid) ? { file: dir + '/session-ports/' + sid, sid } : null
}

// -> the port kept for this session, or null when none is kept
async function heldPort($) {
  const at = await keptFile($)
  if (!at) return null
  try {
    return strictInt(await $.fs.read(at.file), 1, 65535)
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'no port kept for this session', err)
    return null
  }
}

// Keeps the port for this session (again after a /clear, which continues under another id).
async function keepPort($) {
  const at = await keptFile($)
  if (!at || at.sid === keptFor) return
  try {
    await $.fs.write(at.file, String(port))
    keptFor = at.sid
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not keep the port for the hooks', err)
  }
}

// A /clear continues under a new session id with no session.start. Its SessionStart hooks
// (hooks/live-hook.js) read the port kept for that id, so it is kept before they run. Claude Code
// starts $.state for the new session empty, so the port goes there again for this file's next reload.
async function keepPortOnClear($, e, next) {
  const sid = e && e.session_id
  if (started && e.source !== 'startup' && e.source !== 'resume' && typeof sid === 'string' && SESSION_ID.test(sid) && sid !== keptFor) {
    const dir = await stateDir($)
    try {
      if (dir) await $.fs.write(dir + '/session-ports/' + sid, String(port))
      keptFor = sid
    } catch (err) {
      if (!(err instanceof Error)) throw err
      debugOnce($, 'could not keep the port for the hooks', err)
    }
    if (!portByEnv) await holdPort($, port)
  }
  return next(e)
}

// The port this Claude Code started with, held by Claude Code for the session ($.state) through
// this file's reloads. After a setting change Claude Code reloads this file and sends session.start
// again: that is no new start, so the port stays.
const PORT_STATE = { plugin: 'editlens', key: 'port' }
async function startedPort($) {
  try {
    return strictInt((await $.state.get(PORT_STATE)).value, 1, 65535)
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not read the port this session started with', err)
    return null
  }
}

async function holdPort($, value) {
  try {
    await $.state.set(PORT_STATE, value)
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not hold the port for reloads', err)
  }
}

// atStart: session.start; the Port setting is taken when Claude Code just started (no port held for
// this Claude Code yet). Else the port it started with, or the port kept for the session.
async function choosePort($, atStart) {
  const envPort = await $.env.get('EDITLENS_PORT')
  portByEnv = strictInt(envPort, 1, 65535) !== null
  const inUse = portByEnv ? null : await startedPort($)
  const held = portByEnv ? null : inUse ?? (atStart ? null : await heldPort($))
  const chosen = held ?? portFrom(envPort, current().port)
  if (atStart && !portByEnv && inUse === null) await holdPort($, chosen)
  if (chosen === port) return
  // Another server: its answers and ids start again.
  port = chosen
  seq = null
  instance = null
  reported = ''
}

// The settings list, read once: a session.start that comes while a drawing reads it waits for it,
// so the port is never chosen from an empty list (V2).
let schemaRead = null
function readSchema($) {
  if (!schemaRead) schemaRead = loadSchema($)
  return schemaRead
}

async function startEditlens($, { atStart = false } = {}) {
  if (started) {
    // A drawing started this file before session.start: the setting's port, now that it is known.
    if (atStart) {
      await readSchema($)
      await choosePort($, true)
      keptFor = null
      await keepPort($)
      await refresh($)
      // The drawing's request may still be waiting: then refresh() sent no report (S6).
      await report($)
      bootIfOff($)
    }
    return
  }
  started = true
  await readSchema($)
  await choosePort($, atStart)
  if (atStart) await keepPort($)
  await refresh($, false, { sends: atStart })
  // Only from session.start: a process run from a drawing ends with that drawing (V2).
  if (atStart) bootIfOff($)
  $.clock.every(POLL_MS, () => tick($))
  try {
    await $.command.register({ name: 'editlens', description: COMMAND_HELP, argumentHint: '[stop [name] | restart | control [take] | manual | new | undo [N] | restore N | pair | join | task-user | effort [level] | settings | status | details | agents | sessions | usage | line | <dev server address or folder>]', immediate: true })
  } catch (err) {
    // Refused while the plugin's skill uses the name; the skill's command.run hook then responds.
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not add /editlens', err)
  }
}

function bootIfOff($) {
  if (off) boot($).catch((err) => $.ui.log('EditLens: could not start the live server: ' + String((err && err.message) || err), { to: 'debug' }))
}

// Starts the server if it isn't running, so the line shows at startup. SessionStart does too;
// the server makes sure only one uses the port.
async function boot($) {
  if (booting === 'starting') return
  booting = 'starting'
  $.ui.invalidate('ui.render')
  try {
    const out = await $.process.run(['node', $.plugin.root + '/bin/serve.js'], {
      timeoutMs: 20000, env: { ...optionEnv(), EDITLENS_PORT: String(port), CLAUDE_PLUGIN_ROOT: $.plugin.root },
    })
    const text = String((out && out.stdout) || '').trim()
    booting = out && out.exitCode === 0 ? null : text.replace(/^not started: /, '') || 'no answer from node'
  } catch (err) {
    if (!(err instanceof Error)) throw err
    // "spawn node ENOENT" in plain words, as errorRecords says it.
    booting = /ENOENT/.test(err.message) ? "Node isn't found" : err.message
  }
  await refresh($)
  $.ui.invalidate('ui.render')
}

// The settings as environment variables for bin/start.js, as Claude Code gives them to hooks.
function optionEnv() {
  const env = {}
  for (const [k, v] of Object.entries(current())) env['CLAUDE_PLUGIN_OPTION_' + k.toUpperCase()] = String(v)
  return env
}

async function openPane($, id, title) {
  const opened = await $.ui.open({ id, title, focus: true, closeOnEscape: true })
  return !(opened && opened.isPlaced === false)
}

// /editlens output as records (lib/say.js): RS + "EL" + JSON per line; any other line is text.
const MARK = '\u001eEL'
export function readRecords(out) {
  const list = []
  for (const line of String(out || '').split(/\r?\n/)) {
    if (line.startsWith(MARK)) {
      try {
        const r = JSON.parse(line.slice(MARK.length))
        if (r && typeof r === 'object' && Array.isArray(r.plain)) {
          list.push(r)
          continue
        }
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err
      }
    }
    // Not a record: a program's own line (raw marks it for replyRecords).
    if (line.trim()) list.push({ k: 'text', text: line, plain: [line], raw: true })
  }
  return list
}

// bin/start.js's output as the reply's records. Other lines (a program's own output such as npm's,
// or stderr) go to the debug log, not the reply; they are shown only when there is nothing else,
// and then a failed script says so.
export function replyRecords($, out) {
  const raw = (r) => r.raw === true
  const all = [...readRecords(out && out.stdout), ...readRecords(out && out.stderr)]
  const loose = all.filter(raw)
  for (const r of loose) $.ui.log('EditLens /editlens: ' + r.text, { to: 'debug' })
  const list = all.filter((r) => !raw(r))
  if (list.length || !loose.length) return list
  if (out && out.exitCode) {
    const why = loose.map((r) => /^(?:\w*Error|Uncaught \w+): (.+)$/.exec(r.text.trim())).find(Boolean)
    return [rec({ k: 'fail', what: '/editlens stopped with an error', ...(why ? { detail: oneLine(plainWords(why[1]), 120) } : {}) }), rec({ k: 'fix', run: true, cmd: '/editlens details', after: 'to see whether EditLens is running, then try again' })]
  }
  return loose.map((r) => rec({ k: 'text', text: r.text.trim(), dim: true }))
}

// The plain text of the records: what Claude reads, and what shows where the mod doesn't draw.
export function plainOf(list) {
  return list.flatMap((r) => r.plain.map(String)).join('\n').replace(/^\n+|\s+$/g, '')
}

// The records of the last outputs, for the CommandOutput hook, keyed by outputKey here and in
// $.store: Claude Code reloads this file when a setting changes, which empties this Map, and a row
// drawn again after that must still find its records. Text with no records (a resumed session) is
// parsed back into records (recordsFromText), so every /editlens row is drawn in colour.
const outputs = new Map()
const KEEP = 30
let storedRead = false // $.store's copy was read into `outputs` (once per load of this file)
let unsaved = false // `outputs` has records $.store doesn't have yet

// The row's text without what Claude Code adds or removes: the "editlens: " prefix, carriage
// returns, spaces at line ends and blank lines around it.
export function outputKey(text) {
  return String(text || '').replace(/\r/g, '').replace(/^\s*editlens(?:\+[\w.-]+)*:[ \t]*/i, '')
    .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '')
}

function remember(text, list) {
  const key = outputKey(text)
  outputs.delete(key)
  outputs.set(key, list)
  while (outputs.size > KEEP) outputs.delete(outputs.keys().next().value)
  unsaved = true
}

// The records drawn for this text: this file's, else $.store's (from before a reload), else null.
export function recordsFor(text) {
  return outputs.get(outputKey(text)) || null
}

async function readStored($) {
  if (storedRead) return
  storedRead = true
  let saved = null
  try {
    saved = await $.store.get('outputs')
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not read the saved /editlens replies', err)
  }
  if (!Array.isArray(saved)) return
  for (const entry of saved) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1]) || outputs.has(entry[0])) continue
    if (entry[1].every((r) => r && typeof r === 'object' && Array.isArray(r.plain))) outputs.set(entry[0], entry[1])
  }
  while (outputs.size > KEEP) outputs.delete(outputs.keys().next().value)
}

// Saves the latest records in $.store (kept between reloads and sessions; 4 MiB total).
async function saveOutputs($) {
  if (!unsaved) return
  await readStored($)
  unsaved = false
  try {
    await $.store.set('outputs', [...outputs].slice(-KEEP))
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not save the /editlens replies', err)
  }
}

// The records to draw a row with, from memory or $.store, else parsed from the text.
async function recordsOf($, text) {
  const mine = recordsFor(text)
  if (mine) return mine
  await readStored($)
  return recordsFor(text) || recordsFromText(outputKey(text))
}

// Plain /editlens text (lib/say.js lines) parsed back into records, so a row with no records left
// is still drawn in colour, in the same layout. Unknown lines stay text.
export function recordsFromText(text) {
  const out = []
  let steps = null
  const lines = String(text || '').split('\n')
  for (const line of lines) {
    const r = { plain: [line] }
    if (steps && /^[│└] {2}/.test(line)) {
      const body = line.slice(3)
      if (line[0] === '└') {
        const at = body.search(/(^|\s)\/editlens\b/)
        steps.end = at < 0 ? { text: body } : { text: body.slice(0, at).trim(), cmd: body.slice(at).trim() }
      } else {
        const m = /^(\S{1,2}) {1,2}(.*)$/.exec(body)
        const n = m && /^(\d+|or)$/.test(m[1]) ? m[1] : undefined
        const rest = (n === undefined ? body.replace(/^ {3}/, '') : m[2])
        const c = /^› (\S.*?)(?: {2}(.*))?$/.exec(rest)
        steps.items.push(c ? { n, cmd: c[1], ...(c[2] ? { text: c[2] } : {}) } : { n, text: rest })
      }
      steps.plain.push(line)
      continue
    }
    steps = null
    let m
    const above = out[out.length - 1]
    if (above && above.k === 'field' && line.trim() && line.search(/\S/) === above.width) {
      // A value that continues below the one above, in the same column.
      const [value, note] = splitNote(line.trim())
      out.push({ k: 'field', label: '', value, ...(note ? { note } : {}), width: above.width, ...r })
      continue
    }
    if (!line.trim()) out.push({ k: 'blank', ...r })
    else if (line.startsWith('✦ ')) {
      let rest = line.slice(2)
      let note = ''
      const at = rest.indexOf('  · ')
      if (at >= 0) {
        note = rest.slice(at + 4)
        rest = rest.slice(0, at)
      } else if (rest.startsWith('· ')) {
        note = rest.slice(2)
        rest = ''
      }
      const st = /^(?:(.*?) {2})?([✓!✕]) (.*)$/.exec(rest)
      out.push({ k: 'head', title: st ? st[1] || '' : rest, ...(st ? { status: { '✓': 'ok', '!': 'warn', '✕': 'fail' }[st[2]], word: st[3] } : {}), ...(note ? { note } : {}), ...r })
    } else if ((m = /^(\S.*?) (·{2,}) (.*)$/.exec(line))) {
      const width = cells(m[1]) + m[2].length + 2
      const [value, note] = splitNote(m[3])
      out.push({ k: 'field', label: m[1], value, ...(note ? { note } : {}), width, ...(linkHref(value) ? { link: true } : /^\/editlens\b|^--/.test(value) ? { cmd: true } : {}), ...r })
    } else if ((m = /^✓ (.*)$/.exec(line))) {
      const [t, note] = splitNote(m[1])
      out.push({ k: 'done', text: t, ...(note ? { note } : {}), ...r })
    } else if ((m = /^✕ (.*?)(?:: (.*))?$/.exec(line))) out.push({ k: 'fail', what: m[1], ...(m[2] ? { detail: m[2] } : {}), ...r })
    else if ((m = /^! Fix {2}(.*)$/.exec(line))) {
      const f = /^(.*?)(?:^|\s)(›|Run) (\/[\w:-]+(?: (?!(?:then|again|to|and|or|for|with|in|on|at|from|if|so|here|there|first|after|before|now)\b)[\w./:@~-]+)*)(.*)$/.exec(m[1])
      out.push(f ? { k: 'fix', before: f[1].trim(), run: f[2] === 'Run', cmd: f[3], after: f[4].trim(), ...r } : { k: 'fix', before: m[1], ...r })
    } else if ((m = /^! (.*)$/.exec(line))) {
      const [heading, note] = splitNote(m[1])
      steps = { k: 'steps', heading, ...(note ? { note } : {}), items: [], plain: [line] }
      out.push(steps)
    // Words after /editlens two spaces apart ("details  status  settings"), before a command row.
    } else if ((m = /^ {2}\/editlens ((?:[\w-]+ {2})+[\w-]+)(?: {4}more: (.*))?$/.exec(line))) out.push({ k: 'cmds', items: m[1].split(/ {2}/), ...(m[2] ? { note: m[2] } : {}), ...r })
    else if ((m = /^ {2}(\/editlens(?: \S+)*?) {2,}(\S.*)$/.exec(line))) out.push({ k: 'cmd', cmd: m[1], what: m[2], width: line.indexOf(m[2], 2 + m[1].length) - 2, ...r })
    else if (/^\/editlens\b.* {2}·{1} {2}/.test(line)) out.push({ k: 'hint', items: line.split('  ·  ').map((h) => splitNote(h)), ...r })
    else if ((m = /^([●○]) (.*)$/.exec(line))) {
      const [name, note] = splitNote(m[2])
      out.push({ k: 'item', mark: m[1] === '●' ? 'live' : null, name, ...(note ? { note } : {}), ...r })
    } else out.push({ k: 'text', text: line, ...r })
  }
  // A short line over command rows is their group's title ("Everyday", "Info").
  return out.map((r, i) => (r.k === 'text' && /^[A-Z][\w ]{0,23}$/.test(r.text) && out[i + 1] && /^cmds?$/.test(out[i + 1].k) ? { ...r, k: 'title' } : r))
}

// "value  note" -> [value, note]: a note follows two spaces.
function splitNote(t) {
  const at = String(t).indexOf('  ')
  return at < 0 ? [String(t), ''] : [t.slice(0, at), t.slice(at + 2).trim()]
}

// Column widths shared with lib/say.js (its plain text pads to the same ones).
export const COLS = { field: 12, details: 12, help: 22, usage: 10, setting: 12, join: 13 }

// A field's label with its dotted line, as lib/say.js labelText writes it: "Page ······ ".
export function fieldLabel(label, width = COLS.field) {
  const l = String(label || '')
  const w = Number.isInteger(width) && width > 0 ? width : COLS.field
  return l ? l + ' ' + '·'.repeat(Math.max(2, w - cells(l) - 2)) + ' ' : ' '.repeat(w)
}

// The label column a block of fields needs, as lib/say.js fieldWidth.
export function fieldWidth(labels) {
  return Math.max(COLS.field, ...labels.map((l) => (l ? cells(l) + 4 : 0)))
}

// The dotted line between a label and its value: as long as the space it gets, one row high.
// count: its cells, where the width is known in cells (the terminal); a longer line is cut with
// "…", because a line wider than the Box made the row two rows high.
function leader({ Box, Text }, count) {
  const n = Number.isFinite(count) ? Math.max(1, Math.min(200, Math.floor(count))) : 200
  return Box({ key: 'dots', flexGrow: 1, flexShrink: 1, height: 1, overflow: 'hidden', children: [Text({ color: 'subtle', wrap: 'truncate', children: ['·'.repeat(n)] })] })
}

// One label and value in real columns (the desktop app's font is proportional, so spaces can't
// align values). Without `valueWidth`: a fixed label column, the value wrapping under itself. With
// it: label, dotted line, and a value column of that width at the right. `value` is a list.
// lead: a fixed label column with the label and a dotted line to the value (command replies).
export function columnRow(ui, { key, gutter, label, labelWidth, labelStyle, value, valueWidth, dots, lead }) {
  const { Box, Text } = ui
  const name = Text({ wrap: 'truncate-end', ...(labelStyle || {}), children: [String(label || ' ')] })
  const kids = gutter ? [gutter] : []
  if (lead && label) {
    kids.push(Box({ key: 'label', width: labelWidth, flexShrink: 0, flexDirection: 'row', children: [
      Box({ key: 'name', flexShrink: 0, children: [name] }), Text({ key: 'gap-a', children: [' '] }), leader(ui, dots), Text({ key: 'gap-b', children: [' '] }),
    ] }), Box({ key: 'value', flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: value }))
  } else if (valueWidth) {
    kids.push(Box({ key: 'label', flexShrink: 0, children: [name] }), Text({ key: 'gap-a', children: [' '] }), leader(ui, dots), Text({ key: 'gap-b', children: [' '] }),
      Box({ key: 'value', width: valueWidth, flexShrink: 0, flexDirection: 'row', children: value }))
  } else {
    kids.push(Box({ key: 'label', width: labelWidth, flexShrink: 0, children: [name] }), Box({ key: 'value', flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: value }))
  }
  return Box({ key, flexDirection: 'row', children: kids })
}

// One record -> rows of the drawn output, in Claude Code's theme colours.
// cols: the output width in cells, when known (the terminal), for the dotted lines.
export function drawRecord(r, { Box, Text, Link }, key, cols) {
  const t = (children, style) => Text({ ...(style || {}), children: [String(children)] })
  const row = (kids) => Text({ key, wrap: 'wrap', children: kids })
  const sym = { ok: ['✓', 'success'], warn: ['!', 'warning'], fail: ['✕', 'error'] }
  const cmd = (c) => t('› ' + c, { color: 'suggestion' })
  switch (r.k) {
    case 'head': {
      const s = sym[r.status]
      const title = typeof r.title === 'string' ? r.title : 'EditLens'
      return [row([t('✦', { color: 'claude' }), ...(title ? [t(' ' + title, { bold: true })] : []), ...(s ? [t((title ? '  ' : ' ') + s[0] + ' ' + (r.word || ''), { color: s[1] })] : []), ...(r.note ? [t('  · ' + r.note, { dimColor: true })] : [])])]
    }
    case 'field': {
      // The label and a dotted line fill a label column as wide as lib/say.js makes it, so the
      // values of a block line up.
      const label = String(r.label || '')
      const width = Number.isInteger(r.width) && r.width > 0 ? r.width : COLS.field
      const href = r.link ? linkHref(r.value) : null
      const value = String(r.value || '')
      const first = value.slice(0, 2)
      const mark = first === '● ' || first === '✓ ' ? 'success' : first === '! ' ? 'warning' : first === '✕ ' ? 'error' : null
      const note = r.note ? t('  ' + r.note, { dimColor: true }) : null
      const parts = mark ? [t(first, { color: mark }), t(value.slice(2))] : [t(value, r.link || r.cmd ? { color: 'suggestion' } : r.dim ? { dimColor: true } : undefined)]
      const shown = href
        // No label: a terminal without clickable links prints the address once, not "label address".
        ? Box({ key: 'v', flexDirection: 'row', flexWrap: 'wrap', children: [Link({ href }), ...(note ? [Text({ wrap: 'wrap', children: [note] })] : [])] })
        : Text({ key: 'v', wrap: 'wrap', children: [...parts, ...(note ? [note] : [])] })
      const labelWidth = label ? Math.max(width, cells(label) + 4) : width
      return [columnRow({ Box, Text }, { key, label, labelWidth, labelStyle: { dimColor: true }, value: [shown], lead: true, dots: label ? labelWidth - cells(label) - 2 : null })]
    }
    case 'row': {
      const tone = { ok: { color: 'success' }, warn: { color: 'warning' }, off: { color: 'subtle' } }[r.tone] || {}
      return [columnRow({ Box, Text }, { key, label: r.label, labelStyle: { bold: true }, valueWidth: COLS.join, dots: Number.isFinite(cols) ? cols - cells(r.label) - 2 - COLS.join : null,
        value: [Text({ key: 'v', wrap: 'truncate-end', ...tone, children: [String(r.value || '')] })] }),
      ...(r.note ? [Text({ key: key + '-note', wrap: 'wrap', dimColor: true, children: ['  ' + r.note] })] : [])]
    }
    case 'meter': {
      const pct = finite(r.percent)
      const [filled, rest] = meter(pct, 16)
      const hot = pct !== null && pct >= 80
      // The meter, then the percent right-aligned in a column of its own, then the note.
      return [columnRow({ Box, Text }, { key, label: r.label, labelWidth: COLS.usage, labelStyle: { dimColor: true }, value: [Box({ key: 'v', flexDirection: 'row', children: [
        Text({ key: 'bar', wrap: 'truncate-end', children: [t(filled, { color: hot ? 'error' : 'claude' }), t(rest, { dimColor: true })] }),
        Box({ key: 'pct', width: 6, flexShrink: 0, justifyContent: 'flex-end', children: [t(pct === null ? '' : fmtPct(pct), hot ? { color: 'error' } : undefined)] }),
        ...(r.note ? [Text({ key: 'note', wrap: 'wrap', dimColor: true, children: ['   ' + r.note] })] : []),
      ] })] })]
    }
    case 'act': return [row([t(r.text || '', { bold: true })])]
    case 'hint': return [row((r.items || []).flatMap(([c, what], i) => [...(i ? [t('  ·  ', { dimColor: true })] : []), t(c, { color: 'suggestion' }), ...(what ? [t('  ' + what, { dimColor: true })] : [])]))]
    case 'done': return [row([t('✓ ', { color: 'success' }), t(r.text || ''), ...(r.note ? [t('  ' + r.note, { dimColor: true })] : [])])]
    case 'fail': return [row([t('✕ ', { color: 'error' }), t(r.what || '', { bold: true }), ...(r.detail ? [t(': ' + r.detail, { dimColor: true })] : [])])]
    case 'fix': return [row([t('! ', { color: 'warning' }), t('Fix  ', { bold: true }), ...(r.before ? [t(r.before + ' ', { dimColor: true })] : []), ...(r.cmd ? [r.run ? t('Run ' + r.cmd, { color: 'suggestion' }) : cmd(r.cmd)] : []), ...(r.after ? [t((/^[,.;]/.test(r.after) ? '' : ' ') + r.after, { dimColor: true })] : [])])]
    case 'code': {
      const gap = (k) => Text({ key: key + k, children: [' '] })
      if (!r.copy) return [gap('-a'), row([t('    '), t(' ' + (r.text || '') + ' ', { inverse: true, bold: true })]), gap('-b')]
      // copy (the join line): alone on its row, no padding, so it is copied as one line. In the
      // terminal it gets a row of exactly its width when it fits; the desktop app (cols unknown)
      // wraps it only on screen, which still copies as one line.
      const text = String(r.text || '')
      const style = { bold: true, color: 'suggestion' }
      const line = Number.isFinite(cols) && cells(text) <= cols
        ? Box({ key, flexShrink: 0, width: cells(text), children: [Text({ key: 'line', wrap: 'truncate-end', ...style, children: [text] })] })
        : Text({ key, wrap: 'wrap', ...style, children: [text] })
      return [gap('-a'), line, gap('-b')]
    }
    case 'steps': {
      const rail = (c) => t(c, { color: 'warning' })
      const out = [row([t('! ' + (r.heading || ''), { color: 'warning', bold: true }), ...(r.note ? [t('  ' + r.note, { dimColor: true })] : [])])]
      ;(r.items || []).forEach((s, i) => {
        const text = s.code ? t(s.text || '', { bold: true, inverse: true }) : t(s.text || '', s.cmd ? { dimColor: true } : undefined)
        // The bar and the step's number in separate columns, so the text aligns in the desktop
        // app's proportional font too, and a long step wraps under its own text.
        out.push(Box({ key: key + '-' + i, flexDirection: 'row', children: [Box({ key: 'rail', width: 3, flexShrink: 0, children: [rail('│')] }),
          Box({ key: 'n', width: 3, flexShrink: 0, children: [t(s.n === undefined ? ' ' : String(s.n), { dimColor: true })] }),
          Text({ key: 'text', wrap: 'wrap', children: [...(s.cmd ? [cmd(s.cmd), ...(s.text ? [t('  ')] : [])] : []), ...(s.text ? [text] : []), ...(s.note ? [t('  ' + s.note, { dimColor: true })] : [])] })] }))
      })
      if (r.end) out.push(Box({ key: key + '-end', flexDirection: 'row', children: [Box({ key: 'rail', width: 3, flexShrink: 0, children: [rail('└')] }),
        Text({ key: 'text', wrap: 'wrap', children: [t(r.end.text || '', { dimColor: true }), ...(r.end.cmd ? [t(r.end.text ? ' ' : ''), t(r.end.cmd, { color: 'suggestion' })] : [])] })] }))
      return out
    }
    case 'title': return [row([t(r.text || '', { dimColor: true })])]
    case 'item': {
      const m = { ok: ['✓', 'success'], warn: ['!', 'warning'], live: ['●', 'success'], fail: ['✕', 'error'] }[r.mark] || [' ', undefined]
      const w = Number.isInteger(r.width) && r.width > 0 ? r.width : 0
      // A name column of the item's width: real columns, as the desktop app's font is proportional.
      const name = Text({ key: 'n', bold: true, wrap: 'truncate-end', children: [String(r.name || '')] })
      return [Box({ key, flexDirection: 'row', children: [Box({ key: 'm', width: 2, flexShrink: 0, children: [t(m[0], m[1] ? { color: m[1] } : undefined)] }),
        w ? Box({ key: 'name', width: w, flexShrink: 0, children: [name] }) : Box({ key: 'name', flexShrink: 0, children: [name] }),
        ...(r.note ? [Text({ key: 'note', wrap: 'wrap', dimColor: true, children: ['  ' + r.note] })] : [])] })]
    }
    case 'cmd': return [Box({ key, paddingLeft: 2, children: [columnRow({ Box, Text }, { key: 'c', label: r.cmd, labelWidth: Math.max(Number.isInteger(r.width) && r.width > 0 ? r.width : COLS.help, cells(r.cmd) + 2), labelStyle: { color: 'suggestion' },
      value: [Text({ key: 'v', wrap: 'wrap', children: [String(r.what || '')] })] })] })]
    case 'cmds': return [row([t('  '), t((r.items || []).join('  '), { color: 'suggestion' }), ...(r.note ? [t('    ' + r.note, { dimColor: true })] : [])])]
    case 'blank': return [Text({ key, children: [' '] })]
    default: return [row([t(r.text || '', r.dim ? { dimColor: true } : undefined)])]
  }
}

// /editlens undo: recent edits, "Undo only this edit" and Restore. The same words as the page;
// bin/undo.js imports these, so the pane and the typed form match.
export const CONFLICT_LINE = 'A later edit changed the same lines, so only Claude can undo just this part.'
export const RESTORE_NOTE = 'Restore puts the whole file back; later changes to it are undone too.'
export const COPY_NOTE = 'Copy this into your prompt:'
export const IN_PROMPT = 'The message is in your prompt. Press Enter to send it to Claude.'
const UNDO_PANE = 'editlens-undo'
const NUM_W = 4 // the edit number column: up to 3 digits and a space
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Text from the server, on one line: control characters (a newline in a reason) become spaces.
export function oneLine(v, max = 200) {
  return (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

// A Date, or null when ms is not one (1e20 is a finite number, but past the last date there is).
function dateOf(ms) {
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d : null
}

// When an edit was made: "14:52" today, "Mon 14:52" this week, else "Oct 3"; '' when unknown.
export function editTime(ms, now = Date.now()) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || !Number.isFinite(now)) return ''
  const d = dateOf(ms)
  if (!d || !dateOf(now)) return ''
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === new Date(now).toDateString()) return hm
  if (Math.abs(now - ms) < 6 * 86400000) return DAYS[d.getDay()] + ' ' + hm
  return MONTHS[d.getMonth()] + ' ' + d.getDate()
}

// GET /edits/recent's answer, checked: whole edit numbers 1-999999 once each, text on one line, at
// most 30. -> [{ n, seq, file, reason, time, canUndo, canRestore, added, removed, created, agentId,
// agentType }] (seq, added, removed: null when unknown; an older server doesn't send them)
export function recentEdits(body) {
  const list = body && typeof body === 'object' && Array.isArray(body.edits) ? body.edits : []
  const out = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const n = typeof e.n === 'number' ? e.n : NaN
    if (!Number.isInteger(n) || n < 1 || n > 999999 || out.some((o) => o.n === n)) continue
    const count = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)
    // seq: the edit itself, sent with a press so the server acts on this row's edit (Sol H8).
    const seq = typeof e.seq === 'number' && Number.isSafeInteger(e.seq) && e.seq > 0 ? e.seq : null
    out.push({ n, seq, file: oneLine(e.file, 200) || 'a file', reason: oneLine(e.reason, 120), time: typeof e.time === 'number' && Number.isFinite(e.time) ? e.time : null, canUndo: e.canUndo === true, canRestore: e.canRestore === true,
      added: count(e.added), removed: count(e.removed), created: e.created === true, agentId: oneLine(e.agentId, 100) || null, agentType: oneLine(e.agentType, 60) || null })
    if (out.length >= 30) break
  }
  return out
}

// "src/App.jsx  Add the header", cut with "…" to `max` cells (the reason is cut first).
export function editLabel(e, max = 60) {
  const full = e.file + (e.reason ? '  ' + e.reason : '')
  const room = Number.isFinite(max) ? Math.max(8, Math.floor(max)) : 60
  return cells(full) <= room ? full : [...full].slice(0, room - 1).join('') + '…'
}

// The Changes row's counts: "+3 −1", "New · 12 lines", "No line changes" when both are a real 0,
// '' when unknown (never "0 lines").
export function editCounts(e) {
  const a = e && typeof e.added === 'number' && Number.isFinite(e.added) && e.added >= 0 ? e.added : null
  const r = e && typeof e.removed === 'number' && Number.isFinite(e.removed) && e.removed >= 0 ? e.removed : null
  if (e && e.created) return a ? 'New · ' + a + (a === 1 ? ' line' : ' lines') : 'New'
  if (a === null || r === null) return ''
  return a + r ? '+' + a + ' −' + r : 'No line changes'
}

// "src/pages/About.jsx" -> { name: 'About.jsx', folder: 'src/pages/' } (the project-relative path).
export function fileParts(file) {
  const f = String(file || '').replace(/\\/g, '/')
  const at = f.lastIndexOf('/')
  return at < 0 ? { name: f, folder: '' } : { name: f.slice(at + 1) || f, folder: f.slice(0, at + 1) }
}

// A folder cut from the left to `max` cells: "…design/" (the end is the most useful part).
export function folderFit(folder, max) {
  const f = String(folder || '')
  const room = Number.isFinite(max) ? Math.floor(max) : 0
  if (cells(f) <= room) return f
  if (room < 4) return ''
  return '…' + [...f].slice(-(room - 1)).join('').replace(/^\//, '')
}

// Who made an edit, as the page's chip names it: Main, or the subagent's description from the
// summary's agents (its type when that one has left the list).
export function editWho(e, s) {
  if (!e || !e.agentId) return 'Main'
  const a = s && Array.isArray(s.agents) ? s.agents.find((x) => x && x.agentId === e.agentId) : null
  return (a && oneLine(a.name, 60)) || (e.agentType ? 'Subagent · ' + e.agentType : 'Subagent')
}

// What a POST /edits/undo or /edits/restore said, in plain words.
// r: { status, json } or { down: true }. -> { kind: 'ok'|'conflict'|'fail'|'down', text, message, lines }
export function outcomeOf(r, { action, n, back }) {
  const undo = action === 'undo'
  if (!r || r.down) return { kind: 'down', text: "EditLens isn't running" }
  const j = r.json && typeof r.json === 'object' ? r.json : null
  if (j && j.ok === true) {
    const said = undo ? (back ? 'Put edit ' + n + ' back.' : 'Undid only edit ' + n + '. Later changes kept.') : (back ? 'Undid the restore of edit ' + n + '.' : 'Restored the file from before edit ' + n + '.')
    return { kind: 'ok', text: oneLine(j.text, 300) || said }
  }
  if (j && j.conflict === true) {
    const lines = Array.isArray(j.lines) ? j.lines.map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 2) : []
    return { kind: 'conflict', message: oneLine(j.message, 600) || 'Undo only edit ' + n + '. Keep the later changes.', lines }
  }
  if (j) return { kind: 'fail', text: oneLine(j.error, 300) || (undo ? "Couldn't undo edit " + n : "Couldn't restore the file of edit " + n), undone: j.undone === true }
  return { kind: 'fail', text: 'EditLens refused this' + (Number.isInteger(r.status) ? ' (error ' + r.status + ')' : '') }
}

// A conflict's records once its message is in the prompt: the copy lines are replaced by one line
// saying so. Not filled: unchanged, so the user can copy it.
export function filledRecords(list, filled) {
  if (!filled) return list
  return list.filter((r) => !(r.k === 'code' && typeof r.prompt === 'string')).map((r) => r.copyNote ? { k: 'text', dim: true, text: IN_PROMPT, plain: [IN_PROMPT] } : r)
}

// Claude Code's own /effort (this terminal's level): EditLens opens it and the user chooses. Where
// it can't be run from here, it is put in the prompt instead. Not waited for: /effort returns only
// when it closes, and a press has 10 s (settings check T3).
function openEffort($) {
  void (async () => {
    try {
      await $.command.run({ command: 'effort' })
    } catch (err) {
      if (!(err instanceof Error)) throw err
      debugOnce($, 'could not open /effort', err)
      await fillPrompt($, '/effort')
    }
  })()
}

// Puts Claude's message in the prompt box (after a draft, if there is one). Never sends it: the
// user reads it and presses Enter. -> true when the box contains it
async function fillPrompt($, message) {
  try {
    const box = await $.prompt.read()
    const draft = box && typeof box.text === 'string' ? box.text : ''
    const out = await $.prompt.fill(draft.trim() ? { text: '\n' + message, mode: 'append' } : { text: message, mode: 'replace' })
    return Boolean(out && out.isFilled)
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not put the message in your prompt', err)
    return false
  }
}

// The pane's state: the list, the selected edit, and what the last press did.
let undoPane = { list: [], instance: null, error: null, selected: null, result: null, busy: false }

// A hook-key call to the live server. -> { status, json } (json null when it isn't JSON) or { down: true }
async function editsCall($, method, path, body) {
  const key = await token($)
  if (!key) return { down: true }
  let res
  try {
    res = await $.http.fetch('http://127.0.0.1:' + port + path, { method, headers: { 'content-type': 'application/json', 'x-editlens-token': key }, ...(body ? { body: JSON.stringify(body) } : {}) })
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'no answer from the live server', err)
    return { down: true }
  }
  try {
    return { status: res.status, json: JSON.parse(res.text) }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    return { status: res.status, json: null }
  }
}

async function sessionPlace($) {
  const [sid, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
  return { session: sid || '', cwd: cwd || '' }
}

async function loadEdits($) {
  const w = await sessionPlace($)
  const r = await editsCall($, 'GET', '/edits/recent?session=' + encodeURIComponent(w.session) + '&cwd=' + encodeURIComponent(w.cwd))
  const ok = !r.down && r.json && Array.isArray(r.json.edits)
  undoPane.list = ok ? recentEdits(r.json) : []
  undoPane.instance = ok && typeof r.json.instance === 'string' && /^[0-9a-f]{16}$/.test(r.json.instance) ? r.json.instance : null
  undoPane.error = ok ? null : r.down ? "EditLens isn't running. Run /editlens to start it." : "EditLens couldn't list the edits" + (Number.isInteger(r.status) ? ' (error ' + r.status + ')' : '')
  if (!undoPane.list.some((e) => e.n === undoPane.selected)) undoPane.selected = undoPane.list.length ? undoPane.list[0].n : null
}

// A press in the pane: undo only this edit or restore the file (back: reverse it).
async function undoAct($, action, n, back) {
  if (undoPane.busy) return
  undoPane.busy = true
  undoPane.selected = n
  undoPane.result = null
  $.ui.invalidate('ui.render')
  try {
    const row = undoPane.list.find((e) => e.n === n)
    const which = row && row.seq && undoPane.instance ? { seq: row.seq, instance: undoPane.instance } : {}
    const r = await editsCall($, 'POST', '/edits/' + action, { n, ...which, ...(back ? { back: true } : {}), ...(await sessionPlace($)) })
    const out = outcomeOf(r, { action, n, back })
    // A press in the pane is the user's own: the message goes in their prompt, never sent.
    if (out.kind === 'conflict') out.filled = await fillPrompt($, out.message)
    undoPane.result = { ...out, n, action, back }
    await loadEdits($)
  } finally {
    undoPane.busy = false
    $.ui.invalidate('ui.render')
  }
}

function pickEdit($, n) {
  if (n === undoPane.selected) return
  undoPane.selected = n
  if (undoPane.result && undoPane.result.n !== n) undoPane.result = null
  $.ui.invalidate('ui.render')
}

// Under the selected row: the three buttons, the Restore note, and what the last press did.
function undoChoices($, { Box, Text, Button }, ed) {
  const line = (key, children) => Box({ key, paddingLeft: 2 + NUM_W, flexDirection: 'row', flexWrap: 'wrap', columnGap: 3, children })
  const st = undoPane
  if (st.busy) return [line('busy', [Text({ dimColor: true, children: ['Working…'] })])]
  const out = []
  const buttons = [
    ...(ed.canUndo ? [Button({ key: 'undo', label: 'Undo only this edit', plain: true, onPress: () => undoAct($, 'undo', ed.n, false) })] : []),
    ...(ed.canRestore ? [Button({ key: 'restore', label: 'Restore file', plain: true, onPress: () => undoAct($, 'restore', ed.n, false) })] : []),
    Button({ key: 'cancel', label: 'Cancel', plain: true, onPress: () => $.ui.close({ id: UNDO_PANE }) }),
  ]
  out.push(line('buttons', buttons))
  out.push(line('note', [Text({ dimColor: true, wrap: 'wrap', children: [ed.canUndo || ed.canRestore ? RESTORE_NOTE : "EditLens no longer has this file from before the edit, so it can't be undone here."] })]))
  const r = st.result && st.result.n === ed.n ? st.result : null
  if (!r) return out
  if (r.kind === 'ok') {
    out.push(line('result', [Text({ key: 't', wrap: 'wrap', children: [Text({ color: 'success', children: ['✓ '] }), Text({ children: [r.text] })] }),
      ...(r.back ? [] : [Button({ key: 'put-back', label: 'Put it back', plain: true, onPress: () => undoAct($, r.action, r.n, true) })])]))
  } else if (r.kind === 'conflict') {
    out.push(line('result', [Text({ key: 't', wrap: 'wrap', children: [Text({ color: 'warning', children: ['! '] }), Text({ children: [CONFLICT_LINE] })] })]))
    if (r.filled) out.push(line('prompt', [Text({ dimColor: true, wrap: 'wrap', children: [IN_PROMPT] })]))
    else {
      out.push(line('copy-note', [Text({ dimColor: true, children: [COPY_NOTE] })]))
      out.push(line('message', [Text({ key: 'm', bold: true, wrap: 'wrap', children: [r.message] }), Button({ key: 'copy', label: 'Copy', plain: true, onPress: (pressed) => $.ui.copy({ text: r.message, surface: pressed && pressed.surface }) })]))
    }
  } else {
    out.push(line('result', [Text({ key: 't', wrap: 'wrap', children: [Text({ color: 'error', children: ['✕ '] }), Text({ children: [r.text] })] })]))
  }
  return out
}

const COUNT_W = 15 // "New · 120 lines"

// The "Recent edits · this session" pane, as the page's Changes list: N, the file name (never cut)
// and its folder (cut from the left), a dotted line, the counts; below it, dimmed, who made it, the
// time and the reason.
function drawUndoPane($, ui, e) {
  const { Box, Text, Button } = ui
  const cols = e.props && Number.isFinite(e.props.bodyColumns) ? e.props.bodyColumns : 80
  const exact = e.surface === 'terminal'
  const kids = [Box({ key: 'head', flexDirection: 'row', justifyContent: 'space-between', columnGap: 2, children: [
    Text({ children: [Text({ color: 'claude', children: ['✦ '] }), Text({ bold: true, children: ['Recent edits'] }), Text({ dimColor: true, children: [' · this session'] })] }),
    ...(cols < NARROW ? [] : [Text({ dimColor: true, wrap: 'truncate-end', children: ['Tab move · Enter choose · Esc close'] })]),
  ] }), Text({ key: 'gap-head', children: [' '] })]
  if (undoPane.error) kids.push(Text({ key: 'error', wrap: 'wrap', children: [Text({ color: 'error', children: ['✕ '] }), Text({ children: [undoPane.error] })] }))
  else if (!undoPane.list.length) kids.push(Text({ key: 'none', dimColor: true, wrap: 'wrap', children: ['No edits by Claude in this session yet.'] }))
  const now = Date.now()
  for (const ed of undoPane.list) {
    const picked = ed.n === undoPane.selected
    const counts = editCounts(ed)
    const { name, folder } = fileParts(ed.file)
    const room = cols - 2 - NUM_W - 2 - (counts ? COUNT_W + 1 : 0)
    const dir = folderFit(folder, room - cells(name) - 2)
    const used = 2 + NUM_W + cells(name) + (dir ? 2 + cells(dir) : 0) + 2 + (counts ? COUNT_W : 0)
    const gutter = Box({ key: 'gutter', width: 2, flexShrink: 0, children: [Text({ color: 'claude', children: [picked ? '›' : ' '] })] })
    const num = Box({ key: 'num', width: NUM_W, flexShrink: 0, children: [Button({ key: 'edit-' + ed.n, label: String(ed.n), plain: true, ...(picked ? { autoFocus: true } : {}), onPress: () => pickEdit($, ed.n) })] })
    const nameStyle = picked ? { bold: true } : ed.canUndo || ed.canRestore ? {} : { dimColor: true }
    const under = [editWho(ed, summary), editTime(ed.time, now), counts ? '' : 'lines not known yet', ed.reason].filter(Boolean).join(' · ')
    kids.push(Box({ key: 'edit-row-' + ed.n, flexDirection: 'column', children: [
      Box({ key: 'top', flexDirection: 'row', children: [gutter, num,
        Box({ key: 'name', flexShrink: 0, children: [Text({ ...nameStyle, children: [name] })] }),
        ...(dir ? [Box({ key: 'folder', flexShrink: 1, children: [Text({ dimColor: true, wrap: 'truncate-start', children: ['  ' + dir] })] })] : []),
        ...(counts ? [Text({ key: 'gap-a', children: [' '] }), leader(ui, exact ? cols - used : null), Text({ key: 'gap-b', children: [' '] }),
          Box({ key: 'counts', width: COUNT_W, flexShrink: 0, children: [Text({ color: 'subtle', wrap: 'truncate-end', children: [counts] })] })] : []),
      ] }),
      Box({ key: 'who', paddingLeft: 2 + NUM_W, children: [Text({ dimColor: true, wrap: 'truncate-end', children: [under || ' '] })] }),
      ...(picked ? undoChoices($, { Box, Text, Button }, ed) : []),
    ] }))
  }
  return Box({ flexDirection: 'column', children: kids })
}

// The Details pane's agents list: the selected agent (key; null: the first working one), what its
// last Follow or Stop press did ({ key, kind: 'ok'|'fail', text }), and a press in progress.
let agentPane = { pick: null, result: null, busy: false }

function pickAgent($, key) {
  if (key === agentPane.pick) return
  agentPane.pick = key
  if (agentPane.result && agentPane.result.key !== key) agentPane.result = null
  $.ui.invalidate('ui.render')
}

// What a Follow or Stop press said. r: { status, json } or { down: true }.
export function agentOutcome(r, action, name) {
  if (!r || r.down) return { kind: 'fail', text: "EditLens isn't running. Run /editlens to start it." }
  const j = r.json && typeof r.json === 'object' ? r.json : null
  if (j && (j.ok === true || (action === 'stop' && !j.error && r.status === 200))) {
    return { kind: 'ok', text: action === 'follow' ? 'Your page follows ' + name + ' now.' : 'Stopped ' + name + '.' }
  }
  if (j && typeof j.error === 'string' && j.error) return { kind: 'fail', text: oneLine(j.error, 300) }
  return { kind: 'fail', text: (action === 'follow' ? "Couldn't follow " : "Couldn't stop ") + name + (Number.isInteger(r.status) ? ' (error ' + r.status + ')' : '') }
}

// Follow: this project's open pages follow the agent. Stop: the stop the page's card uses.
async function agentAct($, a, action) {
  if (agentPane.busy) return
  agentPane.busy = true
  agentPane.pick = a.key
  agentPane.result = null
  $.ui.invalidate('ui.render')
  try {
    const { cwd } = await sessionPlace($)
    const r = action === 'follow'
      ? await editsCall($, 'POST', '/agents/follow', { cwd, ...a.follow })
      : await editsCall($, 'POST', a.stop.path, { ...a.stop.body, ...(a.stop.path === '/remote/task' ? { localDir: cwd } : { cwd }) })
    agentPane.result = { key: a.key, ...agentOutcome(r, action, a.name + (a.word ? ' · ' + a.word : '')) }
    if (action === 'stop') await refresh($)
  } finally {
    agentPane.busy = false
    $.ui.invalidate('ui.render')
  }
}

// The list: gutter, status mark, name (the button that selects it), one dim word, a dotted line,
// the status column; under the selected one its details (label column 13), Follow and Stop, and
// what the last press did. cols: the pane's width; exact: a terminal (cells).
function drawAgents($, ui, list, { cols, exact }) {
  const { Box, Text, Button } = ui
  const items = list.filter((a) => !a.more)
  if (!items.some((a) => a.key === agentPane.pick)) agentPane.pick = (items.find((a) => a.working && a.key !== 'main') || {}).key || null
  const narrow = cols < NARROW
  const statusW = narrow ? 12 : AGENT_STATUS_W
  const kids = []
  for (const a of list) {
    if (a.more) {
      kids.push(Text({ key: 'more', dimColor: true, children: ['    and ' + a.more + ' more'] }))
      continue
    }
    const picked = a.key === agentPane.pick
    const word = a.word ? ' · ' + a.word : ''
    const room = Math.max(8, cols - 4 - cells(word) - 3 - statusW)
    const name = cells(a.name) <= room ? a.name : [...a.name].slice(0, room - 1).join('') + '…'
    const used = 4 + cells(name) + cells(word) + 2 + statusW
    kids.push(Box({ key: 'agent-row-' + a.key, flexDirection: 'row', children: [
      Box({ key: 'gutter', width: 2, flexShrink: 0, children: [Text({ color: 'claude', children: [picked ? '›' : ' '] })] }),
      Box({ key: 'mark', width: 2, flexShrink: 0, children: [Text({ color: a.mark.color, children: [a.mark.glyph] })] }),
      Box({ key: 'name', flexShrink: 0, children: [Button({ key: 'agent-' + a.key, label: name, plain: true, onPress: () => pickAgent($, a.key) })] }),
      ...(word ? [Box({ key: 'word', flexShrink: 0, children: [Text({ dimColor: true, children: [word] })] })] : []),
      Text({ key: 'gap-a', children: [' '] }), leader(ui, exact ? cols - used : null), Text({ key: 'gap-b', children: [' '] }),
      Box({ key: 'status', width: statusW, flexShrink: 0, children: [Text({ wrap: 'truncate-end', ...(a.status.color ? { color: a.status.color } : { dimColor: true }), children: [a.status.text || ' '] })] }),
    ] }))
    if (!picked) continue
    const line = (key, children) => Box({ key: key + '-' + a.key, paddingLeft: AGENT_INDENT, flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children })
    for (const r of a.rows) {
      kids.push(Box({ key: 'detail-' + a.key + '-' + r.label, paddingLeft: AGENT_INDENT, children: [columnRow(ui, { key: 'row', label: r.label, labelWidth: AGENT_LABEL_W, labelStyle: { dimColor: true },
        value: [Text({ key: 'v', wrap: 'wrap', children: r.parts.map((p, j) => Text({ key: String(j), ...partStyle(p), children: [p.text] })) })] })] }))
    }
    if (agentPane.busy) {
      kids.push(line('busy', [Text({ dimColor: true, children: ['Working…'] })]))
      continue
    }
    kids.push(line('buttons', [
      Button({ key: 'follow-agent', label: 'Follow', plain: true, onPress: () => agentAct($, a, 'follow') }),
      ...(a.stop ? [Button({ key: 'stop-agent', label: 'Stop', plain: true, onPress: () => agentAct($, a, 'stop') })] : []),
    ]))
    const res = agentPane.result && agentPane.result.key === a.key ? agentPane.result : null
    if (res) kids.push(line('result', [Text({ key: 't', wrap: 'wrap', children: [Text({ color: res.kind === 'ok' ? 'success' : 'error', children: [res.kind === 'ok' ? '✓ ' : '✕ '] }), Text({ children: [res.text] })] })]))
  }
  if (!narrow) kids.push(Text({ key: 'gap-hint', children: [' '] }), Text({ key: 'hint', wrap: 'truncate-end', children: [Text({ dimColor: true, children: ['› ↑ ↓ picks an agent; its details open under it.'] })] }))
  return Box({ key: 'agents', flexDirection: 'column', children: kids })
}

// /editlens arguments: words, with "quoted text" or 'quoted text' as one (its spaces kept, the
// quotes removed). Read once, and passed to bin/start.js as a list.
export function splitArgs(text) {
  const out = []
  for (const m of String(text || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out.filter((w) => w !== '')
}

// /editlens <args>: settings and details here; everything else is bin/start.js.
// typed: the user typed it at this computer's prompt, so a plain /editlens may open the page.
async function runCommand($, args, { typed = false } = {}) {
  const words = splitArgs(args)
  const word = (words[0] || '').toLowerCase()
  // "/editlens undo" (or "restore") alone: the pane; with a number it runs in bin/undo.js.
  if ((word === 'undo' || word === 'restore') && words.length === 1) {
    undoPane = { list: [], instance: null, error: null, selected: null, result: null, busy: false }
    await loadEdits($)
    if (await openPane($, UNDO_PANE, 'Recent edits')) return {}
  }
  if (word === 'settings') {
    if (await openPane($, SETTINGS_PANE, 'EditLens settings')) return {}
    const env = { EDITLENS_PORT: await $.env.get('EDITLENS_PORT'), EDITLENS_GUARD: await $.env.get('EDITLENS_GUARD') }
    return output(recordsFromText(settingsText(schema, current(), effectNotes({ schema, raw: options, env, port }))))
  }
  if (word === 'details') {
    await refresh($)
    if (await openPane($, PANE, 'EditLens')) return {}
    return output(recordsFromText(detailsText(summary)))
  }
  // /editlens sessions: the pane (Open, Stop, Rename), or the same rows as text.
  if (word === 'sessions') {
    sessionsPane = { data: null, error: null, cwd: '', pick: null, renaming: null, result: null, busy: false }
    await loadSessions($)
    if (await openPane($, SESSIONS_PANE, 'Sessions')) return {}
    return output(recordsFromText(sessionsText(sessionsPane.data, { cwd: sessionsPane.cwd, down: !sessionsPane.data && /isn't running/.test(sessionsPane.error || '') })))
  }
  // /editlens stop <name>: a page control session or a task, by the name in the Sessions list.
  const named = stopName(args)
  if (named !== null) {
    const { cwd } = await sessionPlace($)
    const r = await editsCall($, 'POST', '/sessions/stop', { cwd, name: named })
    await refresh($)
    return output(stopNameRecords(r, named))
  }
  // /editlens agents: the list and what each working agent is doing (Follow and Stop: Details).
  if (word === 'agents') {
    await refresh($)
    return output(recordsFromText(agentsText(off ? null : summary)))
  }
  if (word === 'line') {
    const was = current().line_above_prompt
    const err = await setSetting($, 'line_above_prompt', !was)
    if (err) return output([rec({ k: 'fail', what: "Couldn't change the line above the prompt", detail: plainReason(err) }), rec({ k: 'fix', before: 'Change it in', cmd: '/config', after: '(search "editlens")' })])
    return output([was ? rec({ k: 'done', text: 'Line above the prompt hidden', note: '· /editlens line shows it' }) : rec({ k: 'done', text: 'Line above the prompt shown' })])
  }
  // restart then does what /editlens does: page control may start (and set itself up the first time).
  const slow = word === 'control' || word === 'task-user' || word === 'restart' || (!word && current().start === 'Connect and turn on page control')
  const kind = word === 'task-user' ? 'task-user' : word === 'restart' ? 'restart' : slow ? 'control' : word === 'stop' ? 'stop' : word === 'manual' ? 'manual' : word === 'pair' || word === 'join' ? 'pair' : word === 'help' || word === 'status' || word === 'usage' || word === 'undo' || word === 'restore' || word === 'effort' ? null : 'connect'
  // The same command typed again while it runs: a second copy would open the page twice.
  if (kind && busy === kind) return output([rec({ k: 'fail', what: '/editlens' + (word ? ' ' + word : '') + ' is already running' }), rec({ k: 'fix', before: 'Wait for its answer; it shows here when it ends' })])
  // Set before the first await, so a second press while this one starts is ignored.
  busy = kind
  $.ui.invalidate('ui.render')
  try {
    const cwd = await $.session.cwd()
    // bin/undo.js lists this session's edits, bin/effort.js its level; Claude Code may not pass its
    // session id to a process.
    const sid = word === 'undo' || word === 'restore' || word === 'effort' ? (await $.session.id()) || '' : ''
    const out = await $.process.run(['node', $.plugin.root + '/bin/start.js', ...words], {
      cwd: cwd || undefined, timeoutMs: slow ? 600000 : 120000,
      // EDITLENS_PORT: the port this session uses; a Port setting changed since applies after a restart.
      env: { ...optionEnv(), EDITLENS_PORT: String(port), CLAUDE_PROJECT_DIR: cwd || '', CLAUDE_PLUGIN_ROOT: $.plugin.root, EDITLENS_SAY: 'records', EDITLENS_TYPED: typed ? '1' : '0', ...(sid ? { EDITLENS_SESSION_ID: sid } : {}) },
    })
    let list = replyRecords($, out)
    if (word === 'usage') list = withUsage(list, await sessionUsage($), Date.now())
    // A conflict typed at this computer's prompt: Claude's message goes in the prompt, never sent.
    const ask = typed ? list.find((r) => r.k === 'code' && typeof r.prompt === 'string' && r.prompt) : null
    if (ask) list = filledRecords(list, await fillPrompt($, oneLine(ask.prompt, 600)))
    const text = plainOf(list)
    if (!text) return output([rec({ k: 'done', text: 'Done' })])
    remember(text, list)
    return { text }
  } catch (err) {
    if (!(err instanceof Error)) throw err
    return output(errorRecords(err))
  } finally {
    busy = null
    await refresh($)
  }
}

// A page address on this computer with the page key after # (D21: macOS and Windows), so the page
// it opens can connect; anything else as it is.
export function keyedHref(href, key) {
  if (!href || typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) return href
  if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(\/|$)/i.test(href)) return href
  return href.split('#')[0] + '#editlens-key=' + key
}

// A link in a notice to this computer's EditLens window (on `livePort`), with the page key in its
// address where the window needs it (D21); a paired computer's window keeps its own address.
export function keyedWindowLinks(text, key, livePort) {
  if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key) || !Number.isInteger(livePort)) return text
  return String(text).replace(new RegExp(`(http://(?:localhost|127\\.0\\.0\\.1):${livePort})/answer\\b`, 'g'), `$1/gk-${key}/answer`)
}

// The buttons that run /editlens for you, in plain words: which ones fit the session now.
// [{ key, label, word }] (word: what /editlens gets), or { href } for Open page.
export function actionButtons(s) {
  if (!s) return []
  const out = []
  const page = s.pages && s.pages[0]
  const href = keyedHref(linkHref(page && page.url) || linkHref(s.connection && s.connection.url), s.pageKey)
  // No browser on this computer: a localhost link would open nothing on the user's own computer.
  const from = openFromOf(s)
  if (from && from.paired && from.paired.url) out.push({ key: 'open', label: 'Open on ' + from.paired.name, href: from.paired.url })
  else if (from && href) out.push({ key: 'open', label: 'How to open', open: 'details' })
  else if (href) out.push({ key: 'open', label: 'Open', href })
  if (!page && !s.connection) {
    // A dev server EditLens found but couldn't prove is this project's: pressing confirms it.
    const hint = typeof s.connectHint === 'string' && /^http:\/\/localhost:\d{2,5}$/.test(s.connectHint) ? s.connectHint : null
    out.push(hint ? { key: 'connect', label: 'Connect ' + hint.slice(7), word: hint } : { key: 'connect', label: 'Connect page', word: '' })
  }
  if (s.control === 'page') out.push({ key: 'manual', label: 'Manual', word: 'manual' })
  else out.push({ key: 'control', label: 'Page control', word: 'control' })
  if (page || s.connection) out.push({ key: 'stop', label: 'Disconnect', word: 'stop' })
  return out
}

// A button press: runs /editlens with that word and shows the result, one line per notice.
let pressing = false // a button's /editlens is running (help and status don't set busy)
async function press($, word) {
  if (busy || pressing) return
  pressing = true
  try {
    const out = await runCommand($, word)
    const text = out && typeof out.text === 'string' ? out.text : ''
    const said = pressLine(recordsFor(text) || recordsFromText(outputKey(text)))
    if (said) $.ui.log(said)
  } finally {
    pressing = false
  }
}

// What a button's /editlens did, as one log row (Claude Code draws it dim, after "editlens:"; the
// line above the prompt shows the new state): "✦ ✓ page control on", or what went wrong and its fix.
export function pressLine(list) {
  const items = Array.isArray(list) ? list : []
  const fail = items.find((r) => r.k === 'fail')
  if (fail) {
    const fix = items.find((r) => r.k === 'fix')
    return '✦ ✕ ' + fail.what + (fail.detail ? ' · ' + fail.detail : '') + (fix && Array.isArray(fix.plain) ? '\n  ' + fix.plain[0] : '')
  }
  const head = items.find((r) => r.k === 'head')
  const word = head && head.status ? { ok: '✓', warn: '!', fail: '✕' }[head.status] + ' ' + head.word : ''
  const done = items.find((r) => r.k === 'done')
  if (word) return '✦ ' + word + (head.note ? ' · ' + head.note : '')
  if (done) return '✦ ✓ ' + done.text
  const first = items.find((r) => r.k !== 'blank')
  return first && Array.isArray(first.plain) ? '✦ ' + String(first.plain[0]).replace(/^✦ /, '') : ''
}

function drawActions($, s, Button, Link) {
  return actionButtons(s).map((a) => a.href
    ? Link({ href: a.href, label: a.label })
    : Button({ key: a.key, label: a.label, plain: true, onPress: () => press($, a.word) }))
}

// The editlens skill (skills/editlens), as the typeahead lists it: not the mod's own /editlens.
export const RUNNER_SKILL = 'Runs the /editlens command the user typed'
export function isRunnerSkill(e) {
  return Boolean(e && typeof e.command === 'string' && /(^|:)editlens$/.test(e.command) && typeof e.description === 'string' && e.description.startsWith(RUNNER_SKILL))
}

// How a part of the line is drawn: a theme colour, bold, dim, or a warning pill.
function partStyle(p) {
  if (p.pill) return { backgroundColor: 'warning', color: 'inverseText', bold: true }
  const out = {}
  if (p.color) out.color = p.color
  if (p.bold) out.bold = true
  if (p.dim) out.dimColor = true
  return out
}

// One plain row (Claude Code draws $.ui.log rows dim, after "editlens:"): the ✦ head as elsewhere.
export const WELCOME = '✦ EditLens  › /editlens to connect your page · /editlens help for more'

async function welcome($) {
  try {
    if (await $.store.get('welcomed')) return
    await $.store.set('welcomed', true)
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not read what was shown before', err)
    return
  }
  $.ui.log(WELCOME)
}

// A button on the line: Start, Details or one that runs /editlens with its word.
async function bandPress($, b) {
  if (b.key === 'start') return boot($)
  if (b.open === 'details') return $.ui.open({ id: PANE, title: 'editlens', focus: true, closeOnEscape: true })
  return press($, b.word)
}

// Every /editlens output row this session printed, drawn in colour: the mod's command or the
// plugin's (editlens:editlens in the typeahead), with or without arguments. A row whose command
// threw gets the error shape.
export function isOwnRow(p) {
  return Boolean(p && typeof p.command === 'string' && /^editlens(:editlens)?$/.test(p.command) && typeof p.text === 'string' && p.text.trim())
}

async function drawOutput($, e, next) {
  const p = e && e.props
  if (!isOwnRow(p)) return next(e)
  const found = p.isErrored ? errorRecords(new Error(outputKey(p.text))) : await recordsOf($, p.text)
  // /editlens pair whose code has been used: shown as done, not as an open code.
  const list = pairDone(found) || found
  const ui = $.ui.resolve(e)
  // Blank rows at the start and end are removed, as in the text.
  let from = 0
  let to = list.length
  while (from < to && list[from].k === 'blank') from++
  while (to > from && list[to - 1].k === 'blank') to--
  const rows = []
  // The output starts after "  ⎿  " (5 cells).
  const cols = e.surface === 'terminal' && e.viewport && Number.isFinite(e.viewport.columns) ? e.viewport.columns - 5 : null
  list.slice(from, to).forEach((r, i) => rows.push(...drawRecord(r, ui, 'r' + i, cols)))
  return ui.Box({ key: 'editlens-output', flexDirection: 'row', children: [
    ui.Text({ dimColor: true, children: ['  ⎿  '] }),
    ui.Box({ flexDirection: 'column', flexShrink: 1, children: rows }),
  ] })
}

// /editlens new writes a file, and /editlens stop <name> stops a session: only when the user
// typed it (here or through Remote Control).
export function notTypedNew(args, kind) {
  return /^\s*new(\s|$)/i.test(String(args || '')) && kind !== 'composer' && kind !== 'bridge'
}
export function notTypedStop(args, kind) {
  return stopName(args) !== null && kind !== 'composer' && kind !== 'bridge'
}

// /editlens: runs bin/start.js with what was typed after it.
async function editlensRun($, e) {
  return answerEditlens($, e)
}

// The answer to /editlens, for both hooks below.
async function answerEditlens($, e) {
  try {
    const kind = e && e.origin && e.origin.kind
    if (notTypedNew(e && e.args, kind)) return output([rec({ k: 'fail', what: 'Only you can make a starter page' }), rec({ k: 'fix', before: 'Type', cmd: '/editlens new', after: 'at the prompt yourself' })])
    if (notTypedStop(e && e.args, kind)) return output([rec({ k: 'fail', what: 'Only you can stop a session by its name' }), rec({ k: 'fix', before: 'Type', cmd: '/editlens stop ' + oneLine(stopName(e.args), 60), after: 'at the prompt yourself' })])
    await startEditlens($)
    // Typed at this computer's prompt (not Remote Control, a plugin or a button).
    return await runCommand($, e.args, { typed: kind === 'composer' })
  } catch (err) {
    return failed(err)
  } finally {
    await saveOutputs($)
  }
}

// Claude Code's own catch: the command ran out of time (or failed outside the try above).
function editlensLate($, e, next) {
  if (next && next.error && next.error.kind === 'timeout') return output(errorRecords(new Error('timeout')))
  return output([rec({ k: 'fail', what: "/editlens didn't finish" }), rec({ k: 'fix', run: true, cmd: '/editlens details', after: 'to see whether EditLens is running, then try again' })])
}

// The skill's /editlens typed by the user (terminal or Remote Control): the mod answers it, so
// Claude doesn't run it as a Bash command. Other sessions (SDK, such as page control) get the skill.
async function skillRun($, e, next) {
  const kind = e && e.origin && e.origin.kind
  return kind === 'composer' || kind === 'bridge' ? answerEditlens($, e) : next(e)
}

// The skill is the one /editlens in the typeahead: listed with the command's own words.
async function describeSkill($, e, next) {
  const out = await next(e)
  return isRunnerSkill(e) ? { ...out, description: COMMAND_HELP } : out
}

export function register(on, opts) {
  options = opts && typeof opts === 'object' ? opts : {}

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    await startEditlens($, { atStart: true })
    // The first start ever, with a user at the prompt: one dim line (Claude Code adds "editlens:"
    // at the start). Later starts print nothing; the line above the prompt shows EditLens is on.
    if (e && e.isInteractive) await welcome($)
    return out
  })

  on('classic.SessionStart', keepPortOnClear)

  on('tool.call', async ($, e, next) => {
    const at = Date.now()
    const out = await next(e)
    if (!off && Date.now() - at >= ASKED_MIN_MS) await toolEnded($, e)
    return out
  })

  on('command.run', { command: 'editlens' }, editlensRun).catch(editlensLate)
  // Claude Code keeps /editlens for the plugin's skill (editlens:editlens) and refuses the mod's own.
  on('command.run', { command: 'editlens:editlens' }, skillRun).catch(editlensLate)

  on('command.describe', describeSkill)

  // The line above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e && typeof e.surface === 'string') drawnAt[e.surface] = Date.now()
    if (!started) await startEditlens($)
    if (current().line_above_prompt === false || (e.props && e.props.hasSurvey)) return next(e)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const theirs = await next(e)
    // Always exactly one row, fitted to the width Claude Code gives: a line that changed height
    // left letters of the old frame in the gaps (seen on Windows Terminal).
    const cols = e.props && Number.isFinite(e.props.bodyColumns) ? e.props.bodyColumns : 80
    const items = bandItems({ s: summary, busy, off, booting, cols, flash: pairedFlash })
    const children = [Text({ key: 'mark', color: 'claude', children: ['✦ '] })]
    items.forEach((it, i) => {
      if (i) children.push(Text({ key: 'gap-' + it.id, children: [it.button && items[i - 1].button ? '  ' : '   '] }))
      const b = it.button
      if (b && b.href) children.push(Link({ key: it.id, href: b.href, label: b.label }))
      else if (b) children.push(Button({ key: b.key, label: b.label, plain: true, onPress: () => bandPress($, b) }))
      else children.push(Text({ key: it.id, wrap: 'truncate-end', children: it.parts.map((p, j) => Text({ key: String(j), ...partStyle(p), children: [p.text] })) }))
    })
    const mine = Box({ key: 'editlens-band', flexDirection: 'row', flexWrap: 'nowrap', height: 1, overflow: 'hidden', children })
    return theirs && typeof theirs === 'object' ? Box({ flexDirection: 'column', children: [theirs, mine] }) : mine
  })

  // /editlens output, drawn in colour from its records (the text is still what Claude reads and
  // what appears where the mod doesn't draw).
  on('ui.render', { component: 'CommandOutput' }, drawOutput)

  // Desktop tool labels show only the tool's name ("PowerShell", "navigate"). Hovering the row shows
  // what it ran. The terminal already prints it, so its rows are left as they are.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const theirs = await next(e)
    if (!e || e.surface === 'terminal' || !theirs || typeof theirs !== 'object') return theirs
    const props = e.props || {}
    const detail = toolDetail(props.tool, props.input)
    if (!detail) return theirs
    const { Box, Text, Code } = $.ui.resolve(e)
    const id = String(props.tool_use_id || '').replace(/[^\w-]/g, '').slice(0, 64)
    const card = Box({ display: 'none', hover: { display: 'flex' }, flexDirection: 'column', paddingLeft: 2, children: [
      Text({ color: 'subtle', children: [detail.label] }),
      Code(detail.language ? { source: detail.source, language: detail.language } : { source: detail.source }),
    ] })
    return Box({ key: 'editlens-tool-' + (id || 'row'), flexDirection: 'column', children: [theirs, card] })
  })

  // The Settings pane: five groups, one row per setting (label, dotted line, value; the value is
  // the button that changes it to the next choice). Only the selected row shows its description,
  // so the pane fits on one screen.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== SETTINGS_PANE) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const cols = e.props && Number.isFinite(e.props.bodyColumns) ? e.props.bodyColumns : 80
    const sections = settingSections(schema)
    // Decided once for the whole pane, never per row: if too narrow for label, dots and value on
    // one line, every value is on its own line.
    const stacked = settingsStacked(cols, sections)
    // The terminal measures in cells, so the dots can fill the space exactly.
    const exact = e.surface === 'terminal'
    const values = current()
    const kids = [Box({ key: 'head', flexDirection: 'row', justifyContent: 'space-between', columnGap: 2, children: [
      Text({ children: [Text({ color: 'claude', children: ['✦ '] }), Text({ bold: true, children: ['EditLens settings'] })] }),
      ...(cols < NARROW ? [] : [Text({ dimColor: true, wrap: 'truncate-end', children: ['same as /config · saved now'] })]),
    ] })]
    const first = sections.length && sections[0].rows.length ? sections[0].rows[0].key : null
    if (selectedSetting === null) {
      const kept = await keptRow($)
      ;({ selected: selectedSetting, refocus } = firstFocus({ selected: selectedSetting, kept, refocus }))
    }
    const chosen = selectedSetting && (Object.hasOwn(schema, selectedSetting) || selectedSetting === HERE_ROW.key) ? selectedSetting : first
    // The focus starts on the picked row (after a change, Claude Code reloads this file), else the first.
    const canFocus = chosen === HERE_ROW.key || (Object.hasOwn(schema, chosen || '') && nextValue(schema[chosen], values[chosen], chosen) !== undefined)
    const focusKey = canFocus ? chosen : first
    settingsDrawn = true
    if (refocus && focusKey) {
      refocus = false
      const requestId = e.requestId
      $.clock.after(0, () => (refocusLater ? focusAgain($, refocusLater, '') : undefined))
      // Again at each later drawing until the next tick: Claude Code's own repaints after a reload can
      // leave the keys at the prompt (S9-e). A timer set here would end with this drawing.
      refocusLater = { requestId, key: 'set-' + focusKey, picked: selectedSetting }
    } else if (refocusLater && refocusLater.requestId === e.requestId) {
      $.clock.after(0, () => (refocusLater ? focusAgain($, refocusLater, ' on a later drawing') : undefined))
    }
    for (const sec of sections) {
      kids.push(Text({ key: 'gap-' + sec.title, children: [' '] }))
      kids.push(Box({ key: 'sec-' + sec.title, children: [Text({ color: 'subtle', wrap: 'truncate-end', children: [sec.title] })] }))
      for (const { key: k, label: name, field } of sec.rows) {
        const v = values[k]
        const to = nextValue(field, v, k)
        const asking = armed && armed.key === k && armed.value === to && Date.now() - armed.at < CONFIRM_MS
        const onPress = async () => {
          await pickRow($, k)
          if (pressAction(k, to, armed, Date.now()) === 'confirm') {
            armed = { key: k, value: to, at: Date.now() }
            $.ui.invalidate('ui.render')
            // Back to the plain value if there is no second press.
            $.clock.after(CONFIRM_MS, () => $.ui.invalidate('ui.render'))
            return
          }
          armed = null
          if (k !== 'permission_mode') return changeSetting($, k, field, to)
          // Here in the hook: the plugin directory reads a permission mode change only on the hook's own $.
          const value = to
          return settingFailed($, k, field, await settingAnswer($.config.set({ key: 'editlens.permission_mode', value })))
        }
        const picked = k === chosen
        const restart = k === 'port' && v !== port ? (portByEnv ? 'Uses ' + port + ' from EDITLENS_PORT.' : 'Applies after a restart.') : ''
        const value = settingValueCells(ui, { k, field, v, to, asking, focus: k === focusKey, onPress })
        const gutter = Box({ key: 'gutter', width: 2, flexShrink: 0, children: [Text({ color: 'claude', children: [picked ? '›' : ' '] })] })
        const line = stacked
          ? Box({ key: 'row', flexDirection: 'column', children: [
            Box({ key: 'name', flexDirection: 'row', children: [gutter, Text({ key: 'label', wrap: 'truncate-end', bold: picked, children: [name] })] }),
            Box({ key: 'val', flexDirection: 'row', paddingLeft: 4, children: [leader(ui, exact ? cols - 4 - 1 - COLS.setting : null), Text({ key: 'gap', children: [' '] }), Box({ key: 'value', width: COLS.setting, flexShrink: 0, flexDirection: 'row', children: value })] }),
          ] })
          : columnRow(ui, { key: 'row', gutter, label: name, labelStyle: picked ? { bold: true } : undefined, valueWidth: COLS.setting, value, dots: exact ? cols - 2 - cells(name) - 2 - COLS.setting : null })
        // A row changed only in /config (Port) can't be picked, so where to change it always shows.
        const elsewhere = [to === undefined ? paneNote(k, to).trim() : '', restart].filter(Boolean).join(' ')
        const below = asking ? Text({ key: 'warn', color: 'warning', wrap: 'wrap', children: ['! ' + CONFIRM[k].warning + ' ' + CONFIRM[k].label + '.'] })
          : picked ? Text({ key: 'about', color: 'subtle', wrap: 'wrap', children: [rangeNote(field) + firstSentence(field.description) + paneNote(k, to) + (restart ? ' ' + restart : '')] })
            : elsewhere ? Text({ key: 'about', color: 'subtle', wrap: 'wrap', children: [elsewhere] }) : null
        kids.push(Box({ key: 'row-' + k, flexDirection: 'column', children: [line, ...(below ? [Box({ key: 'below', paddingLeft: 4, children: [below] })] : [])] }))
      }
      // Effort here: this terminal's own level, read from Claude Code; the press opens its /effort.
      if (sec.title === HERE_ROW.group) {
        const picked = chosen === HERE_ROW.key
        const shown = effortWord(summary && summary.effortHere) || 'Not known'
        const value = [Button({ key: 'set-' + HERE_ROW.key, label: shown, plain: true, ...(focusKey === HERE_ROW.key ? { autoFocus: true } : {}), onPress: async () => {
          await pickRow($, HERE_ROW.key)
          return openEffort($)
        } })]
        const gutter = Box({ key: 'gutter', width: 2, flexShrink: 0, children: [Text({ color: 'claude', children: [picked ? '›' : ' '] })] })
        const name = HERE_ROW.label
        const line = stacked
          ? Box({ key: 'row', flexDirection: 'column', children: [
            Box({ key: 'name', flexDirection: 'row', children: [gutter, Text({ key: 'label', wrap: 'truncate-end', bold: picked, children: [name] })] }),
            Box({ key: 'val', flexDirection: 'row', paddingLeft: 4, children: [leader(ui, exact ? cols - 4 - 1 - COLS.setting : null), Text({ key: 'gap', children: [' '] }), Box({ key: 'value', width: COLS.setting, flexShrink: 0, flexDirection: 'row', children: value })] }),
          ] })
          : columnRow(ui, { key: 'row', gutter, label: name, labelStyle: picked ? { bold: true } : undefined, valueWidth: COLS.setting, value, dots: exact ? cols - 2 - cells(name) - 2 - COLS.setting : null })
        const below = picked ? Text({ key: 'about', color: 'subtle', wrap: 'wrap', children: [HERE_ROW.about] }) : null
        kids.push(Box({ key: 'row-' + HERE_ROW.key, flexDirection: 'column', children: [line, ...(below ? [Box({ key: 'below', paddingLeft: 4, children: [below] })] : [])] }))
      }
    }
    kids.push(Text({ key: 'gap-end', children: [' '] }))
    kids.push(Box({ key: 'foot', flexDirection: 'row', columnGap: 3, children: [
      Button({ key: 'reset', label: 'Reset to defaults', plain: true, onPress: async () => {
        for (const [k, field] of Object.entries(schema)) {
          // The port is left as it is: it is changed in /config, and only after a restart.
          if (k === 'port' || values[k] === field.default) continue
          if (k !== 'permission_mode') {
            await changeSetting($, k, field, field.default)
            continue
          }
          const value = field.default
          settingFailed($, k, field, await settingAnswer($.config.set({ key: 'editlens.permission_mode', value })))
        }
      } }),
      ...(cols < NARROW ? [] : [Text({ dimColor: true, wrap: 'truncate-end', children: ['Tab move · Enter change · Esc close'] })]),
    ] }))
    return Box({ flexDirection: 'column', children: kids })
  })

  // The selected row of the Settings pane follows the focus ring (arrows, Tab or a click), once Claude
  // Code has moved it: a refused move is no pick (S9-d). After the person moves to a row, the changed row
  // no longer takes the focus back. Not after a move to Reset: Enter there changes every setting.
  on('ui.focus', { requestId: SETTINGS_PANE }, async ($, e, next) => {
    const out = await next(e)
    const { row, person } = focusMove(e, out, schema)
    if (row && row !== selectedSetting) {
      await pickRow($, row)
      $.ui.invalidate('ui.render')
    }
    if (person && row) ({ refocus, refocusLater } = focusTarget({ refocus, refocusLater, drawn: settingsDrawn }, row))
    return out
  })

  // /editlens undo: this session's recent edits; undo the selected one alone or restore its file.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== UNDO_PANE) return next(e)
    return drawUndoPane($, $.ui.resolve(e), e)
  })

  // The selected edit follows the focus ring (its number), as in the Settings pane.
  on('ui.focus', { requestId: UNDO_PANE }, async ($, e, next) => {
    const m = typeof e.element === 'string' ? /^edit-(\d{1,6})$/.exec(e.element) : null
    const n = m ? Number(m[1]) : NaN
    if (Number.isInteger(n) && undoPane.list.some((x) => x.n === n)) pickEdit($, n)
    return next(e)
  })

  // /editlens sessions: page control's sessions and this project's tasks, in groups.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== SESSIONS_PANE) return next(e)
    return drawSessionsPane($, $.ui.resolve(e), e)
  })

  // The selected session follows the focus ring (its name), as in the undo pane.
  on('ui.focus', { requestId: SESSIONS_PANE }, async ($, e, next) => {
    const k = typeof e.element === 'string' && e.element.startsWith('session-') ? e.element.slice(8) : null
    if (k && sessionsModel(sessionsPane.data).groups.some((g) => g.rows.some((r) => r.key === k))) pickSession($, k)
    return next(e)
  })

  // The selected agent follows the focus ring (its name), as in the undo pane.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const k = typeof e.element === 'string' && e.element.startsWith('agent-') ? e.element.slice(6) : null
    if (k && agentsModel(summary).some((a) => a.key === k)) pickAgent($, k)
    return next(e)
  })

  // The Details pane: ✦ EditLens and the state, then only the rows that have a value, labels in a
  // fixed column (a long value wraps under itself), agents, and at most four plain-word buttons.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const cols = e.props && Number.isFinite(e.props.bodyColumns) ? e.props.bodyColumns : 80
    const m = detailsModel(off ? null : summary, { cols, booting })
    const draw = (parts, key) => Text({ key, wrap: 'wrap', children: parts.map((p, j) => Text({ key: String(j), ...partStyle(p), children: [p.text] })) })
    const kids = [Box({ key: 'head', flexDirection: 'row', justifyContent: 'space-between', columnGap: 2, children: [
      Text({ children: [Text({ color: 'claude', children: ['✦ '] }), Text({ bold: true, children: ['EditLens'] })] }),
      Box({ flexShrink: 1, children: [Text({ wrap: 'truncate-end', children: m.head.map((p, j) => Text({ key: String(j), ...partStyle(p), children: [p.text] })) })] }),
    ] })]
    kids.push(Text({ key: 'gap-head', children: [' '] }))
    const body = []
    for (const r of m.rows) {
      if (r.gap) body.push(Text({ key: 'gap-' + r.key, children: [' '] }))
      let value = r.href ? Link({ key: 'v', href: r.href, label: r.parts.map((p) => p.text).join('') }) : draw(r.parts, 'v')
      // A row's own button after its value (Effort: Change).
      const rb = r.button
      if (rb) value = Box({ key: 'v', flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: [draw(r.parts, 'text'), Button({ key: 'change-' + rb.key, label: rb.label, plain: true, onPress: async () => (rb.prompt ? openEffort($) : press($, rb.word)) })] })
      body.push(columnRow({ Box, Text }, { key: 'row-' + r.key, label: r.label, labelWidth: LABEL_W, labelStyle: { dimColor: true }, value: [value] }))
    }
    if (body.length) kids.push(Box({ key: 'body', flexDirection: 'column', paddingLeft: 2, children: body }))
    // The agents, with the selected one's details under it (gutter in column 0).
    if (m.agents.length) kids.push(Text({ key: 'gap-agents', children: [' '] }), drawAgents($, $.ui.resolve(e), m.agents, { cols, exact: e.surface === 'terminal' }))
    const after = []
    if (m.note) after.push(Text({ key: 'gap-note', children: [' '] }), Text({ key: 'note', dimColor: true, wrap: 'wrap', children: [m.note] }))
    if (m.fix) after.push(Box({ key: 'fix', flexDirection: 'row', columnGap: 2, children: [
      Text({ color: 'warning', bold: true, children: ['! Fix'] }), Text({ wrap: 'wrap', children: [Text({ color: 'suggestion', children: ['Run ' + m.fix.cmd] }), Text({ dimColor: true, children: [(/^[,.;]/.test(m.fix.after) ? '' : ' ') + m.fix.after] })] }),
    ] }))
    if (after.length) kids.push(Box({ key: 'after', flexDirection: 'column', paddingLeft: 2, children: after }))
    if (m.buttons.length) {
      if (body.length || after.length || m.agents.length) kids.push(Text({ key: 'gap-buttons', children: [' '] }))
      kids.push(Box({ key: 'actions', flexDirection: 'row', flexWrap: 'wrap', columnGap: cols < NARROW ? 2 : 3, paddingLeft: 2, children: m.buttons.map((b) => b.href
        ? Link({ key: b.key, href: b.href, label: b.label })
        : Button({ key: b.key, label: b.label, plain: true, onPress: async () => {
          if (b.key === 'settings') return $.ui.open({ id: SETTINGS_PANE, title: 'EditLens settings', focus: true, closeOnEscape: true })
          if (b.key === 'start') return boot($)
          return press($, b.word)
        } })) }))
    }
    return Box({ flexDirection: 'column', children: kids })
  })
}

// The Settings pane's picked row, kept in $.store with the session's id: each change reloads this
// file, which empties selectedSetting, and the focus is restored to that row (in this session only).
async function pickRow($, k) {
  selectedSetting = k
  try {
    await $.store.set('settingsRow', { key: k, session: (await $.session.id()) || null })
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not keep the picked setting', err)
  }
}
let refocusLater = null // { requestId, key, picked }: the Settings pane's focus request, sent again
// Only while the row picked then is still picked: never away from a row the person moved to (S9-d).
async function focusAgain($, again, when) {
  if (selectedSetting === again.picked) await focusRow($, again.requestId, again.key, when)
}
// Puts the focus ring on a row's value. Refused while the pane does not hold the keyboard (the
// person is at the prompt): the focus stays where the person put it.
async function focusRow($, requestId, key, when = '') {
  try {
    const out = await $.ui.focus({ requestId, key })
    if (out && out.deny) debugOnce($, 'the focus was not moved' + when, new Error(String(out.deny)))
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not move the focus' + when, err)
  }
}

// -> the row kept from before the reload, or null
async function keptRow($) {
  try {
    const kept = await $.store.get('settingsRow')
    const sid = await $.session.id()
    return kept && typeof kept.key === 'string' && kept.key && sid && kept.session === sid ? kept.key : null
  } catch (err) {
    if (!(err instanceof Error)) throw err
    debugOnce($, 'could not read the picked setting', err)
    return null
  }
}

// Settings in five groups, each row with a short label of at most 22 characters (plugin.json's
// titles stay for /config) and a short word for the text summary.
const SETTING_GROUPS = [
  ['Page control', 'Page control', [['start', '/editlens turns on'], ['permission_mode', 'Permission mode', 'mode'], ['effort', 'Effort', 'effort'], ['wait', 'Wait for page messages', 'wait']]],
  ['On the page', 'On the page', [['highlight', 'Highlight changes', 'highlights'], ['hover_code', 'Code on hover', 'code on hover'], ['pick_box', 'Box next to the pick', 'box next to the pick'], ['dictation', 'Dictation', 'dictation'], ['follow_page', 'Follow the page', 'follow'], ['permission_glow', 'Highlight when waiting', 'highlight when waiting'], ['theme', 'Panel colors', 'colors'], ['text_size', 'Text size', 'text'], ['expand_code_view', 'Expand code view', 'expand code view'], ['editor', 'Editor', 'editor']]],
  ['Safety', 'Safety', [['safety_check', 'Safety check', 'safety check'], ['subagent_copies', 'Subagent copies', 'subagent copies']]],
  ['Other computers', 'Other computers', [['remote_tasks', 'Can run Claude here', 'can run Claude here'], ['paired_answers', 'Can answer here', 'can answer here'], ['tasks_at_once', 'Tasks at once', 'tasks at once'], ['task_account', 'Run their tasks as', 'tasks as']]],
  ['Claude Code', 'Claude Code', [['auto_connect', 'Connect at start', 'connect at start'], ['line_above_prompt', 'Line above prompt', 'line above prompt'], ['port', 'Port', 'port']]],
]
// The Settings pane's row a focus move goes to, or null. A person's move before the settings list is
// read (right after a reload) counts too; the drawing checks the row (S9-d).
export function focusedRow(element, origin, fields) {
  const k = typeof element === 'string' && element.startsWith('set-') ? element.slice(4) : null
  if (!k) return null
  if (Object.hasOwn(fields, k) || k === HERE_ROW.key) return k
  return Object.keys(fields).length === 0 && !!origin && origin.kind === 'person' ? k : null
}
// The first drawing after a reload (a change): the open pane still has the keyboard, so autoFocus does
// not apply again; once drawn, the focus ring is restored to the kept row, or to the row the person
// moved to meanwhile (S9-d). selected: the picked row now; kept: the row kept from before the reload.
export function firstFocus({ selected, kept, refocus }) {
  if (selected === null) return { selected: kept, refocus: kept !== null }
  return { selected, refocus: refocus || kept !== null }
}
// After the person moved to a row: the focus requests after a reload go to that row, as Claude Code's
// repaints can move the focus out of the pane (S9-d). Before the first drawing, that drawing asks for it.
export function focusTarget({ refocus, refocusLater, drawn }, row) {
  if (!drawn) return { refocus: true, refocusLater }
  return { refocus, refocusLater: refocusLater ? { ...refocusLater, key: 'set-' + row, picked: row } : null }
}
// A move of the Settings pane's focus: the row it went to (null when Claude Code refused it, or not a
// row), and whether it was the person's. out: what Claude Code answered.
export function focusMove(e, out, fields) {
  if (out && out.deny) return { row: null, person: false }
  return { row: focusedRow(e.element, e.origin, fields), person: !!e.origin && e.origin.kind === 'person' }
}
// Not an EditLens setting: this terminal's effort (Claude Code's /effort), shown in the Claude
// Code group so both levels are together. EditLens only reads it.
export const HERE_ROW = { key: 'effort_here', label: 'Effort here', group: 'Claude Code', about: "This terminal's own level. Opens /effort." }
const SHORT_VALUES = { 'Connect and turn on page control': 'Connect and page control' }
// The pane's value column is 12 cells: what /editlens turns on, Root without its note (the red !
// and the description say it is unsafe), and Dictation's "On this device".
const PANE_VALUES = { 'Connect and turn on page control': 'Page control', 'Connect the page': 'Manual', 'Root (unsafe)': 'Root', 'On this device': 'This device' }

// -> [{ title, short, rows: [{ key, label, word, field }] }]; settings not named above go last.
export function settingSections(sch) {
  const all = sch || {}
  const seen = new Set()
  const out = []
  for (const [title, short, list] of SETTING_GROUPS) {
    const rows = list.filter(([k]) => Object.hasOwn(all, k)).map(([key, label, word]) => (seen.add(key), { key, label, word: word || null, field: all[key] }))
    if (rows.length) out.push({ title, short, rows })
  }
  const rest = Object.keys(all).filter((k) => !seen.has(k)).map((key) => ({ key, label: String(all[key].title || key), word: null, field: all[key] }))
  if (rest.length) out.push({ title: 'Other', short: 'Other', rows: rest })
  return out
}

// A value as the pane shows it: On/Off, or the choice in a short form.
export function settingShown(field, value) {
  const v = shownValue(field, value)
  return SHORT_VALUES[v] || v
}

// True when the Settings pane at this width puts every value on its own line: the longest label,
// gutter, two spaces and value column leave fewer than 3 cells for dots.
export function settingsStacked(cols, sections) {
  const width = Number.isFinite(cols) && cols > 0 ? cols : 80
  const longest = Math.max(0, ...sections.flatMap((sec) => sec.rows.map((r) => cells(r.label))))
  return width - 2 - longest - 2 - COLS.setting < 3
}

// The value column of one setting: ● On (green) or ○ Off (dim), a choice, or a value changed only
// in /config. The value is the Button; a Button has no colour, so the mark before it shows it.
function settingValueCells({ Text, Button }, { k, field, v, to, asking, focus, onPress }) {
  const shown = asking ? CONFIRM[k].button : PANE_VALUES[v] || settingShown(field, v)
  if (to === undefined) return [Text({ key: 'v', color: 'suggestion', wrap: 'truncate-end', children: [shown] })]
  const mark = field.type === 'boolean' ? Text({ key: 'm', color: v ? 'success' : 'subtle', children: [v ? '● ' : '○ '] })
    : k === 'task_account' && v === 'Root (unsafe)' ? Text({ key: 'm', color: 'error', children: ['! '] }) : null
  return [...(mark ? [mark] : []), Button({ key: 'set-' + k, label: shown, plain: true, ...(field.type === 'boolean' && !v ? { dimColor: true } : {}), ...(focus ? { autoFocus: true } : {}), onPress })]
}

// After the description: where to make a change the pane doesn't make.
export function paneNote(key, to) {
  if (to === undefined) return ' Change it in /config.'
  const skip = PANE_SKIPS[key]
  return skip ? ' ' + skip.join(', ') + (skip.length > 1 ? ' are' : ' is') + ' chosen in /config.' : ''
}

// Before the description of a stepped number: "1 to 8. ".
export function rangeNote(field) {
  return smallRange(field) ? field.min + ' to ' + field.max + '. ' : ''
}

// The first sentence of a setting's description: one dim line.
export function firstSentence(text) {
  const t = String(text || '').trim()
  const m = /^(.+?[.!?])(\s|$)/.exec(t)
  return m ? m[1] : t
}

// Other computers' on/off rows, as what they can do: [on, off].
const CAN_WORDS = { remote_tasks: ['can run Claude here', "can't run Claude here"], paired_answers: ['can answer here', "can't answer here"] }

// One line per group: [{ label, value, rest }] ("Page control", "Connect + page control", "Auto · wait off").
export function settingsLines(sch, values) {
  return settingSections(sch).map((sec) => {
    const bits = sec.rows.map((r) => {
      const v = values ? values[r.key] : undefined
      if (r.field.type === 'boolean' && CAN_WORDS[r.key]) return CAN_WORDS[r.key][v ? 0 : 1]
      if (r.field.type === 'boolean') return r.word ? r.word + (v ? ' on' : ' off') : settingShown(r.field, v)
      return (r.word ? r.word + ' ' : '') + settingShown(r.field, v)
    })
    return { label: sec.short, value: bits[0], rest: bits.slice(1).join(' · '), bits }
  })
}

// The groups as label ···· value rows. A group too long for one row continues on the rows below
// (no label, the same value column), so a row stays within 80 columns. -> [[label, value]]
export const SETTING_ROW = 60
export function settingRows(sch, values, max = SETTING_ROW) {
  return settingsLines(sch, values).flatMap((l) => {
    const rows = []
    for (const b of l.bits) {
      const last = rows.length - 1
      if (last >= 0 && cells(rows[last] + ' · ' + b) <= max) rows[last] += ' · ' + b
      else rows.push(b)
    }
    return rows.map((v, i) => [i ? '' : l.label, v])
  })
}

// The settings as text, for where no pane can be shown.
// The same rows as /editlens settings prints (bin/start.js): a dotted line to one value column.
// notes: effectNotes(), each a warning line under the rows, as bin/start.js prints them.
export function settingsText(sch, values, notes = []) {
  const rows = settingRows(sch, values)
  const width = fieldWidth(rows.map(([label]) => label))
  const lines = rows.map(([label, value]) => fieldLabel(label, width) + value)
  const after = notes.length ? ['', ...notes.map((n) => '! ' + n)] : []
  return ['✦ EditLens settings · change them in /config (search "editlens")', '', ...lines, ...after].join('\n')
}

const LABEL_W = COLS.details
const NARROW = 50

// The same page under 127.0.0.1, localhost or [::1] is one page: listed once (localhost first).
export function samePages(pages) {
  const key = (u) => String(u || '').replace(/^(https?:\/\/)(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i, '$1local')
  const out = []
  for (const p of pages) {
    if (!p || typeof p.url !== 'string' || !p.url) continue
    const k = key(p.url)
    const at = out.findIndex((o) => key(o.url) === k)
    if (at < 0) out.push(p)
    else if (/\/\/localhost/i.test(p.url) && !/\/\/localhost/i.test(out[at].url)) out[at] = { ...p, title: p.title || out[at].title }
  }
  return out
}

// "localhost:51051" (plus the path when it isn't /): an address as people say it.
export function shortAddress(url) {
  let u
  try {
    u = new URL(String(url || ''))
  } catch (err) {
    if (err && err.name === 'TypeError') return String(url || '') // URL's TypeError (see linkHref)
    throw err
  }
  const host = u.hostname === '127.0.0.1' || u.hostname === '[::1]' ? 'localhost' : u.hostname
  return host + (u.port ? ':' + u.port : '') + (u.pathname && u.pathname !== '/' ? u.pathname : '')
}

// 1000000 -> "1M", 200000 -> "200k".
export function fmtWindow(v) {
  return fmtTokens(v)
}

function fmtTime(ms) {
  const n = finite(ms)
  if (n === null) return ''
  const s = Math.round(n / 1000)
  return s < 60 ? s + ' s' : s < 3600 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1).replace(/\.0$/, '') + ' h'
}

// In Manual, this session's own numbers from Claude Code (model, window, context, cost) are used:
// they are exact from the start, while the server's come from the transcript after the first reply.
export function withLocal(s, local) {
  if (!s || !local || s.control === 'page') return s
  const t = s.tokens || {}
  // The user's auto-compact window (the server reads it) takes precedence over Claude Code's (the model's).
  const compact = t.windowSource === 'autocompact' && finite(t.window) !== null
  const window = compact ? finite(t.window) : finite(local.window) ?? finite(t.window)
  const context = finite(local.used) ?? finite(t.context)
  const percent = (compact ? null : finite(local.percent)) ?? (context !== null && window ? Math.min(100, (context / window) * 100) : finite(t.percent))
  return { ...s, model: local.model || s.model || null, tokens: { ...t, window, context, percent, costUSD: finite(local.usd) ?? finite(t.costUSD) } }
}

// The Agents list: Main, its subagents, and this project's tasks on or from paired computers, in
// the Details pane and /editlens agents. Same names, rows and words as the page's agent card.
const AGENT_STATUS_W = 18 // "Needs your answer"
const AGENT_LABEL_W = COLS.join // 13: "Edits go to" and its gap
const AGENT_INDENT = 6 // the details lines, under the name
const AGENT_TEXT_W = 58 // the plain-text list's width, for a narrow terminal
const SUBAGENTS_MAX = 6
const TASK_STATUS = { waiting: 'Waiting', starting: 'Starting', working: 'Working', idle: 'Done', ended: 'Ended', stopped: 'Stopped', failed: 'Failed', refused: "Didn't start" }

// "14:02"; '' when unknown.
function clockOf(ms) {
  const n = finite(ms)
  const d = n ? dateOf(n) : null
  if (!d) return ''
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// "6 min ago", "just now"; '' when unknown or later than now.
function agoOf(ms, now) {
  const n = finite(ms)
  const at = finite(now)
  if (!n || at === null || at < n) return ''
  return at - n < 10000 ? 'just now' : fmtTime(at - n) + ' ago'
}

// The first line of a task's prompt, cut to `max` characters.
function firstLineOf(text, max = 80) {
  const line = String(typeof text === 'string' ? text : '').split('\n').map((l) => oneLine(l, 400)).find(Boolean) || ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

// Every agent as data. -> [{ key, name, word, mark: { glyph, color }, status: { text, color }, working,
// rows: [{ label, parts }], follow: { key, agentId } | null, stop: { path, body } | null }]
// The stop and follow bodies leave out cwd, which the pane adds.
export function agentsModel(s, { now = Date.now() } = {}) {
  if (!s || typeof s !== 'object') return []
  const P = (text, style) => ({ text, ...(style || {}) })
  const out = []
  const started = (at, edits) => {
    const n = finite(edits) || 0
    const tail = [agoOf(at, now), n ? n + (n === 1 ? ' edit' : ' edits') : ''].filter(Boolean).join(' · ')
    return clockOf(at) ? [P(clockOf(at)), ...(tail ? [P(' · ' + tail, { dim: true })] : [])] : null
  }
  const push = (a, rows) => out.push({ ...a, rows: rows.filter((r) => r[1] && r[1].length).map(([label, parts]) => ({ label, parts })) })
  const text = (v) => (typeof v === 'string' && v ? [P(v)] : null)
  // "Opus 5.5 · 1M context": the window when known, or from a [1m] model name.
  const model = (m, win) => {
    if (typeof m !== 'string' || !m) return null
    const w = finite(win) || (/\[1m\]$/i.test(m) ? 1000000 : null)
    return [P(modelLabel(m)), ...(w ? [P(' · ' + fmtWindow(w) + ' context', { dim: true })] : [])]
  }
  const working = { glyph: '◐', color: 'claude' }
  // Main: this session (or page control's copy of it).
  const asks = finite(s.permissions) || 0
  const t = s.tokens || {}
  const win = finite(t.window)
  const mainWorks = s.state === 'working' || s.state === 'starting'
  const mainEffort = effortWord(s.effort)
  push({
    // A name given in the Sessions list (page control's session) is used here too.
    key: 'main', name: oneLine(s.mainName, 80) || 'Main', word: '', working: mainWorks || asks > 0,
    mark: asks ? { glyph: '!', color: 'warning' } : mainWorks ? working : { glyph: '●', color: 'success' },
    status: asks ? { text: 'Needs your answer', color: 'warning' } : { text: STATE_LABELS[s.state] && s.state !== 'unknown' ? STATE_LABELS[s.state] : '', color: mainWorks ? 'claude' : null },
    follow: { key: 'main' }, stop: null,
  }, [
    ['Computer', [P('This computer')]],
    ['Agent', [P('Your session')]],
    ['Edits go to', [P('This project')]],
    ['Model', model(s.model, win)],
    ['Effort', text(mainEffort)],
    ['Mode', MODE_LABELS[s.mode] ? [P(MODE_LABELS[s.mode])] : null],
  ])
  // Subagents, newest first; a running one can be stopped only when page control runs it.
  const subs = (Array.isArray(s.agents) ? s.agents : []).filter((a) => a && typeof a === 'object' && typeof a.key === 'string').slice().reverse()
  for (const a of subs.slice(0, SUBAGENTS_MAX)) {
    const runs = a.status === 'working'
    const failed = a.status === 'failed'
    const end = finite(a.endedAt)
    const took = !runs && finite(a.startedAt) && end !== null && end >= a.startedAt ? fmtTime(end - a.startedAt) : ''
    const name = oneLine(a.name, 80) || oneLine(a.type, 40) || 'Subagent'
    push({
      key: a.key, name, word: '', working: runs,
      mark: runs ? working : failed ? { glyph: '✕', color: 'error' } : { glyph: '●', color: 'success' },
      status: { text: runs ? 'Working' : (failed ? 'Failed' : 'Done') + (took ? ' · ' + took : ''), color: runs ? 'claude' : failed ? 'error' : null },
      follow: { key: a.key, ...(typeof a.agentId === 'string' && a.agentId ? { agentId: a.agentId } : {}) },
      stop: runs && s.control === 'page' ? { path: '/agents/stop', body: { agent: typeof a.agentId === 'string' && a.agentId ? a.agentId : a.key } } : null,
    }, [
      ['Computer', [P('This computer')]],
      ['Agent', [P('Subagent'), ...(a.type && oneLine(a.type, 40) !== name ? [P(' · ' + oneLine(a.type, 40), { dim: true })] : [])]],
      ['Edits go to', [P('This project')]],
      ['Model', model(a.model)],
      // Subagents run at Main's level (Claude Code reports none of their own).
      ['Effort', mainEffort && mainEffort !== 'Effort not used' ? [P(mainEffort), P(' · same as Main', { dim: true })] : [P('Same as Main')]],
      ['Started', started(a.startedAt)],
    ])
  }
  if (subs.length > SUBAGENTS_MAX) out.push({ more: subs.length - SUBAGENTS_MAX })
  // Tasks: given to a paired computer from this project (there), or from one, run here (here).
  for (const k of Array.isArray(s.tasks) ? s.tasks : []) {
    if (!k || typeof k !== 'object' || !/^[0-9a-f]{12}$/.test(String(k.task || ''))) continue
    const there = k.where === 'there'
    const computer = oneLine(k.computer, 100) || 'a paired computer'
    const st = String(k.state || '')
    const waits = finite(k.waiting) || 0
    const runs = st === 'starting' || st === 'working'
    const failed = st === 'failed' || st === 'refused'
    const live = runs || waits > 0 || st === 'waiting'
    const status = waits ? { text: there ? 'Needs your answer there' : 'Needs your answer', color: 'warning' }
      : { text: TASK_STATUS[st] || 'Done', color: runs ? 'claude' : st === 'waiting' ? 'warning' : failed ? 'error' : null }
    const mark = waits ? { glyph: '!', color: 'warning' } : runs ? working : st === 'waiting' ? { glyph: '●', color: 'warning' }
      : failed ? { glyph: '✕', color: 'error' } : st === 'stopped' || st === 'ended' ? { glyph: '○', color: 'subtle' } : { glyph: '●', color: 'success' }
    const login = there ? oneLine(k.login, 100) : ''
    const kind = String(k.kind || '')
    const goes = there ? (kind === 'mine' ? 'A copy of this project' : 'Its own project')
      : kind === 'sent' ? 'A copy of ◆ ' + computer + "'s project" : kind === 'copy' ? 'A copy of this project' : 'This project'
    const given = oneLine(k.name, 80)
    push({
      key: there ? 'r:' + computer + ':' + k.task : 'task:' + k.task,
      name: given || (there ? '◆ ' + computer : 'Task from ◆ ' + computer), word: there ? (given ? '◆ ' + computer : 'Task') : '', working: live, mark, status,
      follow: { key: there ? 'r:' + computer + ':' + k.task : 'task:' + k.task },
      stop: live ? (there ? { path: '/remote/task', body: { op: 'stop', computer, task: k.task } } : { path: '/agents/stop', body: { task: k.task } }) : null,
    }, [
      ['Doing', text(firstLineOf(k.prompt))],
      ['Computer', there ? [P(computer), ...(login ? [P(' · ' + login, { dim: true })] : [])] : [P('This computer')]],
      ['Agent', [P(there ? 'Task you started' : 'Task from ◆ ' + computer)]],
      ['Edits go to', [P(goes)]],
      ['Model', model(k.model)],
      ['Effort', text(effortWord(k.effort))],
      ['Mode', MODE_LABELS[k.mode] ? [P(MODE_LABELS[k.mode])] : null],
      ['Started', started(k.startedAt, k.editCount)],
    ])
  }
  return out
}

// "1 running · 3 total" (Main counts when it is working).
function agentsCount(list) {
  const all = list.filter((a) => !a.more)
  const more = list.reduce((n, a) => n + (a.more || 0), 0)
  const running = all.filter((a) => a.working).length
  return { running, total: all.length + more }
}

// One agent's list row as plain text: "  ● Main ········ Idle", the status in one column.
function agentLine(a, picked) {
  if (a.more) return '    and ' + a.more + ' more'
  const head = (picked ? '› ' : '  ') + a.mark.glyph + ' ' + a.name + (a.word ? ' · ' + a.word : '')
  const dots = Math.max(2, AGENT_TEXT_W - cells(head) - 2 - AGENT_STATUS_W)
  return a.status.text ? head + ' ' + '·'.repeat(dots) + ' ' + a.status.text : head
}

// Its details as plain text: label column 13, six cells in.
function agentDetailLines(a) {
  return a.rows.map((r) => ' '.repeat(AGENT_INDENT) + r.label.padEnd(AGENT_LABEL_W) + r.parts.map((p) => p.text).join(''))
}

// /editlens agents: the list, then the details of every working agent.
export function agentsText(s, { now = Date.now() } = {}) {
  if (!s) return '✦ Agents  ✕ EditLens isn\'t running\n\n' + rec({ k: 'fix', run: true, cmd: '/editlens', after: 'to start it and connect your page' }).plain[0]
  const list = agentsModel(s, { now })
  const { running, total } = agentsCount(list)
  const lines = ['✦ Agents  · ' + (running ? running + ' running · ' : '') + total + ' total', '']
  for (const a of list) {
    lines.push(agentLine(a, false))
    if (a.working && !a.more && a.rows.length) lines.push(...agentDetailLines(a))
  }
  lines.push('', '  /editlens details  follow or stop one')
  return lines.join('\n')
}

// The Sessions list: page control's conversations and this project's tasks, here and on paired
// computers, in groups. The selected row shows how it started, the command that continues it in
// Claude Code (shown, never run: it would replace this session), then Open, Stop and Rename.
// /editlens sessions prints the same rows where no pane can be shown.
const SESSIONS_PANE = 'editlens-sessions'
const SESSION_STATUS_W = 18 // "Stopped · yesterday" is cut to fit
const SESSION_INDENT = 6 // the lines under a row's name, as the agents list
const SESSION_STATUS = { working: 'Working', starting: 'Starting', asking: 'Needs your answer', signin: 'Needs sign-in', waiting: 'Waiting', idle: 'Done', stopped: 'Stopped', ended: 'Ended', failed: 'Failed', refused: "Didn't start" }
export const SESSIONS_HINT = '› ↑ ↓ picks one. Typed: /editlens sessions, /editlens stop <name>'

// "14:02" today, "yesterday", or "Oct 3" ("Oct 9, 16:40" with the clock: when it started); ''
// when unknown.
function whenOf(ms, now, withClock = false) {
  const n = finite(ms)
  const d = n ? dateOf(n) : null
  if (!d) return ''
  const day = (x) => new Date(x).toDateString()
  if (day(n) === day(now)) return clockOf(n)
  if (!withClock && day(n) === day(now - 86400000)) return 'yesterday'
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + (withClock ? ', ' + clockOf(n) : '')
}

// GET /sessions as data. -> { total, running, groups: [{ key, title, slots, rows: [{ key, kind, name,
// mark, status, line, command, here, running, follow }] }] }. cwd: this terminal's folder (a
// session of this folder continues with claude --resume <id> alone).
export function sessionsModel(data, { cwd = '', now = Date.now() } = {}) {
  const d = data && typeof data === 'object' ? data : {}
  const groups = []
  for (const g of Array.isArray(d.groups) ? d.groups : []) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.rows)) continue
    const rows = []
    for (const r of g.rows) {
      if (!r || typeof r !== 'object' || typeof r.key !== 'string') continue
      const st = typeof r.state === 'string' && Object.hasOwn(SESSION_STATUS, r.state) ? r.state : 'ended'
      const there = r.kind === 'there'
      const live = r.running === true
      // A page control session that is on and waiting for a message: Idle, not Done.
      const word = st === 'idle' && r.kind === 'page' && live ? 'Idle' : st === 'asking' && there ? 'Needs your answer there' : SESSION_STATUS[st]
      const at = ['stopped', 'ended', 'idle', 'failed'].includes(st) && !live ? whenOf(r.at, now) : ''
      const mark = st === 'asking' || st === 'signin' ? { glyph: '!', color: 'warning' } : st === 'working' || st === 'starting' ? { glyph: '◐', color: 'claude' }
        : st === 'waiting' ? { glyph: '●', color: 'warning' } : st === 'failed' || st === 'refused' ? { glyph: '✕', color: 'error' }
          : st === 'idle' ? { glyph: '●', color: 'success' } : { glyph: '○', color: 'subtle' }
      const color = st === 'working' || st === 'starting' ? 'claude' : st === 'asking' || st === 'signin' || st === 'waiting' ? 'warning' : st === 'failed' || st === 'refused' ? 'error' : null
      const slots = r.slots && Number.isSafeInteger(r.slots.running) && Number.isSafeInteger(r.slots.limit) ? r.slots : null
      const how = oneLine(r.how, 120) || (r.kind === 'page' ? 'Page control' : 'Task')
      const line = st === 'waiting' && slots
        ? how.replace(/ · .*$/, '') + ' · ' + slots.running + ' of ' + slots.limit + ' already running'
        : [how, typeof r.model === 'string' && r.model ? modelLabel(r.model) : '', EFFORT_LABELS[r.effort] || '', MODE_LABELS[r.mode] || '', whenOf(r.startedAt, now, true)].filter(Boolean).join(' · ')
      const folder = typeof r.folder === 'string' ? r.folder : ''
      const sid = typeof r.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(r.sessionId) ? r.sessionId : ''
      // In this folder, here: claude --resume <id> alone; anywhere else the whole command.
      const command = typeof r.command === 'string' && r.command ? (!there && sid && folder && folder === cwd && r.command === 'cd "' + folder + '" && claude --resume ' + sid ? 'claude --resume ' + sid : r.command) : ''
      rows.push({ key: r.key, kind: r.kind, name: oneLine(r.name, 80) || 'Session', ownName: oneLine(r.ownName, 80), mark, status: { text: word + (at ? ' · ' + at : ''), color },
        line, command, there, computer: there ? oneLine(r.computer, 100) : '', running: live, follow: typeof r.follow === 'string' && r.follow ? r.follow : null })
    }
    if (rows.length) groups.push({ key: String(g.key || ''), title: oneLine(g.title, 120) || 'This computer', slots: g.slots && Number.isSafeInteger(g.slots.running) ? g.slots : null, rows })
  }
  const all = groups.flatMap((g) => g.rows)
  // A waiting task can be stopped like a running one, but is counted as waiting.
  const waiting = all.filter((r) => r.running && r.status.text === SESSION_STATUS.waiting).length
  return { groups, total: all.length, running: all.filter((r) => r.running).length - waiting, waiting }
}

// "5 · 2 running"
function sessionsCount(m) {
  return m.total + (m.running ? ' · ' + m.running + ' running' : '') + (m.waiting ? ' · ' + m.waiting + ' waiting' : '')
}

// "Continue here" (this computer) or "Continue on ◆ name" (run it there).
function continueLabel(r) {
  return r.there ? 'Continue on ◆ ' + r.computer : 'Continue here'
}

// One row as plain text: "  ◐ Make the header blue ········ Working", the status in one column.
function sessionLine(r, picked) {
  const head = (picked ? '› ' : '  ') + r.mark.glyph + ' ' + r.name
  const dots = Math.max(2, AGENT_TEXT_W - cells(head) - 2 - SESSION_STATUS_W)
  return head + ' ' + '·'.repeat(dots) + ' ' + r.status.text
}

// /editlens sessions where no pane can be shown: every row with its line and its command.
export function sessionsText(data, { cwd = '', now = Date.now(), down = false } = {}) {
  if (down) return '✦ Sessions  ✕ EditLens isn\'t running\n\n' + rec({ k: 'fix', run: true, cmd: '/editlens', after: 'to start it and connect your page' }).plain[0]
  const m = sessionsModel(data, { cwd, now })
  const lines = ['✦ Sessions  ' + sessionsCount(m), '']
  if (!m.total) lines.push('  No sessions in this project yet. Page control and tasks show here.')
  m.groups.forEach((g, i) => {
    if (i) lines.push('')
    lines.push(g.title)
    for (const r of g.rows) {
      lines.push(sessionLine(r, false))
      if (r.line) lines.push(' '.repeat(SESSION_INDENT) + r.line)
      if (r.command) lines.push(' '.repeat(SESSION_INDENT) + continueLabel(r) + '  ' + r.command)
    }
  })
  lines.push('', '  /editlens stop <name>  stops a running one', '  /editlens details      follows one on your page')
  return lines.join('\n')
}

// "/editlens stop <name>": a name, not "remove" (stop remove disconnects and removes the marked lines).
export function stopName(args) {
  const words = splitArgs(args)
  if (words.length < 2 || words[0].toLowerCase() !== 'stop') return null
  if (words.length === 2 && words[1].toLowerCase() === 'remove') return null
  return words.slice(1).join(' ')
}

// What /editlens stop <name> says. r: POST /sessions/stop's { status, json }, or { down: true }.
export function stopNameRecords(r, name) {
  const asked = oneLine(name, 60) || 'that session'
  const names = { k: 'fix', before: 'See their names in', cmd: '/editlens sessions', after: '' }
  if (!r || r.down) return [rec({ k: 'fail', what: "EditLens isn't running, so no session is running here" }), rec({ k: 'fix', run: true, cmd: '/editlens', after: 'to start it' })]
  const j = r.json && typeof r.json === 'object' ? r.json : {}
  if (r.status === 200 && !j.error) {
    const who = oneLine(j.stopped, 80) || asked
    return [rec({ k: 'done', text: 'Stopped ' + who, note: j.kind === 'page' ? '· the page is in Manual again' : '· it stays in /editlens sessions' })]
  }
  if (r.status === 404) return [rec({ k: 'fail', what: 'No session here is named "' + asked + '"' }), rec({ ...names, k: 'fix' })]
  if (r.status === 409 && Array.isArray(j.choices)) return [rec({ k: 'fail', what: j.choices.length + ' running sessions are named "' + asked + '"' }), rec({ k: 'fix', before: 'Rename one in', cmd: '/editlens sessions', after: ', then try again' })]
  if (r.status === 409 && typeof j.name === 'string') return [rec({ k: 'fail', what: '"' + oneLine(j.name, 60) + '" is not running' }), rec({ ...names, k: 'fix' })]
  return [rec({ k: 'fail', what: "Couldn't stop " + asked, ...(typeof j.error === 'string' && j.error ? { detail: oneLine(j.error, 200) } : Number.isInteger(r.status) ? { detail: 'error ' + r.status } : {}) }), rec({ ...names, k: 'fix' })]
}

// The pane's state: the list, the selected row, a rename in progress, what the last press did.
let sessionsPane = { data: null, error: null, cwd: '', pick: null, renaming: null, result: null, busy: false }

// While the Sessions pane is open, its list is loaded again every few ticks (sessions start, stop
// and change state); not while a press is running or a name is being typed.
const SESSIONS_RELOAD_TICKS = 3
let sessionsTicks = 0
let sessionsReloading = false
async function reloadSessionsPane($) {
  if (sessionsReloading || ++sessionsTicks < SESSIONS_RELOAD_TICKS) return
  sessionsTicks = 0
  if (sessionsPane.busy || sessionsPane.renaming) return
  sessionsReloading = true
  try {
    if (!(await $.ui.panes()).some((p) => p.id === SESSIONS_PANE)) return
    await loadSessions($)
    $.ui.invalidate('ui.render')
  } finally {
    sessionsReloading = false
  }
}

async function loadSessions($) {
  const { cwd } = await sessionPlace($)
  const r = await editsCall($, 'GET', '/sessions?cwd=' + encodeURIComponent(cwd))
  const ok = !r.down && r.json && Array.isArray(r.json.groups)
  sessionsPane.cwd = cwd
  sessionsPane.data = ok ? r.json : null
  sessionsPane.error = ok ? null : r.down ? "EditLens isn't running. Run /editlens to start it." : "EditLens couldn't list the sessions" + (Number.isInteger(r.status) ? ' (error ' + r.status + ')' : '')
}

function pickSession($, key) {
  if (key === sessionsPane.pick) return
  sessionsPane.pick = key
  if (sessionsPane.renaming !== key) sessionsPane.renaming = null
  if (sessionsPane.result && sessionsPane.result.key !== key) sessionsPane.result = null
  $.ui.invalidate('ui.render')
}

// What a press in the pane said. r: { status, json } or { down: true }.
export function sessionOutcome(r, action, name) {
  if (!r || r.down) return { kind: 'fail', text: "EditLens isn't running. Run /editlens to start it." }
  const j = r.json && typeof r.json === 'object' ? r.json : null
  if (j && r.status === 200 && !j.error) {
    if (action === 'rename') return { kind: 'ok', text: 'Renamed to ' + oneLine(j.name, 80) + '.' }
    return { kind: 'ok', text: action === 'open' ? 'Your page follows ' + name + ' now.' : 'Stopped ' + name + '.' }
  }
  if (j && typeof j.error === 'string' && j.error) return { kind: 'fail', text: oneLine(j.error, 300) }
  const verb = action === 'open' ? 'open ' : action === 'rename' ? 'rename ' : 'stop '
  return { kind: 'fail', text: "Couldn't " + verb + name + (Number.isInteger(r.status) ? ' (error ' + r.status + ')' : '') }
}

// Open: this project's pages follow it. Stop: as its own Stop (page control switches to Manual).
// Rename: the name EditLens saves for it ('' restores its own name).
async function sessionAct($, row, action, value) {
  if (sessionsPane.busy) return
  sessionsPane.busy = true
  sessionsPane.pick = row.key
  sessionsPane.result = null
  $.ui.invalidate('ui.render')
  try {
    const { cwd } = await sessionPlace($)
    const r = action === 'open' ? await editsCall($, 'POST', '/agents/follow', { cwd, key: row.follow })
      : action === 'stop' ? await editsCall($, 'POST', '/sessions/stop', { cwd, key: row.key })
        : await editsCall($, 'POST', '/sessions/rename', { cwd, key: row.key, name: String(value || '') })
    sessionsPane.result = { key: row.key, ...sessionOutcome(r, action, row.name) }
    if (action === 'rename' && sessionsPane.result.kind === 'ok') sessionsPane.renaming = null
    await loadSessions($)
    if (action !== 'open') await refresh($)
  } finally {
    sessionsPane.busy = false
    $.ui.invalidate('ui.render')
  }
}

// The pane: ✦ Sessions and the count, then each group (its title in the subtle colour) and its rows:
// gutter, status mark, name (the button that selects it), a dotted line, the status column.
function drawSessionsPane($, ui, e) {
  const { Box, Text, Button, Input } = ui
  const cols = e.props && Number.isFinite(e.props.bodyColumns) ? e.props.bodyColumns : 80
  const exact = e.surface === 'terminal'
  const narrow = cols < NARROW
  const statusW = narrow ? 12 : SESSION_STATUS_W
  const m = sessionsModel(sessionsPane.data, { cwd: sessionsPane.cwd })
  const all = m.groups.flatMap((g) => g.rows)
  if (!all.some((r) => r.key === sessionsPane.pick)) sessionsPane.pick = (all.find((r) => r.running) || all[0] || {}).key || null
  const kids = [Box({ key: 'head', flexDirection: 'row', columnGap: 2, children: [
    Text({ children: [Text({ color: 'claude', children: ['✦ '] }), Text({ bold: true, children: ['Sessions'] })] }),
    ...(m.total ? [Text({ dimColor: true, children: [sessionsCount(m)] })] : []),
  ] })]
  if (sessionsPane.error) kids.push(Text({ key: 'gap-error', children: [' '] }), Text({ key: 'error', wrap: 'wrap', children: [Text({ color: 'error', children: ['✕ '] }), Text({ children: [sessionsPane.error] })] }))
  else if (!m.total) kids.push(Text({ key: 'gap-none', children: [' '] }), Text({ key: 'none', dimColor: true, wrap: 'wrap', children: ['No sessions in this project yet. Page control and tasks show here.'] }))
  let first = true
  for (const g of m.groups) {
    kids.push(Text({ key: 'gap-' + g.key, children: [' '] }))
    kids.push(Box({ key: 'group-' + g.key, children: [Text({ color: 'subtle', wrap: 'truncate-end', children: [g.title] })] }))
    for (const r of g.rows) {
      const picked = r.key === sessionsPane.pick
      const room = Math.max(8, cols - 4 - 3 - statusW)
      const name = cells(r.name) <= room ? r.name : [...r.name].slice(0, room - 1).join('') + '…'
      const used = 4 + cells(name) + 2 + statusW
      kids.push(Box({ key: 'session-row-' + r.key, flexDirection: 'row', children: [
        Box({ key: 'gutter', width: 2, flexShrink: 0, children: [Text({ color: 'claude', children: [picked ? '›' : ' '] })] }),
        Box({ key: 'mark', width: 2, flexShrink: 0, children: [Text({ color: r.mark.color, children: [r.mark.glyph] })] }),
        Box({ key: 'name', flexShrink: 0, children: [Button({ key: 'session-' + r.key, label: name, plain: true, ...(first ? { autoFocus: true } : {}), onPress: () => pickSession($, r.key) })] }),
        Text({ key: 'gap-a', children: [' '] }), leader(ui, exact ? cols - used : null), Text({ key: 'gap-b', children: [' '] }),
        Box({ key: 'status', width: statusW, flexShrink: 0, children: [Text({ wrap: 'truncate-end', ...(r.status.color ? { color: r.status.color } : { dimColor: true }), children: [r.status.text || ' '] })] }),
      ] }))
      first = false
      if (!picked) continue
      const line = (key, children) => Box({ key: key + '-' + r.key, paddingLeft: SESSION_INDENT, flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children })
      if (r.line) kids.push(line('how', [Text({ dimColor: true, wrap: 'wrap', children: [r.line] })]))
      // Shown, never run: running it here would replace this session.
      kids.push(line('continue', [Text({ key: 'l', dimColor: true, children: [continueLabel(r)] }),
        r.command ? Text({ key: 'c', color: 'suggestion', wrap: 'wrap', children: [r.command] }) : Text({ key: 'c', dimColor: true, wrap: 'wrap', children: ["after Claude's first reply"] })]))
      if (sessionsPane.busy) {
        kids.push(line('busy', [Text({ dimColor: true, children: ['Working…'] })]))
        continue
      }
      if (sessionsPane.renaming === r.key && Input) {
        kids.push(line('rename', [
          Input({ key: 'rename-input', label: 'Name ', value: r.name, placeholder: r.ownName || 'Its own name', submitLabel: 'save', autoFocus: true, onSubmit: (v) => sessionAct($, r, 'rename', v) }),
          Button({ key: 'rename-cancel', label: 'Cancel', plain: true, onPress: () => { sessionsPane.renaming = null; $.ui.invalidate('ui.render') } }),
        ]))
        kids.push(line('rename-hint', [Text({ dimColor: true, wrap: 'wrap', children: ['Enter saves. An empty name gives it its own name back.'] })]))
      } else {
        kids.push(line('buttons', [
          ...(r.follow ? [Button({ key: 'open-session', label: 'Open', plain: true, onPress: () => sessionAct($, r, 'open') })] : []),
          ...(r.running ? [Button({ key: 'stop-session', label: 'Stop', plain: true, onPress: () => sessionAct($, r, 'stop') })] : []),
          ...(Input && r.key !== 'pc:new' ? [Button({ key: 'rename-session', label: 'Rename', plain: true, onPress: () => { sessionsPane.renaming = r.key; sessionsPane.result = null; $.ui.invalidate('ui.render') } })] : []),
        ]))
      }
      const res = sessionsPane.result && sessionsPane.result.key === r.key ? sessionsPane.result : null
      if (res) kids.push(line('result', [Text({ key: 't', wrap: 'wrap', children: [Text({ color: res.kind === 'ok' ? 'success' : 'error', children: [res.kind === 'ok' ? '✓ ' : '✕ '] }), Text({ children: [res.text] })] })]))
    }
  }
  kids.push(Text({ key: 'gap-hint', children: [' '] }), Text({ key: 'hint', dimColor: true, wrap: narrow ? 'wrap' : 'truncate-end', children: [SESSIONS_HINT] }))
  return Box({ flexDirection: 'column', children: kids })
}

// The Details pane as data, drawn by the pane and printed by detailsText(): only rows with a value.
// -> { head: parts, rows: [{ key, label, parts, href }], note, agents (agentsModel), buttons, fix }
// The option is named bootState because a parameter named boot (like the function boot) made
// Claude Code 2.1.287 refuse to load this file.
export function detailsModel(s, { cols = 80, booting: bootState = null, now = Date.now() } = {}) {
  const narrow = Number.isFinite(cols) && cols < NARROW
  const P = (text, style) => ({ text, ...(style || {}) })
  if (!s) {
    if (bootState === 'starting') return { head: [P('◜ ', { color: 'claude' }), P('Starting…', { dim: true })], rows: [], agents: [], buttons: [] }
    const why = typeof bootState === 'string' && bootState ? bootState : 'the live server is off'
    const port = /port|in use|EADDRINUSE/i.test(why)
    return {
      head: [P('✕ ', { color: 'error' }), P('Not running'), P(' · ' + why, { dim: true })],
      rows: [], agents: [],
      fix: port ? { run: true, cmd: '/editlens settings', after: ', change Port, then restart Claude Code' } : { run: true, cmd: '/editlens', after: 'to start it and connect your page' },
      buttons: [{ key: 'start', label: 'Start' }, { key: 'settings', label: 'Settings' }],
    }
  }
  const t = s.tokens || {}
  const page = s.control === 'page'
  const asks = finite(s.permissions) || 0
  const state = STATE_LABELS[s.state] && s.state !== 'unknown' ? STATE_LABELS[s.state] : ''
  const head = asks
    ? [P(' ! ' + asks + (asks === 1 ? ' question ' : ' questions '), { pill: true }), P(' on your page', { dim: true })]
    : [page ? P('● ', { color: 'success' }) : P('○ '), P(page ? 'Page control' : 'Manual'), ...(state ? [P(' · ' + state, { dim: true })] : [])]
  const rows = []
  const row = (key, label, parts, extra) => rows.push({ key, label, parts, ...(extra || {}) })
  const pages = samePages(Array.isArray(s.pages) ? s.pages : [])
  pages.forEach((p, i) => {
    const addr = shortAddress(p.url)
    row('page-' + i, i ? '' : 'Page', [P(!narrow && p.title ? p.title + ' · ' + addr : addr)], { href: keyedHref(linkHref(p.url), s.pageKey) })
  })
  if (!pages.length && !s.connection) row('page', 'Page', [P('None open', { dim: true })])
  const from = openFromOf(s)
  if (from && from.paired) {
    if (from.paired.url) row('open', 'Open', [P('on ◆ ' + from.paired.name + ' · ' + shortAddress(from.paired.url))], { href: from.paired.url })
    else row('open', 'Open', [P('on ◆ ' + from.paired.name), P(' · /editlens join there shows the address', { dim: true })])
  } else if (from) {
    row('open', 'Open', [P('No browser here. On your computer run:', { dim: true })])
    row('open-ssh', '', [P(from.ssh, { bold: true })])
    if (from.sshKey) {
      row('open-key', '', [P('With a key file:', { dim: true })])
      row('open-ssh-key', '', [P(from.sshKey, { bold: true })])
    }
    // With the page key where pages need it (D21): the whole address, as it must be typed there.
    const url = keyedHref(linkHref(from.url), s.pageKey) || from.url
    row('open-url', '', [P('then open ', { dim: true }), P(url.includes('#') ? url : shortAddress(url))], { href: linkHref(url) || undefined })
    if (from.other) row('open-pair', '', [P('◆ ' + from.other.name + ' is paired for ' + from.other.folder + '. For this folder: /editlens pair here, then /editlens join on it.', { dim: true })])
  }
  // Paired computers by name (each pairing, so an old one can be seen and removed), and an open code.
  const pairing = s.paired && typeof s.paired === 'object' ? s.paired : {}
  const hosted = (Array.isArray(pairing.host) ? pairing.host : []).filter((h) => h && typeof h.name === 'string' && h.here !== false)
  const joinedTo = (Array.isArray(pairing.joined) ? pairing.joined : []).filter((h) => h && typeof h.name === 'string')
  hosted.forEach((h, i) => {
    const seen = finite(h.lastSeen)
    const state = h.connected ? 'connected' : seen ? 'last seen ' + fmtTime(now - seen) + ' ago' : 'not connected yet'
    row('paired-' + i, i ? '' : 'Paired', [P('◆ ' + h.name, { color: h.connected ? 'success' : undefined }), P(' · ' + state + (h.connected ? '' : ' · /editlens join off ' + h.name + ' removes it'), { dim: true })])
  })
  joinedTo.forEach((h, i) => {
    const up = h.state === 'connected'
    row('joined-' + i, i || hosted.length ? '' : 'Paired', [P('◆ ' + h.name, { color: up ? 'success' : 'warning' }), P(' · this computer joined it' + (up ? '' : ' · ' + (h.state === 'refused' ? 're-pair: /editlens pair there' : typeof h.error === 'string' && h.error ? h.error + ' Trying again.' : 'reconnecting')), { dim: true })])
  })
  if (pairing.waiting && typeof pairing.waiting === 'object') {
    const left = finite(pairing.waiting.minutesLeft)
    row('pair-open', 'Pairing', [P('! ', { color: 'warning' }), P('code open' + (left ? ' · ' + left + ' min left' : '')), P(' · /editlens pair off ends all pairings', { dim: true })])
  }
  const notices = (Array.isArray(s.taskNotices) ? s.taskNotices : []).filter((n) => n && typeof n.text === 'string').slice(0, 3)
  // The task's title (its prompt's first line), as on its card, not the whole prompt.
  notices.forEach((n, i) => row('task-notice-' + i, i ? '' : 'Tasks', [P(n.state === 'refused' ? '✕ ' : '! ', { color: n.state === 'refused' ? 'error' : 'warning' }), P(n.text), ...(firstLineOf(n.prompt, 60) ? [P(' · ' + firstLineOf(n.prompt, 60), { dim: true })] : [])]))
  if (s.connection) {
    const addr = s.connection.url ? shortAddress(s.connection.url) : ''
    const what = s.connection.kind === 'vite' ? 'Vite run by EditLens' : 'EditLens address'
    row('via', 'Through', [P(what), ...(addr ? [P(' · ' + (narrow ? addr.replace(/^localhost/, '') : addr), { dim: true })] : []), ...(narrow ? [] : [P(' · no files changed', { dim: true })])])
  }
  const files = integrationFiles(s)
  if (files.length) {
    const marked = (s.integrations || []).every((i) => i && i.marked)
    const where = [...new Set((s.integrations || []).filter((i) => i && typeof i.rel === 'string').map((i) => i.rel + (Number.isInteger(i.line) ? ':' + i.line : '')))]
    row('files', 'In files', [P('! ', { color: 'warning' }), P(where.join(', ')), P(marked ? ' · /editlens stop remove removes it' : ' · remove it when you are done', { dim: true })])
  }
  if (s.pageControlError) row('control', 'Control', [P('✕ ', { color: 'error' }), P('Page control stopped', { color: 'error' }), P(' · ' + s.pageControlError, { dim: true })])
  else if (!page && s.pageControl && s.pageControl.signedIn === false && s.pageControl.installed !== false) row('control', 'Control', [P('! ', { color: 'warning' }), P('Page control needs sign-in'), P(' · /editlens control', { dim: true })])
  const used = finite(t.context)
  const win = finite(t.window)
  const pct = finite(t.percent) ?? (used !== null && win ? Math.min(100, (used / win) * 100) : null)
  const model = typeof s.model === 'string' && s.model ? modelLabel(s.model) : ''
  const claude = [model, s.mode ? modeLabel(s.mode) : '', used === null && win ? fmtWindow(win) + ' context' : ''].filter(Boolean)
  if (claude.length) row('claude', 'Claude', [P(claude[0]), ...(claude.length > 1 ? [P(' · ' + claude.slice(1).join(' · '), { dim: true })] : [])])
  // Effort: the main agent's level, then this terminal's own when page control runs (read only).
  const effortNow = effortWord(s.effort)
  const here = page ? effortWord(s.effortHere) : ''
  // Change: page control's level (/editlens effort), or in Manual Claude Code's own /effort.
  if (effortNow) row('effort', 'Effort', [P(effortNow), ...(here ? [P(' · this terminal ' + here, { dim: true })] : []), ...(page || !s.effort || s.effort.source !== 'terminal' ? [] : [P(' · set in Claude Code', { dim: true })])],
    { button: page || !s.effort || s.effort.source !== 'terminal' ? { key: 'effort', label: 'Change', word: 'effort' } : { key: 'effort', label: 'Change', prompt: '/effort' } })
  if (used !== null && pct !== null) {
    const [full, empty] = meter(pct, narrow ? 6 : 10)
    const hot = pct >= 80
    row('context', 'Context', [P(full, { color: ctxColor(pct) }), P(empty, { dim: true }), P(' ' + fmtPct(pct), hot ? { color: 'error' } : {}), ...(win ? [P(' of ' + fmtWindow(win), { dim: true })] : []), ...(hot ? [P(' · /compact', { dim: true })] : [])])
  }
  const up = updateInfo(s)
  if (up) row('update', 'Update', [P('! ', { color: 'warning' }), P(up.text), P(' · ' + up.step, { dim: true })])
  const total = totalTokens(s)
  const sub = finite(t.subagents)
  const cost = finite(t.costUSD)
  if (total) row('tokens', 'Tokens', [P(fmtTokens(total)), ...(sub ? [P(' · subagents ' + fmtTokens(sub), { dim: true })] : []), ...(cost ? [P(' · $' + cost.toFixed(2), { dim: true })] : [])])
  // Agents: the list appears when Main is not alone (subagents or tasks); else Main is the head.
  const all = agentsModel(s, { now })
  const agents = all.length > 1 ? all : []
  if (agents.length) {
    const { running, total: count } = agentsCount(agents)
    rows.push({ key: 'agents', label: 'Agents', parts: running ? [P(running + ' running'), P(' · ' + count + ' total', { dim: true })] : [P(count + ' total')], gap: true })
  }
  const note = used === null && !total && !agents.length ? "Token use and agents show after Claude's first reply." : null
  const buttons = actionButtons(s).filter((a) => !a.open).map((a) => a.key === 'open' && !a.label.startsWith('Open on') ? { ...a, label: narrow ? 'Open' : 'Open page' } : a)
  if (up) buttons.push({ key: 'restart', label: 'Restart', word: 'restart' })
  buttons.push({ key: 'settings', label: 'Settings' })
  return { head, rows, note, agents, buttons }
}

// The pane's text, for where no pane can be shown: the same rows, 2-space indent, 12-column labels.
export function detailsText(s, opts) {
  const m = detailsModel(s, { cols: 80, ...(opts || {}) })
  const text = (parts) => parts.map((p) => p.text).join('')
  const lines = ['✦ EditLens  ' + text(m.head).trim(), '']
  for (const r of m.rows) {
    if (r.gap) lines.push('')
    lines.push('  ' + r.label.padEnd(LABEL_W) + text(r.parts) + (r.button ? '  ' + r.button.label : ''))
  }
  if (m.agents.length) lines.push('', ...m.agents.map((a) => agentLine(a, false)), '', '  /editlens agents  what each one is doing')
  if (m.note) lines.push('', '  ' + m.note)
  if (m.fix) lines.push('', '  ' + rec({ k: 'fix', ...m.fix }).plain[0])
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}
