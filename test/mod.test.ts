// The EditLens mod (hooks/mod.mjs): the line above the prompt, the Details and Settings panes,
// and /editlens, in the terminal and the desktop app, from a stubbed live server. Run with
// `claude plugin test`.
import { expect, mock, test } from 'claude-code/testing'
import { keyedWindowLinks, checkSetting, effectNotes, settingsLines, paneNote, actionButtons, detailsText, withLocal, errorRecords, noticeText, settingsText, samePages, settingSections, settingsStacked, withUsage, readRecords, plainOf, pairedOf, pairedRecords, fieldLabel, CONFLICT_LINE, RESTORE_NOTE, COPY_NOTE, IN_PROMPT, updateInfo, bandItems, detailsModel, recordsFromText, outputKey, pressLine, replyRecords, agentsText, sessionsModel, sessionsText, stopNameRecords, nextValue, rangeNote, notTypedStop, stopName, SESSIONS_HINT, editTime, focusedRow, focusMove, focusTarget, firstFocus } from '../hooks/mod.mjs'

const SUMMARY = {
  live: true, version: '0.14.0', sessionId: 's1', control: 'page', state: 'working', mode: 'acceptEdits', model: 'claude-opus-5-5',
  pages: [{ url: 'http://127.0.0.1:5173/', title: 'Demo' }], pageCount: 1,
  agents: [
    { key: 'toolu_1', agentId: 'a1', name: 'Build the About page', type: 'general-purpose', status: 'working', model: 'claude-haiku-5-5', tokens: 12400, tokensFinal: false, context: 12000, toolCalls: 3 },
    { key: 'toolu_2', agentId: 'a2', name: 'Check the header', type: 'Explore', status: 'done', model: null, tokens: 30500, tokensFinal: true, context: null, toolCalls: 7 },
  ],
  agentCount: 2, agentsRunning: 1,
  tokens: { context: 48000, window: 200000, percent: 24, main: 1200000, subagents: 42900, costUSD: null },
  permissions: 0,
  connection: null,
  integrations: [],
}

const BAND = {
  plugin: 'editlens', component: 'AbovePrompt', requestId: 'band', viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 118, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PANE = {
  plugin: 'editlens', component: 'Pane', requestId: 'editlens-details', viewport: { columns: 120, rows: 40 },
  props: { title: 'editlens', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const MANIFEST = JSON.stringify({
  name: 'editlens',
  userConfig: {
    start: { type: 'string', title: 'What /editlens does', description: 'd', options: ['Connect the page', 'Connect and turn on page control'], default: 'Connect the page' },
    safety_check: { type: 'boolean', title: 'Safety check', description: 'd', default: true },
    line_above_prompt: { type: 'boolean', title: 'Line above the prompt', description: 'd', default: true },
    theme: { type: 'string', title: 'Panel colors', description: 'd', options: ['Auto', 'Light', 'Dark'], default: 'Auto' },
    port: { type: 'number', title: 'Port', description: 'd', min: 1024, max: 65535, default: 4317 },
  },
})

const SETTINGS_PANE = { ...PANE, requestId: 'editlens-settings', props: { ...PANE.props, title: 'EditLens settings' } } as const

function stubs(on, answer, { open = true, stdout = 'Connected: open http://127.0.0.1:5174/', manifest = MANIFEST, fetch = null, configSet = null, run = null, files = {}, env = {}, gate = null } = {}) {
  const clock = mock.clock(on)
  const saved = new Map()
  const gets = [] // the $.store keys read
  on('store.get', ($, e) => {
    gets.push(e.key)
    return { value: saved.get(e.key) }
  })
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : env[e.name] }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  // Claude Code's own figures for this session: the window of a [1m] model, before any reply.
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('command.register', () => ({ value: undefined }))
  if (open) on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  // files: a test's own files, by path (written ones are read back).
  const written = new Map(Object.entries(files))
  // gate: a promise the settings list waits for (it is read slowly).
  on('fs.read', async ($, e) => (/plugin\.json$/.test(e.path) ? (await gate, { value: manifest }) : written.has(e.path) ? { value: written.get(e.path) } : /token-4317$/.test(e.path) ? { value: 'tok\n' } : { deny: 'ENOENT' }))
  const writes = []
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    written.set(e.path, e.text)
    return { value: undefined }
  })
  const sets = []
  on('config.set', ($, e) => {
    sets.push({ key: e.key, value: e.value })
    return configSet ? configSet(e) : { value: e.value }
  })
  const runs = []
  on('process.run', ($, e) => {
    runs.push(e)
    // A test's own answer (one that waits, to run two at the same time).
    if (run) return run(e)
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  const urls = []
  const posts = []
  on('http.fetch', ($, e) => {
    urls.push(e.url)
    // A test's own routes first (the /edits/* routes of /editlens undo).
    const own = fetch ? fetch(e) : null
    if (own) return own
    if (e.init && e.init.method === 'POST') {
      posts.push({ url: e.url, headers: e.init.headers, body: JSON.parse(e.init.body) })
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
    }
    return answer ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } } : { deny: 'connect ECONNREFUSED 127.0.0.1:4317' }
  })
  return { saved, gets, urls, sets, runs, posts, clock, writes }
}

test('the line above the prompt: status, link, agents and tokens, on both apps', async ($, on) => {
  const { urls, clock } = stubs(on, SUMMARY)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:4317\/summary\?session=s1&cwd=%2Fwork&mod=1&surfaces=[a-z,]*&drawn=$/)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    for (const text of ['Page control', ' · Accept edits', 'Working', '1 agent', '1.2M tokens', '━━', '────────', ' 24%']) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    // One row, never wrapped, no hover-tip row, and no wide glyphs.
    const row = await ui.find({ key: 'editlens-band' })
    expect(row.props.flexWrap).toBe('nowrap')
    expect(row.props.height).toBe(1)
    expect(await ui.find({ type: 'Text', text: /[⚡⚠▰▱◐↳]/ })).toBeUndefined()
    const link = await ui.find({ type: 'Link' })
    expect(link.props.href).toBe('http://localhost:5173/')
    expect(await ui.find({ key: 'details' })).toBeDefined()
    await ui.unmount()
  }
  // The server is told where the line was drawn (for /editlens details).
  await clock.advance(2100)
  expect(urls[urls.length - 1]).toMatch(/drawn=(terminal%2Cdesktop|desktop%2Cterminal)$/)
})

test('the Details pane lists every agent, and never NaN', async ($, on) => {
  const { sets } = stubs(on, SUMMARY)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Main works too: 2 of 3.
    expect(await ui.find({ type: 'Text', text: '2 running' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 3 total' })).toBeDefined()
    expect((await ui.find({ key: 'agent-main' })).props.label).toBe('Main')
    expect((await ui.find({ key: 'agent-toolu_1' })).props.label).toBe('Build the About page')
    expect((await ui.find({ key: 'agent-toolu_2' })).props.label).toBe('Check the header')
    expect(await ui.find({ type: 'Text', text: '1.2M' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · subagents 43k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' of 200k' })).toBeDefined()
    // One entry per page, in its localhost form.
    const page = await ui.find({ type: 'Link' })
    expect([page.props.href, page.props.label]).toEqual(['http://localhost:5173/', 'Demo · localhost:5173'])
    expect(await ui.find({ type: 'Text', text: /NaN|undefined|—/ })).toBeUndefined()
    // Refresh and the line switch are gone (the pane updates itself; the switch is in Settings).
    expect(await ui.find({ key: 'refresh' })).toBeUndefined()
    expect(await ui.find({ key: 'band' })).toBeUndefined()
    expect(await ui.find({ key: 'settings' })).toBeDefined()
    await ui.unmount()
  }
  // The line above the prompt is switched in the Settings pane.
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'desktop' })
  await ui.press({ key: 'set-line_above_prompt' })
  expect(sets).toEqual([{ key: 'editlens.line_above_prompt', value: false }])
})

// A main agent, two subagents, a task on a paired computer (mine) and one from it (theirs).
const AGENTS = {
  ...SUMMARY, mode: 'auto', effort: { level: 'xhigh', used: 'xhigh', supported: true },
  agents: [
    { key: 'toolu_2', agentId: 'a2', name: 'Check the header', type: 'Explore', status: 'done', startedAt: 1000, endedAt: 15000 },
    { key: 'toolu_1', agentId: 'a1', name: 'Build the About page', type: 'general-purpose', status: 'working', model: 'claude-haiku-5-5', startedAt: Date.now() - 60000, effort: { inherited: true } },
  ],
  tasks: [
    { key: 'r:vps-123456:aaaaaaaaaaaa', task: 'aaaaaaaaaaaa', where: 'there', computer: 'vps-123456', login: 'root@203.0.113.10', kind: 'mine', inCopy: true,
      prompt: 'Fix the header spacing\nand the footer', state: 'working', waiting: 0, editCount: 3, startedAt: Date.now() - 360000, model: 'claude-opus-5-5[1m]', mode: 'auto', effort: { level: 'high', used: 'high', supported: true } },
    { key: 't:bbbbbbbbbbbb', task: 'bbbbbbbbbbbb', where: 'here', computer: 'laptop', login: null, kind: 'shared', prompt: 'Update the README', state: 'idle', waiting: 0, editCount: 1, startedAt: Date.now() - 900000, model: null, mode: null, effort: null },
  ],
}

test('the Details pane\'s agents list: names without ids, the picked one\'s details under it, Follow and Stop', async ($, on) => {
  const { posts } = stubs(on, AGENTS)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'agent-r:vps-123456:aaaaaaaaaaaa' })).props.label).toBe('◆ vps-123456')
  expect(await ui.find({ type: 'Text', text: ' · Task' })).toBeDefined()
  expect((await ui.find({ key: 'agent-task:bbbbbbbbbbbb' })).props.label).toBe('Task from ◆ laptop')
  expect(await ui.find({ type: 'Text', text: 'Done · 14 s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '› ↑ ↓ picks an agent; its details open under it.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /aaaaaaaaaaaa|bbbbbbbbbbbb|toolu_|worktrees|NaN|undefined/ })).toBeUndefined()
  // At first the first working agent other than Main is picked: its rows, as on the page's card.
  for (const text of ['Computer', 'This computer', 'Agent', 'Subagent', ' · general-purpose', 'Edits go to', 'This project', 'Model', 'Haiku 5.5', 'Effort', 'Extra high', ' · same as Main', 'Started', ' · 1 min ago']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  expect((await ui.find({ key: 'follow-agent' })).props.label).toBe('Follow')
  expect((await ui.find({ key: 'stop-agent' })).props.label).toBe('Stop')
  // Stop on a running subagent: page control's stop.
  await ui.press({ key: 'stop-agent' })
  expect(posts.pop()).toMatchObject({ url: 'http://127.0.0.1:4317/agents/stop', body: { cwd: '/work', agent: 'a1' } })
  expect(await ui.find({ type: 'Text', text: 'Stopped Build the About page.' })).toBeDefined()
  // ↑ ↓ (or a press) picks the paired computer's task: its details, then Follow and Stop.
  await ui.press({ key: 'agent-r:vps-123456:aaaaaaaaaaaa' })
  expect(await ui.find({ type: 'Text', text: 'Stopped Build the About page.' })).toBeUndefined()
  for (const text of ['Doing', 'Fix the header spacing', 'vps-123456', ' · root@203.0.113.10', 'Task you started', 'A copy of this project', 'Opus 5.5', ' · 1M context', 'High', 'Auto', ' · 6 min ago · 3 edits']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: 'Haiku 5.5' })).toBeUndefined()
  await ui.press({ key: 'follow-agent' })
  expect(posts.pop()).toMatchObject({ url: 'http://127.0.0.1:4317/agents/follow', body: { cwd: '/work', key: 'r:vps-123456:aaaaaaaaaaaa' } })
  expect(await ui.find({ type: 'Text', text: 'Your page follows ◆ vps-123456 · Task now.' })).toBeDefined()
  await ui.press({ key: 'stop-agent' })
  expect(posts.pop()).toMatchObject({ url: 'http://127.0.0.1:4317/remote/task', body: { op: 'stop', computer: 'vps-123456', task: 'aaaaaaaaaaaa', localDir: '/work' } })
  // Done ones and Main have Follow only.
  await ui.press({ key: 'agent-toolu_2' })
  expect(await ui.find({ key: 'stop-agent' })).toBeUndefined()
  await ui.press({ key: 'agent-main' })
  expect(await ui.find({ type: 'Text', text: 'Your session' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · 200k context' })).toBeDefined()
  expect(await ui.find({ key: 'stop-agent' })).toBeUndefined()
  await ui.unmount()
})

test('a Follow the server refuses says why; Manual has no Stop for a subagent', async ($, on) => {
  const fetch = (e) => (e.init && e.init.method === 'POST' && /\/agents\/follow$/.test(e.url)
    ? { value: { status: 409, ok: false, headers: {}, text: JSON.stringify({ error: 'No page with the EditLens panel is open for this project. Open your page, then run this again.' }) } } : null)
  stubs(on, { ...AGENTS, control: 'manual' }, { fetch })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'stop-agent' })).toBeUndefined()
  await ui.press({ key: 'follow-agent' })
  expect(await ui.find({ type: 'Text', text: 'No page with the EditLens panel is open for this project. Open your page, then run this again.' })).toBeDefined()
  await ui.unmount()
})

test('/editlens agents prints the list and what each working agent is doing', async ($, on) => {
  const { runs } = stubs(on, AGENTS)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.command.run({ command: 'editlens', args: 'agents' })
  expect(runs.length).toBe(0)
  const text = agentsText(AGENTS)
  expect(out.text).toBe(text)
  const lines = text.split('\n')
  expect(lines[0]).toBe('✦ Agents  · 3 running · 5 total')
  expect(lines).toContain('  ● Check the header ·················· Done · 14 s')
  expect(lines).toContain('  ◐ ◆ vps-123456 · Task ··············· Working')
  expect(lines).toContain('      Doing        Fix the header spacing')
  expect(lines).toContain('      Computer     vps-123456 · root@203.0.113.10')
  expect(lines).toContain('      Started      ' + lines.find((l) => /^ {6}Started .* · 6 min ago · 3 edits$/.test(l)).slice(19))
  // A done agent's details are left out; no ids, no NaN.
  expect(text).not.toMatch(/Update the README|aaaaaaaaaaaa|toolu_|NaN|undefined|—/)
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(80)
  // As records: a head, then text rows, then the command row.
  const recs = recordsFromText(text)
  expect(recs[0]).toMatchObject({ k: 'head', title: 'Agents', note: '3 running · 5 total' })
  expect(recs[recs.length - 1]).toMatchObject({ k: 'cmd', cmd: '/editlens details' })
  // Off: says so, with the fix.
  expect(agentsText(null)).toContain('! Fix  Run /editlens to start it and connect your page')
  // Details as text lists them too, and points at /editlens agents.
  expect(detailsText(AGENTS)).toContain('  ◐ Build the About page ·············· Working')
  expect(detailsText(AGENTS)).toContain('  /editlens agents  what each one is doing')
})

test('settings: the pane shows them and changes them in Claude Code', async ($, on) => {
  const { sets, posts } = stubs(on, SUMMARY)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // The settings go to the live server once, with its key.
  const report = posts.find((p) => /\/settings\/report$/.test(p.url))
  expect(report.headers['x-editlens-token']).toBe('tok')
  expect(report.body).toEqual({ from: 'mod', values: { start: 'Connect and turn on page control', safety_check: true, line_above_prompt: true, theme: 'Auto', port: 4317 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...SETTINGS_PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Safety check' })).toBeDefined()
    expect((await ui.find({ key: 'set-safety_check' })).props.label).toBe('On')
    expect(await ui.find({ type: 'Text', text: 'Port' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4317' })).toBeDefined()
    // Only the selected row (the first) says what it does.
    expect(await ui.find({ type: 'Text', text: 'd' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'd Change it in /config.' })).toBeUndefined()
    expect(await ui.find({ key: 'set-port' })).toBeUndefined() // the port changes in /config only
    expect(await ui.find({ type: 'Text', text: /NaN|undefined/ })).toBeUndefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  await ui.press({ key: 'set-theme' })
  // Turning the safety check off takes a second press, after a warning.
  await ui.press({ key: 'set-safety_check' })
  expect(sets).toEqual([{ key: 'editlens.theme', value: 'Light' }])
  expect((await ui.find({ key: 'set-safety_check' })).props.label).toBe('Turn off?')
  expect(await ui.find({ type: 'Text', text: /^! Claude can then replace .* Press again to turn off\.$/ })).toBeDefined()
  await ui.press({ key: 'set-safety_check' })
  expect(sets).toEqual([{ key: 'editlens.theme', value: 'Light' }, { key: 'editlens.safety_check', value: false }])
})

test('settings asked for on the page are made in Claude Code once', async ($, on) => {
  // Only what the page may change: the safety check, the port and the rest are not changed.
  const { sets, clock } = stubs(on, { ...SUMMARY, settingsPending: [{ id: 1, key: 'theme', value: 'Dark' }, { id: 2, key: 'nope', value: 1 }, { id: 3, key: 'safety_check', value: false }, { id: 4, key: 'port', value: 4999 }] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(4100)
  expect(sets).toEqual([{ key: 'editlens.theme', value: 'Dark' }])
})

test('two quick presses on a button run /editlens once', async ($, on) => {
  const { runs } = stubs(on, { ...SUMMARY, control: 'manual' })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = runs.length
  await Promise.all([pane.press({ key: 'stop' }), pane.press({ key: 'stop' })])
  expect(runs.slice(before).filter((r) => /start\.js$/.test(r.argv[1])).length).toBe(1)
  await pane.unmount()
})

test('/editlens runs the one command with the settings, and /editlens settings opens them', async ($, on) => {
  const { runs } = stubs(on, SUMMARY, { open: false })
  const opened = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.command.run({ command: 'editlens', args: '' })
  expect(out.text).toBe('Connected: open http://127.0.0.1:5174/')
  expect(runs[0].argv[0]).toBe('node')
  expect(runs[0].argv[1]).toMatch(/bin\/start\.js$/)
  expect(runs[0].init.env.CLAUDE_PROJECT_DIR).toBe('/work')
  expect(runs[0].init.env.CLAUDE_PLUGIN_OPTION_THEME).toBe('Auto')
  await $.command.run({ command: 'editlens', args: 'stop remove' })
  expect(runs[1].argv.slice(2)).toEqual(['stop', 'remove'])
  await $.command.run({ command: 'editlens', args: 'settings' })
  expect(opened).toEqual(['editlens-settings'])
  expect(runs.length).toBe(2)
})

test('the skill\'s /editlens typed by the person runs here; from an SDK session it goes to the skill', async ($, on) => {
  const { runs } = stubs(on, SUMMARY)
  const passed = []
  on('command.run', { command: 'editlens:editlens' }, ($, e) => {
    passed.push(e.origin.kind)
    return { text: 'skill' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const typed = await $.command.run({ command: 'editlens:editlens', args: 'status', origin: { kind: 'composer' } })
  expect(typed.text).toBe('Connected: open http://127.0.0.1:5174/')
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['status'])
  const before = runs.length
  const sdk = await $.command.run({ command: 'editlens:editlens', args: 'join x y', origin: { kind: 'sdk' } })
  expect(sdk.text).toBe('skill')
  expect(passed).toEqual(['sdk'])
  expect(runs.length).toBe(before)
})

test('/editlens output is drawn in colour from its records; the text stays plain', async ($, on) => {
  const R = (r) => '\u001eEL' + JSON.stringify(r)
  const { runs } = stubs(on, SUMMARY, { stdout: [
      R({ k: 'head', status: 'ok', word: 'connected', plain: ['✦ EditLens  ✓ connected'] }),
      R({ k: 'blank', plain: [''] }),
      R({ k: 'field', label: 'Page', value: 'http://127.0.0.1:4678/', note: 'opened', link: true, plain: ['Page ······ http://127.0.0.1:4678/  opened'] }),
      R({ k: 'steps', heading: 'Sign in once', items: [{ n: 1, text: 'Click Sign in' }], end: { text: 'Not now?', cmd: '/editlens manual' }, plain: ['! Sign in once', '│  1  Click Sign in', '└  Not now? /editlens manual'] }),
    ].join('\n') })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.command.run({ command: 'editlens', args: '' })
  expect(out.text).toBe('✦ EditLens  ✓ connected\n\nPage ······ http://127.0.0.1:4678/  opened\n! Sign in once\n│  1  Click Sign in\n└  Not now? /editlens manual')
  expect(runs[runs.length - 1].init.env.EDITLENS_SAY).toBe('records')
  const row = { plugin: 'editlens', component: 'CommandOutput' as const, requestId: 'out1', props: { command: 'editlens', args: '', text: out.text, isErrored: false } }
  const ui = await $.ui.mount({ ...row, surface: 'terminal' })
  expect(await ui.find({ key: 'editlens-output' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓ connected' })).toBeDefined()
  expect((await ui.find({ type: 'Link' })).props.href).toBe('http://localhost:4678/')
  expect(await ui.find({ type: 'Text', text: '! Sign in once' })).toBeDefined()
  await ui.unmount()
  // Text it has no records for (a resumed session): read back from its lines, still drawn by EditLens.
  const other = await $.ui.mount({ ...row, requestId: 'out2', surface: 'terminal', props: { ...row.props, text: 'something else' } })
  expect(await other.find({ key: 'editlens-output' })).toBeDefined()
  expect(await other.find({ type: 'Text', text: 'something else' })).toBeDefined()
  // Another command's row is left to Claude Code.
  const foreign = await $.ui.mount({ ...row, requestId: 'out3', surface: 'terminal', props: { ...row.props, command: 'other', text: out.text } })
  expect(await foreign.find({ key: 'editlens-output' })).toBeUndefined()
})

// 0.24.32 bug (the VPS screenshot): Claude Code drew /editlens:editlens rows as plain "editlens: ✦
// EditLens ✓ ..." text, because its reload (on every setting change) emptied the remembered outputs.
// EditLens must draw these rows in colour for every command form, on both surfaces, after the run,
// after a reload, and for text this load never printed.
const ROW_FORMS = [
  { command: 'editlens', args: '' },
  { command: 'editlens:editlens', args: '' },
  { command: 'editlens:editlens', args: 'control' },
] as const

// Every Text in a drawn tree with its colour: [text, colour].
function coloured(el: any, out: [string, string][] = []): [string, string][] {
  if (!el || typeof el !== 'object') return out
  if (el.type === 'Text' && el.props && typeof el.props.color === 'string') out.push([(el.children || []).filter((c: any) => typeof c === 'string').join(''), el.props.color])
  for (const c of el.children || []) coloured(c, out)
  return out
}

async function expectColourRow($: any, surface: 'terminal' | 'desktop', form: { command: string, args: string }, text: string, id: string) {
  const ui = await $.ui.mount({ plugin: 'editlens', component: 'CommandOutput', requestId: id, surface, viewport: { columns: 100, rows: 40 }, props: { command: form.command, args: form.args, text, isErrored: false } })
  const tree = await ui.drawn()
  expect(await ui.find({ key: 'editlens-output' })).toBeDefined()
  const colours = coloured(tree)
  expect(colours.some(([t, c]) => t === '✦' && c === 'claude')).toBe(true)
  expect(colours.some(([t, c]) => /✓/.test(t) && c === 'success')).toBe(true)
  expect((await ui.find({ type: 'Link' })).props.href).toBe('http://localhost:4678/')
  // No "editlens:" from Claude Code's own row in what EditLens draws.
  expect(JSON.stringify(tree)).not.toMatch(/editlens: /)
  await ui.unmount()
}

const CONTROL_OUT = [
  { k: 'head', status: 'ok', word: 'page control on', plain: ['✦ EditLens  ✓ page control on'] },
  { k: 'blank', plain: [''] },
  { k: 'field', label: 'Page', value: 'http://127.0.0.1:4678/', note: 'opened', link: true, plain: ['Page ······· http://127.0.0.1:4678/  opened'] },
  { k: 'field', label: 'Control', value: '● Page control', note: 'continues this chat', plain: ['Control ···· ● Page control  continues this chat'] },
].map((r) => '\u001eEL' + JSON.stringify(r)).join('\n')

// What the first test saved in $.store, for the "after a reload" test: each test() loads the
// module again (as Claude Code's reload does), with nothing in its memory.
let savedOutputs: unknown = null

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/editlens, /editlens:editlens and /editlens:editlens control are drawn in colour on ${surface}`, async ($, on) => {
    const { saved } = stubs(on, SUMMARY, { stdout: CONTROL_OUT })
    await $.session.start({ surface, isInteractive: true, cwd: '/work' })
    for (const form of ROW_FORMS) {
      const out = await $.command.run({ command: form.command, args: form.args, origin: { kind: 'composer' } })
      expect(out.text.split('\n')[0]).toBe('✦ EditLens  ✓ page control on')
      // As the run left it, and as Claude Code keeps it ("editlens: " at the start, a stray \r).
      await expectColourRow($, surface, form, out.text, 'a' + form.args)
      await expectColourRow($, surface, form, 'editlens: ' + out.text.replace(/\n/g, '\r\n') + '\n', 'b' + form.args)
    }
    // The records are kept in $.store for the next load of this file.
    savedOutputs = saved.get('outputs')
    expect(Array.isArray(savedOutputs)).toBe(true)
  })

  test(`after a reload (a setting changed): the rows are still drawn in colour on ${surface}`, async ($, on) => {
    expect(savedOutputs).not.toBeNull()
    const { saved, gets } = stubs(on, SUMMARY)
    saved.set('outputs', savedOutputs)
    await $.session.start({ surface, isInteractive: true, cwd: '/work' })
    const text = plainOf(readRecords(CONTROL_OUT))
    // This load printed nothing: the records come from $.store.
    for (const form of ROW_FORMS) await expectColourRow($, surface, form, 'editlens: ' + text, 'c' + form.args)
    expect(gets).toContain('outputs')
  })

  test(`a row with no records anywhere (a resumed session) is read back from its text on ${surface}`, async ($, on) => {
    stubs(on, SUMMARY)
    await $.session.start({ surface, isInteractive: true, cwd: '/work' })
    const text = 'editlens: ' + plainOf(readRecords(CONTROL_OUT)).replace('page control on', 'page control on again')
    for (const form of ROW_FORMS) await expectColourRow($, surface, form, text, 'd' + form.args)
  })
}

test('text read back: head, label ···· value rows with their notes, errors with their fix', () => {
  const list = recordsFromText([
    '✦ EditLens  ✓ connected  · page control on', '',
    'Page ······· http://127.0.0.1:4678/  opened',
    '✕ Page control didn\'t start: Claude runs from another page',
    '! Fix  › /editlens control take to move it here',
  ].join('\n'))
  expect(list.map((r) => r.k)).toEqual(['head', 'blank', 'field', 'fail', 'fix'])
  expect(list[0]).toMatchObject({ title: 'EditLens', status: 'ok', word: 'connected', note: 'page control on' })
  expect(list[2]).toMatchObject({ label: 'Page', value: 'http://127.0.0.1:4678/', note: 'opened', link: true, width: 13 })
  expect(list[3]).toMatchObject({ what: 'Page control didn\'t start', detail: 'Claude runs from another page' })
  expect(list[4]).toMatchObject({ cmd: '/editlens control take', after: 'to move it here' })
  expect(outputKey('editlens: ✦ EditLens\r\n\nPage ··· x  \n\n')).toBe('✦ EditLens\n\nPage ··· x')
})

test('a button press logs one row in the ✦ design: done, or what went wrong and its fix', () => {
  expect(pressLine(recordsFromText('✦ EditLens  ✓ back to Manual  · the page chat stays'))).toBe('✦ ✓ back to Manual · the page chat stays')
  expect(pressLine(recordsFromText('✕ Page control didn\'t start: your page wasn\'t opened in time\n! Fix  open your page, then › /editlens control'))).toBe('✦ ✕ Page control didn\'t start · your page wasn\'t opened in time\n  ! Fix  open your page, then › /editlens control')
})

test('a reply keeps its records; a program\'s own lines (npm, stderr notes) never appear in it', () => {
  const logged = []
  const $ = { ui: { log: (t) => logged.push(t) } }
  const R = (r) => '\u001eEL' + JSON.stringify(r)
  const ok = replyRecords($, { exitCode: 0, stdout: 'added 103 packages in 4s\n' + R({ k: 'done', text: 'Page control is set up', plain: ['✓ Page control is set up'] }), stderr: '(could not open a browser here)\n' })
  expect(plainOf(ok)).toBe('✓ Page control is set up')
  expect(logged.length).toBe(2)
  const crash = replyRecords($, { exitCode: 1, stdout: '', stderr: 'TypeError: x is not a function\n    at main (bin/start.js:1:1)\n' })
  expect(plainOf(crash)).toBe('✕ /editlens stopped with an error: x is not a function\n! Fix  Run /editlens details to see whether EditLens is running, then try again')
})

test('when the live server is off, it is started; if it still is not there, the line says what to run', async ($, on) => {
  const { runs } = stubs(on, null)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(runs.some((r) => /bin\/serve\.js$/.test(r.argv[r.argv.length - 1]))).toBe(true)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Not running' })).toBeDefined()
  expect(await ui.find({ key: 'start' })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'Not running' })).toBeDefined()
  expect(await pane.find({ key: 'start' })).toBeDefined()
})

test('Manual when page control is not set up; the how-to is in Details', async ($, on) => {
  stubs(on, { ...SUMMARY, control: 'manual', state: 'idle', mode: 'default', pageControl: { installed: false, signedIn: null } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Manual' })).toBeDefined()
  expect(await ui.find({ key: 'control' })).toBeDefined()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'Manual' })).toBeDefined()
  expect(await pane.find({ key: 'control' })).toBeDefined()
  // Manual: this session's own window from Claude Code (a [1m] model), not the server's 200k.
  expect(await pane.find({ type: 'Text', text: ' · Ask' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: ' of 1M' })).toBeDefined()
})

test('one line on the first start ever, nothing after', async ($, on) => {
  stubs(on, SUMMARY)
  const logs = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(logs.filter((t) => /^✦ EditLens  › \/editlens to connect your page/.test(t)).length).toBe(1)
  expect(logs.some((t) => /quick commands/.test(t))).toBe(false)
})

test('a reminder when EditLens is in the project files', async ($, on) => {
  stubs(on, { ...SUMMARY, integrations: [{ rel: 'vite.config.js', line: 3, marked: false }, { rel: 'vite.config.js', line: 5, marked: false }], connection: { kind: 'vite', url: 'http://127.0.0.1:5174/' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'in vite.config.js' })).toBeDefined()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'vite.config.js:3, vite.config.js:5' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: ' · remove it when you are done' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Vite run by EditLens' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: ' · localhost:5174' })).toBeDefined()
})

test('desktop tool chips: hovering the row shows what it ran; the terminal row is not changed', async ($, on) => {
  stubs(on, SUMMARY)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const row = { plugin: 'editlens', component: 'ToolUse' as const, requestId: 'toolu_1' }
  const props = { tool_use_id: 'toolu_1', tool: 'PowerShell', input: { command: 'npm run dev' }, isRunning: false, isErrored: false, isInterrupted: false }
  const ui = await $.ui.mount({ ...row, surface: 'desktop', props })
  const card = await ui.find({ type: 'Code' })
  expect(card.props.source).toBe('npm run dev')
  expect(card.props.language).toBe('powershell')
  expect(await ui.find({ type: 'Text', text: 'Command' })).toBeDefined()
  expect(await ui.find({ key: 'editlens-tool-toolu_1' })).toBeDefined()
  await ui.unmount()
  const nav = await $.ui.mount({ ...row, surface: 'desktop', props: { ...props, tool: 'navigate', input: { url: 'http://127.0.0.1:5173/' } } })
  expect((await nav.find({ type: 'Code' })).props.source).toBe('http://127.0.0.1:5173/')
  await nav.unmount()
  const term = await $.ui.mount({ ...row, surface: 'terminal', props })
  expect(await term.find({ type: 'Code' })).toBeUndefined()
  await term.unmount()
})

test('plain buttons run /editlens: Page control, Manual, ⋯ opens Details (with Disconnect)', async ($, on) => {
  const { runs } = stubs(on, { ...SUMMARY, control: 'manual' })
  const logs: string[] = []
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'control' })).toBeDefined()
  expect(await ui.find({ key: 'manual' })).toBeUndefined()
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect(await ui.find({ key: 'connect' })).toBeUndefined()
  await ui.press({ key: 'control' })
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['control'])
  await ui.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ key: 'control' })).toBeDefined()
  await pane.press({ key: 'stop' })
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['stop'])
  expect(await pane.find({ key: 'settings' })).toBeDefined()
  await pane.unmount()
})

test('button choices follow the session', () => {
  const keys = (s: object) => actionButtons(s).map((a) => a.key)
  expect(keys({ control: 'page', pages: [{ url: 'http://localhost:5173/' }] })).toEqual(['open', 'manual', 'stop'])
  expect(keys({ control: 'manual', pages: [] })).toEqual(['connect', 'control'])
  expect(actionButtons(null)).toEqual([])
  // A server EditLens couldn't prove is this project's: one click connects it.
  const hinted = actionButtons({ control: 'manual', pages: [], connectHint: 'http://localhost:3000' })
  expect(hinted[0]).toEqual({ key: 'connect', label: 'Connect localhost:3000', word: 'http://localhost:3000' })
  expect(actionButtons({ control: 'manual', pages: [], connectHint: 'http://evil.example:80' })[0].label).toBe('Connect page')
  expect(actionButtons({ control: 'manual', pages: [], connectHint: 'http://localhost:3000 stop' })[0].word).toBe('')
})

test('D21: the Open button has the page key after # only when the server gives one (macOS, Windows)', () => {
  const key = 'a1'.repeat(16)
  const open = (s: object) => actionButtons(s).find((a) => a.key === 'open')
  expect(open({ control: 'manual', pages: [{ url: 'http://localhost:5173/' }] }).href).toBe('http://localhost:5173/')
  expect(open({ control: 'manual', pages: [{ url: 'http://localhost:5173/' }], pageKey: key }).href).toBe('http://localhost:5173/#editlens-key=' + key)
  expect(open({ control: 'manual', pages: [{ url: 'http://localhost:5173/' }], pageKey: 'not-a-key' }).href).toBe('http://localhost:5173/')
  expect(open({ control: 'manual', pages: [{ url: 'https://example.com/' }], pageKey: key }).href).toBe('https://example.com/')
})

test('D21: a notice\'s link to this computer\'s EditLens window gets the page key; a paired one does not', () => {
  const key = 'b2'.repeat(16)
  const text = 'allow it in the EditLens window, http://localhost:4317/answer'
  expect(keyedWindowLinks(text, key, 4317)).toBe(`allow it in the EditLens window, http://localhost:4317/gk-${key}/answer`)
  expect(keyedWindowLinks(text, null, 4317)).toBe(text)
  expect(keyedWindowLinks('its window: http://127.0.0.1:5999/answer', key, 4317)).toBe('its window: http://127.0.0.1:5999/answer')
})

test('Details as text: only rows with a value, one entry per page, the chosen model\'s window', () => {
  const s = withLocal({ control: 'manual', state: 'idle', pages: [{ url: 'http://127.0.0.1:51051/', title: 'My Project' }, { url: 'http://localhost:51051/' }],
    connection: { kind: 'proxy', url: 'http://127.0.0.1:4678/' }, tokens: { context: null, window: 200000, percent: null, main: 0, subagents: 0, costUSD: null }, agents: [] },
  { model: 'claude-opus-5-5[1m]', window: 1000000, used: null, percent: null, usd: null })
  expect(detailsText(s)).toBe([
    '✦ EditLens  ○ Manual · Idle', '',
    '  Page        My Project · localhost:51051',
    '  Through     EditLens address · localhost:4678 · no files changed',
    '  Claude      Opus 5.5 · 1M context', '',
    "  Token use and agents show after Claude's first reply.",
  ].join('\n'))
  expect(detailsText(s)).not.toMatch(/—|NaN|undefined|200k/)
  expect(samePages([{ url: 'http://[::1]:3000/a' }, { url: 'http://localhost:3000/a', title: 'A' }])).toEqual([{ url: 'http://localhost:3000/a', title: 'A' }])
  expect(detailsText(null, { booting: 'port 4317 in use' })).toContain('! Fix  Run /editlens settings, change Port, then restart Claude Code')
})

test('an older EditLens still running than the one installed: the line and Details say so, with one step', () => {
  // A 0.24.14 server says nothing about it: this plugin's own version is compared.
  const old = { ...SUMMARY, version: '0.24.14', control: 'manual', pluginVersion: '0.24.33' }
  expect(updateInfo(old)).toEqual({ installed: '0.24.33', running: '0.24.14', busy: null, text: 'EditLens 0.24.33 is installed, but an older one (0.24.14) is still running', step: '/editlens restart uses it' })
  expect(detailsText(old)).toContain('  Update      ! EditLens 0.24.33 is installed, but an older one (0.24.14) is still running · /editlens restart uses it')
  expect(detailsModel(old).buttons.map((b) => b.key)).toContain('restart')
  const band = bandItems({ s: old, cols: 160 }).find((i) => i.id === 'update')
  expect(band.parts.map((p) => p.text).join('')).toBe('! 0.24.33 installed, 0.24.14 running')
  // Page control runs there: the update waits, and page control is turned on again.
  expect(updateInfo({ ...old, control: 'page' }).step).toBe('it updates when page control stops, and starts again; /editlens restart updates now')
  // A newer server reports what it waits for, and a newer version a hook told it.
  const t = updateInfo({ ...SUMMARY, version: '0.24.33', installed: '0.24.40', updateBusy: 'tasks' })
  expect([t.installed, t.busy, t.step]).toEqual(['0.24.40', 'tasks', 'it updates when the tasks finish; /editlens restart updates now (the tasks stop)'])
  // Same, newer or unreadable: nothing.
  for (const v of ['0.24.33', '0.25.0', 'x.y.z', undefined]) expect(updateInfo({ ...SUMMARY, version: '0.24.33', pluginVersion: v === '0.25.0' ? '0.24.33' : v })).toBeNull()
  expect(updateInfo({ ...SUMMARY, version: '0.25.0', pluginVersion: '0.24.33' })).toBeNull()
  expect(bandItems({ s: SUMMARY, cols: 160 }).some((i) => i.id === 'update')).toBe(false)
})

test('errors and notices in plain words, with a fix and no "EditLens:" prefix', () => {
  expect(errorRecords(new Error('spawn node ENOENT')).flatMap((r) => r.plain)).toEqual(["✕ EditLens can't run: Node isn't found", '! Fix  Install Node 18 or newer, then restart Claude Code'])
  expect(errorRecords(new Error('process timed out after 120000 ms'))[0].plain).toEqual(['✕ /editlens took too long and stopped'])
  expect(noticeText('Paired with ◆ laptop-1 · it can watch')).toBe('✦ ✓ Paired with ◆ laptop-1 · it can watch')
  expect(noticeText('◆ laptop-1 unpaired from this computer')).toBe('✦ ◆ laptop-1 unpaired from this computer')
  const sch = JSON.parse(MANIFEST).userConfig
  expect(settingsText(sch, { start: 'Connect and turn on page control', safety_check: true, line_above_prompt: false, theme: 'Dark', port: 4317 })).toBe([
    '✦ EditLens settings · change them in /config (search "editlens")', '',
    'Page control ·· Connect and page control',
    'On the page ··· colors Dark',
    'Safety ········ safety check on',
    'Claude Code ··· line above prompt off · port 4317',
  ].join('\n'))
})

// Every element of a drawn tree, depth first, so a test can read a row's columns.
function elements(node: unknown, out: Array<{ type: string, props: Record<string, any>, children: unknown[] }> = []) {
  if (!node || typeof node !== 'object') return out
  const raw = node as { type: string, props?: Record<string, any>, children?: unknown[] }
  const el = { ...raw, props: raw.props || {}, children: raw.children || [] }
  out.push(el)
  for (const c of [...(Array.isArray(el.children) ? el.children : []), ...(Array.isArray(el.props && el.props.children) ? el.props.children : [])]) elements(c, out)
  return out
}
const textOf = (el) => elements(el).filter((x) => x.type === 'Text').flatMap((x) => (x.children || []).filter((c) => typeof c === 'string')).join('') +
  elements(el).filter((x) => x.type === 'Button').map((x) => x.props.label).join('')

const FULL = JSON.stringify({
  name: 'editlens',
  userConfig: {
    start: { type: 'string', title: 'What /editlens does', description: 'What /editlens does. More.', options: ['Connect the page', 'Connect and turn on page control'], default: 'Connect and turn on page control' },
    permission_mode: { type: 'string', title: 'Page control: permission mode', description: 'How Claude asks before acting when it runs from the page.', options: ['Ask', 'Accept edits', 'Plan', 'Auto', "Don't ask"], default: 'Auto' },
    wait: { type: 'boolean', title: 'Wait for page messages', description: 'd', default: false },
    highlight: { type: 'boolean', title: 'Highlight changes on the page', description: 'd', default: true },
    permission_glow: { type: 'boolean', title: 'Highlight when Claude waits for you', description: 'd', default: true },
    editor: { type: 'string', title: 'Editor', description: 'The code editor.', options: ['VS Code', 'Cursor', 'None'], default: 'VS Code' },
    task_account: { type: 'string', title: "Run paired computers' tasks as", description: 'd', options: ['Auto', 'Root (unsafe)'], default: 'Auto' },
    safety_check: { type: 'boolean', title: 'Safety check', description: 'd', default: true },
    port: { type: 'number', title: 'Port', description: 'd', min: 1024, max: 65535, default: 4317 },
  },
})

test('settings layout B: short labels, a dotted line to one 12-cell value column, group heads, one description', async ($, on) => {
  stubs(on, SUMMARY, { manifest: FULL })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...SETTINGS_PANE, surface, props: { ...SETTINGS_PANE.props, bodyColumns: 58 } })
    for (const head of ['Page control', 'On the page', 'Safety', 'Other computers', 'Claude Code']) expect(elements(await ui.find({ key: 'sec-' + head })).find((x) => x.type === 'Text').props.color).toBe('subtle')
    for (const label of ['/editlens turns on', 'Permission mode', 'Highlight when waiting', 'Editor', 'Run their tasks as']) expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    // One row: gutter, label, a dotted line, a value column 12 cells wide; the value is the button.
    const row = elements(await ui.find({ key: 'row-highlight' }))
    expect(row.find((x) => x.props.key === 'dots').props).toMatchObject({ flexGrow: 1, flexShrink: 1, overflow: 'hidden' })
    expect(row.find((x) => x.props.key === 'value').props).toMatchObject({ width: 12, flexShrink: 0 })
    expect(textOf(row.find((x) => x.props.key === 'value'))).toBe('● On')
    expect(textOf(elements(await ui.find({ key: 'row-wait' })).find((x) => x.props.key === 'value'))).toBe('○ Off')
    expect(textOf(elements(await ui.find({ key: 'row-start' })).find((x) => x.props.key === 'value'))).toBe('Page control')
    expect((await ui.find({ key: 'set-editor' })).props.label).toBe('VS Code')
    // The first row is selected: › and its description; no other row has one (Port says where it
    // is changed, as it can't be selected).
    expect(textOf(await ui.find({ key: 'row-start' }))).toMatch(/^›\/editlens turns on ·+ /)
    expect([...new Set((await ui.findAll({ key: 'below' })).map((b) => b.text))]).toEqual(['What /editlens does.', 'Change it in /config.'])
    expect((await ui.find({ key: 'below' })).text).toBe('What /editlens does.')
    expect(textOf(await ui.find({ key: 'row-start' }))).toContain('What /editlens does.')
    expect(await ui.find({ type: 'Text', text: 'Tab move · Enter change · Esc close' })).toBeDefined()
    await ui.unmount()
  }
  // Narrow: decided once for the pane; every value is on its own line, none beside its label.
  const longest = Math.max(...settingSections(JSON.parse(FULL).userConfig).flatMap((s) => s.rows.map((r) => r.label.length)))
  expect(longest).toBeLessThanOrEqual(22)
  expect(settingsStacked(2 + longest + 2 + 12 + 3, settingSections(JSON.parse(FULL).userConfig))).toBe(false)
  expect(settingsStacked(2 + longest + 2 + 12 + 2, settingSections(JSON.parse(FULL).userConfig))).toBe(true)
  const narrow = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal', props: { ...SETTINGS_PANE.props, bodyColumns: 38 } })
  for (const k of ['start', 'wait', 'highlight', 'editor', 'port']) {
    const els = elements(await narrow.find({ key: 'row-' + k }))
    expect(els.find((x) => x.props.key === 'val').props.paddingLeft).toBe(4)
    expect(els.find((x) => x.props.key === 'name')).toBeDefined()
  }
  await narrow.unmount()
})

test('Details, help, join and usage share the column helper: label 12, command 22, value 13, field 12 with dots, label 10', async ($, on) => {
  const R = (r) => '\u001eEL' + JSON.stringify(r)
  stubs(on, SUMMARY, { stdout: [
    R({ k: 'head', title: 'Paired computers', plain: ['✦ Paired computers'] }),
    R({ k: 'row', label: '◆ laptop-1', value: '● Connected', tone: 'ok', width: 10, plain: ['◆ laptop-1 ·· ● Connected'] }),
    R({ k: 'cmd', cmd: '/editlens control', what: 'run Claude from the page', plain: ['  /editlens control     run Claude from the page'] }),
    R({ k: 'field', label: 'Page', value: 'http://127.0.0.1:4678/', link: true, plain: ['Page ······ http://127.0.0.1:4678/'] }),
  ].join('\n') })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const page = elements(await pane.find({ key: 'row-page-0' }))
  expect(page.find((x) => x.props.key === 'label').props).toMatchObject({ width: 12, flexShrink: 0 })
  expect(page.find((x) => x.props.key === 'value').props).toMatchObject({ flexGrow: 1, flexShrink: 1 })
  expect(page.some((x) => x.props.key === 'dots')).toBe(false)
  await pane.unmount()
  const out = await $.command.run({ command: 'editlens', args: 'join' })
  const ui = await $.ui.mount({ plugin: 'editlens', component: 'CommandOutput', requestId: 'o', surface: 'desktop', props: { command: 'editlens', args: 'join', text: out.text, isErrored: false } })
  const drawn = elements(await ui.drawn())
  const values = drawn.filter((x) => x.props.key === 'value' && x.props.width)
  expect(values.map((x) => x.props.width)).toEqual([13])
  expect(drawn.some((x) => x.props.key === 'dots')).toBe(true)
  const labels = drawn.filter((x) => x.props.key === 'label' && x.props.width).map((x) => x.props.width)
  expect(labels).toEqual([22, 12])
  await ui.unmount()
})

test('/editlens usage: this session\'s context and plan limits in 10-cell label rows', () => {
  const list = readRecords(['\u001eEL' + JSON.stringify({ k: 'head', title: 'Usage', note: '', plain: ['✦ Usage'] }), '\u001eEL' + JSON.stringify({ k: 'blank', plain: [''] }),
    '\u001eEL' + JSON.stringify({ k: 'meter', label: 'Context', percent: 5, plain: ['Context   old'] }), '\u001eEL' + JSON.stringify({ k: 'steps', heading: 'Plan limits in the panel', items: [], plain: ['! Plan limits in the panel'] })].join('\n'))
  const now = new Date(2026, 9, 9, 12, 0).getTime()
  const got = { model: 'claude-opus-5-5[1m]', usage: { startedAt: 0, context: { tokens: 410000, window: 1000000, percent: 41 }, rateLimits: [
    { kind: 'five_hour', percentUsed: 32, resetsAt: new Date(2026, 9, 9, 18, 0).toISOString() }, { kind: 'seven_day', percentUsed: NaN }] } }
  expect(plainOf(withUsage(list, got, now))).toBe([
    '✦ Usage  · Opus 5.5 · 1M context', '',
    'Context   ━━━━━━━─────────   41%   410k of 1M',
    'Session   ━━━━━───────────   32%   resets 18:00',
    'Plan limits are for your whole account.', '',
    '! Plan limits in the panel',
  ].join('\n'))
  expect(withUsage(list, null, now)).toBe(list)
})

test('a plain /editlens typed at the prompt may open the page; a button or another plugin may not', async ($, on) => {
  const { runs } = stubs(on, SUMMARY)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'editlens', args: '', origin: { kind: 'composer' } })
  expect(runs[runs.length - 1].init.env.EDITLENS_TYPED).toBe('1')
  await $.command.run({ command: 'editlens', args: '', origin: { kind: 'bridge' } })
  expect(runs[runs.length - 1].init.env.EDITLENS_TYPED).toBe('0')
  await $.command.run({ command: 'editlens', args: '' })
  expect(runs[runs.length - 1].init.env.EDITLENS_TYPED).toBe('0')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'manual' })
  expect(runs[runs.length - 1].init.env.EDITLENS_TYPED).toBe('0')
})

// ---------- /editlens undo (handoff 10.2) ----------
const UNDO_PANE = { ...PANE, requestId: 'editlens-undo', props: { ...PANE.props, title: 'Recent edits' } } as const
const AT = new Date(2026, 9, 9, 14, 52).getTime()
const EDITS = { edits: [
  { n: 12, seq: 40, file: 'src/App.jsx', reason: 'Add the header', time: AT, canUndo: true, canRestore: true, kind: 'frontend', added: 3, removed: 1, created: false, agentId: null },
  { n: 3, seq: 9, file: 'src/a.js', reason: 'Fix the total', time: AT, canUndo: true, canRestore: true, kind: 'other', agentId: 'a2', agentType: 'Explore' },
], instance: '0123456789abcdef' }
const MESSAGE = 'Undo only edit 12 in src/App.jsx (lines 4–9, Add the header). Keep the later changes.'

// The /edits routes as worker A's server gives them; `post` answers each POST.
function editsRoutes(post) {
  const calls = []
  const fetch = (e) => {
    if (!/\/edits\//.test(e.url)) return null
    const init = e.init || {}
    calls.push({ url: e.url, method: init.method || 'GET', key: init.headers && init.headers['x-editlens-token'], body: init.body ? JSON.parse(init.body) : null })
    const [status, body] = /\/edits\/recent\?/.test(e.url) ? [200, EDITS] : post(JSON.parse(init.body), e.url)
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } }
  }
  return { calls, fetch }
}

function promptStubs(on, filled = true) {
  const fills = []
  const submits = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return filled ? { isFilled: true, text: e.text, cursor: e.text.length } : { isFilled: false, text: '', cursor: 0 }
  })
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    return {}
  })
  return { fills, submits }
}

test('/editlens undo opens "Recent edits · this session": N, file and folder, dots, counts; who, time and reason under it; the selected row has the three choices', async ($, on) => {
  const { calls, fetch } = editsRoutes(() => [200, { ok: true, text: 'Undid only edit 12 in src/App.jsx. Later changes kept.' }])
  const opened = []
  stubs(on, SUMMARY, { open: false, fetch })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const closed = []
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.command.run({ command: 'editlens', args: 'undo', origin: { kind: 'composer' } })
  expect(out.text).toBeUndefined()
  expect(opened).toEqual(['editlens-undo'])
  expect(calls[0]).toEqual({ url: 'http://127.0.0.1:4317/edits/recent?session=s1&cwd=%2Fwork', method: 'GET', key: 'tok', body: null })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...UNDO_PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Recent edits' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · this session' })).toBeDefined()
    expect((await ui.find({ key: 'edit-12' })).props.label).toBe('12')
    expect((await ui.find({ key: 'edit-3' })).props.label).toBe('3')
    // The page's Changes row (handoff 14): the name, its folder, the counts; under it who, when, why.
    expect(await ui.find({ type: 'Text', text: 'App.jsx' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  src/' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+3 −1' })).toBeDefined()
    expect(await ui.find({ key: 'dots' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Main · (\w{3} )?14:52 · Add the header$|^Main · Oct 9 · Add the header$/ })).toBeDefined()
    // A subagent's edit is named as on the page; counts it didn't come with are not "0 lines".
    expect(await ui.find({ type: 'Text', text: /^Check the header · .+ · lines not known yet · Fix the total$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0 lines/ })).toBeUndefined()
    // Only the selected (newest) row has the buttons and the Restore note.
    expect((await ui.find({ key: 'undo' })).props.label).toBe('Undo only this edit')
    expect((await ui.find({ key: 'restore' })).props.label).toBe('Restore file')
    expect((await ui.find({ key: 'cancel' })).props.label).toBe('Cancel')
    expect(await ui.find({ type: 'Text', text: RESTORE_NOTE })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /NaN|undefined/ })).toBeUndefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...UNDO_PANE, surface: 'terminal' })
  // Undo only this edit: posted with the hook key, the edit's seq and the server's instance (Sol H8),
  // the result line, and Put it back.
  await ui.press({ key: 'undo' })
  const post = calls.find((c) => c.method === 'POST')
  expect(post).toEqual({ url: 'http://127.0.0.1:4317/edits/undo', method: 'POST', key: 'tok', body: { n: 12, seq: 40, instance: '0123456789abcdef', session: 's1', cwd: '/work' } })
  expect(await ui.find({ type: 'Text', text: 'Undid only edit 12 in src/App.jsx. Later changes kept.' })).toBeDefined()
  await ui.press({ key: 'put-back' })
  expect(calls[calls.length - 2].body).toEqual({ n: 12, seq: 40, instance: '0123456789abcdef', back: true, session: 's1', cwd: '/work' })
  expect(await ui.find({ key: 'put-back' })).toBeUndefined()
  // Another row: pressing its number selects it; Restore file posts to /edits/restore.
  await ui.press({ key: 'edit-3' })
  await ui.press({ key: 'restore' })
  expect(calls.filter((c) => c.method === 'POST').pop()).toEqual({ url: 'http://127.0.0.1:4317/edits/restore', method: 'POST', key: 'tok', body: { n: 3, seq: 9, instance: '0123456789abcdef', session: 's1', cwd: '/work' } })
  await ui.press({ key: 'cancel' })
  expect(closed).toEqual(['editlens-undo'])
})

test('/editlens undo: a conflict puts Claude\'s message in the prompt and never sends it; when it can\'t, the message is shown to copy', async ($, on) => {
  const { fetch } = editsRoutes(() => [409, { ok: false, conflict: true, lines: [4, 9], message: MESSAGE }])
  stubs(on, SUMMARY, { fetch })
  const { fills, submits } = promptStubs(on, true)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'editlens', args: 'undo', origin: { kind: 'composer' } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...UNDO_PANE, surface })
    await ui.press({ key: 'undo' })
    expect(await ui.find({ type: 'Text', text: CONFLICT_LINE })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: IN_PROMPT })).toBeDefined()
    expect(await ui.find({ key: 'copy' })).toBeUndefined()
    await ui.unmount()
  }
  expect(fills).toEqual([{ text: MESSAGE, mode: 'replace' }, { text: MESSAGE, mode: 'replace' }])
  expect(submits).toEqual([])
})

test('/editlens undo: when the prompt can\'t take the message, it is shown with "Copy this into your prompt"', async ($, on) => {
  const { fetch } = editsRoutes(() => [409, { ok: false, conflict: true, lines: [4, 9], message: MESSAGE }])
  stubs(on, SUMMARY, { fetch })
  const { submits } = promptStubs(on, false)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'editlens', args: 'undo', origin: { kind: 'composer' } })
  const ui = await $.ui.mount({ ...UNDO_PANE, surface: 'terminal' })
  await ui.press({ key: 'undo' })
  expect(await ui.find({ type: 'Text', text: CONFLICT_LINE })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: COPY_NOTE })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: MESSAGE })).toBeDefined()
  expect((await ui.find({ key: 'copy' })).props.label).toBe('Copy')
  expect(await ui.find({ type: 'Text', text: IN_PROMPT })).toBeUndefined()
  expect(submits).toEqual([])
})

test('/editlens undo: server down or a refused key is said plainly in the pane', async ($, on) => {
  stubs(on, SUMMARY, { fetch: (e) => (/\/edits\//.test(e.url) ? { value: { status: 401, ok: false, headers: {}, text: 'bad token' } } : null) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'editlens', args: 'undo' })
  let ui = await $.ui.mount({ ...UNDO_PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: "EditLens couldn't list the edits (error 401)" })).toBeDefined()
  await ui.unmount()
})

test('/editlens undo N typed at the prompt: a conflict fills the prompt; from a button or Remote Control it stays to copy', async ($, on) => {
  const records = [
    { k: 'steps', heading: CONFLICT_LINE, items: [], plain: ['! ' + CONFLICT_LINE] },
    { k: 'text', text: COPY_NOTE, copyNote: true, plain: [COPY_NOTE] },
    { k: 'code', text: MESSAGE, prompt: MESSAGE, plain: ['', '    ' + MESSAGE, ''] },
  ]
  const { runs } = stubs(on, SUMMARY, { stdout: records.map((r) => '\u001eEL' + JSON.stringify(r)).join('\n') })
  const { fills, submits } = promptStubs(on, true)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const typed = await $.command.run({ command: 'editlens', args: 'undo 12', origin: { kind: 'composer' } })
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['undo', '12'])
  expect(runs[runs.length - 1].init.env.EDITLENS_SESSION_ID).toBe('s1')
  expect(fills).toEqual([{ text: MESSAGE, mode: 'replace' }])
  expect(typed.text).toBe('! ' + CONFLICT_LINE + '\n' + IN_PROMPT)
  const remote = await $.command.run({ command: 'editlens', args: 'undo 12', origin: { kind: 'bridge' } })
  expect(fills.length).toBe(1)
  expect(remote.text).toContain(COPY_NOTE)
  expect(remote.text).toContain(MESSAGE)
  expect(submits).toEqual([])
})

// GET /summary held by the server until something changes (0.24.32): one request at a time, the
// 2 s poll for an older server, and a wait that grows when the server is not there.
const ok = (body) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
const summaryCalls = (urls) => urls.filter((u) => /\/summary\?/.test(u))

test('the server keeps the request open: the line changes when its answer comes, and only one request is on its way', async ($, on) => {
  let n = 0
  const { urls, clock } = stubs(on, null, { fetch: (e) => {
    if (!/\/summary\?/.test(e.url)) return null
    const at = ++n
    if (at === 1) return ok({ ...SUMMARY, seq: 7, changed: true })
    // Held: the change comes 5 s later.
    return clock.sleep(5000).then(() => ok({ ...SUMMARY, state: at === 2 ? 'idle' : 'working', seq: 7 + at, changed: true }))
  } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
  expect(summaryCalls(urls)[0]).not.toMatch(/since=/)
  await clock.advance(2100)
  expect(summaryCalls(urls).length).toBe(2)
  expect(summaryCalls(urls)[1]).toMatch(/&since=7&wait=25$/)
  // Ticks while it is held make no new request.
  await clock.advance(4000)
  expect(summaryCalls(urls).length).toBe(2)
  // The answer is drawn immediately, and the next request asks from its number.
  await clock.advance(1100)
  expect(await ui.find({ type: 'Text', text: 'Idle' })).toBeDefined()
  await clock.advance(2000)
  expect(summaryCalls(urls).length).toBe(3)
  expect(summaryCalls(urls)[2]).toMatch(/&since=9&wait=25$/)
})

// Settings check S6: a settings report that did not arrive is sent again on the next 2 s tick, also
// while the server keeps a request open (up to 25 s), so page control gets an Effort change.
test('S6: a settings report that failed is sent again on the next tick, held request or not', async ($, on) => {
  let n = 0
  let reports = 0
  const { clock } = stubs(on, null, { fetch: (e) => {
    if (/\/settings\/report$/.test(e.url)) return ++reports === 1 ? { value: { status: 503, ok: false, headers: {}, text: '{}' } } : ok({ ok: true })
    if (!/\/summary\?/.test(e.url)) return null
    if (++n === 1) return ok({ ...SUMMARY, seq: 7, changed: true })
    return clock.sleep(25000).then(() => ok({ ...SUMMARY, seq: 8, changed: true }))
  } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(reports).toBe(1)
  // The first tick starts a held request; the report is sent on that tick too, not two ticks later.
  await clock.advance(2100)
  expect(reports).toBe(2)
})

// A report sent from a drawing ends when Claude Code draws again ("superseded"): the line's first
// drawing after a reload never reports; session.start and the ticks do (S6).
test('S6: the line\'s first drawing does not report the settings', async ($, on) => {
  const { posts } = stubs(on, SUMMARY)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(posts.filter((p) => /\/settings\/report$/.test(p.url))).toEqual([])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(posts.filter((p) => /\/settings\/report$/.test(p.url)).length).toBe(1)
  await band.unmount()
})

// Settings check 0.24.55 (S6 timing): when the line's first drawing still waits for its summary,
// session.start sends the report itself, not 2 s later on the tick (3 of 96 took over 2.5 s).
test('S6: session.start reports the settings while a drawing still waits for the summary', async ($, on) => {
  let release = () => {}
  const slow = new Promise((r) => { release = r })
  let n = 0
  const { posts } = stubs(on, SUMMARY, { fetch: (e) => (/\/summary\?/.test(e.url) && ++n === 1 ? slow.then(() => ok(SUMMARY)) : null) })
  const drawing = $.ui.mount({ ...BAND, surface: 'terminal' })
  try {
    await new Promise((r) => setTimeout(r, 50))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect(posts.filter((p) => /\/settings\/report$/.test(p.url)).length).toBe(1)
  } finally {
    release()
    await (await drawing).unmount()
  }
})

test('an older server (no seq in its answer) is asked every 2 s, as before', async ($, on) => {
  const { urls, clock } = stubs(on, SUMMARY)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (let i = 0; i < 3; i++) await clock.advance(2000)
  const calls = summaryCalls(urls)
  expect(calls.length).toBe(4)
  expect(calls.some((u) => /since=|wait=/.test(u))).toBe(false)
})

test('a server that is not there is asked less often: 2 s, 4 s, 8 s, then every 10 s, never sooner than 2 s', async ($, on) => {
  const times = []
  const { clock } = stubs(on, null, { fetch: (e) => {
    if (/\/summary\?/.test(e.url)) times.push(clock.now())
    return null
  } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (let i = 0; i < 30; i++) await clock.advance(2000)
  const later = times.filter((t) => t > 0)
  const gaps = later.slice(1).map((t, i) => t - later[i])
  expect(gaps.every((g) => g >= 2000)).toBe(true)
  expect(gaps.slice(-3)).toEqual([10000, 10000, 10000])
  // The 2 s poll made 30 requests in this minute.
  expect(times.length).toBeLessThan(12)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Not running' })).toBeDefined()
})

test('a held request that fails is followed by a plain one; the line stays; after three, the 2 s poll', async ($, on) => {
  const { urls, clock } = stubs(on, null, { fetch: (e) => {
    if (!/\/summary\?/.test(e.url)) return null
    return /since=/.test(e.url) ? { deny: 'socket hang up' } : ok({ ...SUMMARY, seq: 5, changed: true })
  } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (let i = 0; i < 8; i++) {
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: 'Not running' })).toBeUndefined()
  }
  const calls = summaryCalls(urls)
  expect(calls.map((u) => /since=/.test(u))).toEqual([false, true, false, true, false, true, false, false, false])
})

test('a restarted server numbers from lower down: its answer is taken as a change', async ($, on) => {
  let n = 0
  const { urls, clock } = stubs(on, null, { fetch: (e) => {
    if (!/\/summary\?/.test(e.url)) return null
    n++
    return n === 1 ? ok({ ...SUMMARY, seq: 900, changed: true }) : ok({ ...SUMMARY, state: 'idle', seq: 4, changed: true })
  } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Idle' })).toBeDefined()
  await clock.advance(2000)
  expect(summaryCalls(urls)[2]).toMatch(/&since=4&wait=25$/)
})

test('Sol advice: a restarted server (a new instance) gets the settings again', async ($, on) => {
  let n = 0
  const { posts, clock } = stubs(on, null, { fetch: (e) => {
    if (!/\/summary\?/.test(e.url)) return null
    n++
    return ok({ ...SUMMARY, seq: n === 1 ? 900 : 4, changed: true, instance: n === 1 ? '1111111111111111' : '2222222222222222' })
  } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2000)
  await clock.advance(2000)
  expect(n).toBeGreaterThan(1)
  expect(posts.filter((p) => /\/settings\/report$/.test(p.url)).length).toBe(2)
})

// ---------- pairing messages (handoff 11.3) ----------
const green = (tree) => elements(tree).some((x) => x.type === 'Text' && x.props.color === 'success' && /^✓ Paired with ◆ /.test(textOf(x)))
const JOIN_LINE = '/editlens join root@203.0.113.5 ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456'
const PAIR_REPLY = [
  { k: 'head', title: 'Pair another computer', pairing: 'c0de01' },
  { k: 'blank' },
  { k: 'field', label: 'Open for', value: '10 min', width: 17 },
  { k: 'field', label: 'Code works', value: 'once', width: 17 },
  { k: 'field', label: 'This computer', value: 'root@vps-123456', width: 17 },
  { k: 'blank' },
  { k: 'steps', heading: 'On your other computer, type this in Claude Code:', items: [], plain: ['! On your other computer, type this in Claude Code:'] },
  { k: 'code', text: JOIN_LINE, copy: true, plain: ['', JOIN_LINE, ''] },
  { k: 'field', label: 'Cancel', value: '/editlens pair off', width: 17, cmd: true },
].map((r) => '\u001eEL' + JSON.stringify({ ...r, plain: r.plain || [r.k === 'head' ? '✦ ' + r.title : r.k === 'field' ? fieldLabel(r.label, r.width) + r.value : ''] })).join('\n')

test('pairing: "Pairing open" while the code waits; then green "✓ Paired with ◆ name" for 10 s, the success block, and the pair reply shown as done', async ($, on) => {
  let now: Record<string, unknown> = { ...SUMMARY, paired: { host: [], joined: [], waiting: { minutesLeft: 9, id: 'c0de01' } } }
  const { clock } = stubs(on, null, { stdout: PAIR_REPLY, fetch: (e) => (/\/summary\?/.test(e.url) ? ok(now) : null) })
  const logs: string[] = []
  const toasts: string[] = []
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'Pairing open · 9 min' })).toBeDefined()
  // The reply: a dotted line to one value column, and the join line alone on its row, never wrapped.
  const out = await $.command.run({ command: 'editlens', args: 'pair' })
  expect(out.text).toContain('Open for ······· 10 min\nCode works ····· once\nThis computer ·· root@vps-123456')
  expect(out.text).toContain('\n' + JOIN_LINE + '\n')
  const reply = { plugin: 'editlens', component: 'CommandOutput' as const, requestId: 'pair1', props: { command: 'editlens', args: 'pair', text: out.text, isErrored: false } }
  const before = await $.ui.mount({ ...reply, surface: 'terminal', viewport: { columns: 120, rows: 40 } })
  const drawn = elements(await before.drawn())
  const labels = drawn.filter((x) => x.props.key === 'label')
  expect(labels.map((x) => x.props.width)).toEqual([17, 17, 17, 17])
  expect(labels.every((x) => elements(x).some((y) => y.props.key === 'dots'))).toBe(true)
  const holder = drawn.find((x) => x.type === 'Box' && x.props.width === JOIN_LINE.length)
  expect(holder.props.flexShrink).toBe(0)
  expect(textOf(holder)).toBe(JOIN_LINE)
  expect(elements(holder).find((x) => x.type === 'Text').props.wrap).toBe('truncate-end')
  await before.unmount()
  // The desktop app wraps only on screen (a copy is one line): no fixed width there.
  const desk = elements(await (await $.ui.mount({ ...reply, surface: 'desktop' })).drawn())
  expect(desk.some((x) => x.type === 'Box' && x.props.width === JOIN_LINE.length)).toBe(false)
  expect(desk.find((x) => x.type === 'Text' && textOf(x) === JOIN_LINE && x.props.wrap === 'wrap')).toBeDefined()
  // The other computer joins with the code.
  now = { ...SUMMARY, paired: { host: [{ name: 'laptop-1', connected: true, here: true, folder: 'work' }], joined: [], waiting: null },
    pairing: [{ id: 1, at: Date.now(), text: "Paired with ◆ laptop-1 · it can open this project's page and give Claude here tasks; you answer their permission questions", kind: 'paired', name: 'laptop-1', site: true, pairing: 'c0de01' }] }
  await clock.advance(2100)
  expect(await band.find({ type: 'Text', text: '✓ Paired with ◆ laptop-1' })).toBeDefined()
  expect(green(await band.drawn())).toBe(true)
  expect(await band.find({ type: 'Text', text: /Pairing open/ })).toBeUndefined()
  expect(toasts).toEqual(["✦ ✓ Paired with ◆ laptop-1 · it can open this project's page and give Claude here tasks; you answer their permission questions"])
  expect(logs).toContain([
    '✦ ✓ Paired with ◆ laptop-1',
    "It can ······ open this project's page, give Claude here tasks",
    'You answer ·· its permission questions',
    'Remove ······ /editlens join off laptop-1',
  ].join('\n'))
  // The pair reply now reads as done: no code still open.
  const after = await $.ui.mount({ ...reply, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: ' ✓ Paired with ◆ laptop-1' })).toBeDefined()
  expect(textOf(await after.drawn())).not.toContain(JOIN_LINE)
  await after.unmount()
  // Ten seconds later the line is back to normal; the notice is not shown again.
  await clock.advance(8000)
  expect(await band.find({ type: 'Text', text: '✓ Paired with ◆ laptop-1' })).toBeDefined()
  await clock.advance(2100)
  expect(await band.find({ type: 'Text', text: '✓ Paired with ◆ laptop-1' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'laptop-1 paired' })).toBeDefined()
  expect(toasts.length).toBe(1)
})

test('pairing on the computer that joined: the same green line, no second block (its /editlens join reply is the block)', async ($, on) => {
  let now: Record<string, unknown> = { ...SUMMARY, paired: { host: [], joined: [] } }
  const { clock } = stubs(on, null, { fetch: (e) => (/\/summary\?/.test(e.url) ? ok(now) : null) })
  const logs: string[] = []
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  now = { ...SUMMARY, paired: { host: [], joined: [{ name: 'vps-123456', state: 'connected', url: 'http://127.0.0.1:4732/' }] },
    pairing: [{ id: 3, at: Date.now(), text: 'Paired with ◆ vps-123456 · this computer can open its page and give Claude there tasks', kind: 'paired', name: 'vps-123456', joined: true }] }
  await clock.advance(2100)
  expect(await band.find({ type: 'Text', text: '✓ Paired with ◆ vps-123456' })).toBeDefined()
  expect(green(await band.drawn())).toBe(true)
  expect(logs.some((t) => /Paired with/.test(t))).toBe(false)
  expect(plainOf(pairedRecords({ name: 'vps-123456', joined: true }))).toBe([
    '✦ ✓ Paired with ◆ vps-123456',
    'You can ··· open its page, give Claude there tasks',
    'Next ······ /editlens control vps-123456',
    'Remove ···· /editlens join off vps-123456',
  ].join('\n'))
})

test('"2 computers paired" counts computers by name; Details names each pairing and how to remove an old one', () => {
  const text = (s) => pairedOf(s).map((p) => p.parts.map((x) => x.text).join('')).join(' | ')
  const old = Date.now() - 3 * 3600 * 1000
  // One laptop with an old pairing left over (paired before 0.24.33 in another way): one computer.
  const same = { paired: { host: [{ name: 'office-laptop-1', connected: true, here: true }, { name: 'office-laptop-1', connected: false, here: true, lastSeen: old }] } }
  expect(text(same)).toBe('◆ office-laptop-1 paired')
  expect(text({ paired: { host: [{ name: 'laptop-1', connected: true, here: true }, { name: 'desk-2', connected: false, here: true }] } })).toBe('◆ laptop-1 and desk-2 paired')
  const d = detailsText({ control: 'manual', state: 'idle', pages: [], ...same, tokens: {}, agents: [] })
  expect(d).toContain('  Paired      ◆ office-laptop-1 · connected')
  expect(d).toContain('              ◆ office-laptop-1 · last seen 3 h ago · /editlens join off office-laptop-1 removes it')
  expect(detailsText({ control: 'manual', state: 'idle', pages: [], paired: { host: [], joined: [], waiting: { minutesLeft: 7 } }, tokens: {}, agents: [] }))
    .toContain('  Pairing     ! code open · 7 min left · /editlens pair off ends all pairings')
})

test('T3: Effort here returns while /effort is still open, so the press never runs past its time limit', async ($, on) => {
  const E = { ...SUMMARY, effortHere: { level: 'high', used: 'high', supported: true, cap: null, source: 'terminal' } }
  stubs(on, E, { stdout: '' })
  // Claude Code's /effort: open until the user closes it (here: never).
  let opened = 0
  on('command.run', { command: 'effort' }, () => {
    opened++
    return new Promise(() => {})
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  const pressed = await Promise.race([ui.press({ key: 'set-effort_here' }).then(() => 'returned'), new Promise((r) => setTimeout(() => r('still waiting'), 1500))])
  expect(pressed).toBe('returned')
  expect(opened).toBe(1)
  await ui.unmount()
})

test('effort: /editlens effort runs with this session; the line, Details and both Settings rows show the level', async ($, on) => {
  const E = { ...SUMMARY, effort: { level: 'xhigh', used: 'xhigh', supported: true, cap: null, source: 'page' }, effortHere: { level: 'high', used: 'high', supported: true, cap: null, source: 'terminal' } }
  const manifest = JSON.stringify({ name: 'editlens', userConfig: { ...JSON.parse(FULL).userConfig,
    effort: { type: 'string', title: 'Effort', description: "Claude's effort level for page messages and tasks it starts. More.", options: ['Low', 'Medium', 'High', 'Extra high', 'Max'], default: 'High' } } })
  const { runs, sets } = stubs(on, E, { manifest, stdout: '' })
  const opened: string[] = []
  on('command.run', { command: 'effort' }, ($, e) => {
    opened.push(e.origin.kind)
    return { text: '' }
  })
  on('prompt.read', () => ({ value: { text: '' } }))
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { value: { isFilled: true } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // The command: bin/start.js effort <level>, with this session's id; never the busy line.
  await $.command.run({ command: 'editlens', args: 'effort max' })
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['effort', 'max'])
  expect(runs[runs.length - 1].init.env.EDITLENS_SESSION_ID).toBe('s1')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'Extra high' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Connecting/ })).toBeUndefined()
  await band.unmount()
  // Details: the row, and Change runs /editlens effort.
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: ' · this terminal High' })).toBeDefined()
  expect((await pane.find({ key: 'change-effort' })).props.label).toBe('Change')
  await pane.press({ key: 'change-effort' })
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['effort'])
  await pane.unmount()
  // Settings: Effort (Page control) changes the setting; Effort here opens Claude Code's /effort.
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal', props: { ...SETTINGS_PANE.props, bodyColumns: 58 } })
  expect((await ui.find({ key: 'set-effort' })).props.label).toBe('High')
  expect(textOf(await ui.find({ key: 'row-effort_here' }))).toMatch(/^ ?Effort here ·+ ?High$/)
  await ui.press({ key: 'set-effort' })
  expect(sets).toEqual([{ key: 'editlens.effort', value: 'Extra high' }])
  await ui.press({ key: 'set-effort_here' })
  expect(opened.length + filled.filter((t) => t === '/effort').length).toBe(1)
  await ui.unmount()
})

// ---------- /editlens sessions and /editlens stop <name> (handoff 13.3) ----------
const SESSIONS_PANE = { ...PANE, requestId: 'editlens-sessions', props: { ...PANE.props, title: 'Sessions', bodyColumns: 64 } } as const
const SID = '7f3c9a1e-1111-4222-8333-444455556666'
const SID2 = '0a1b2c3d-1111-4222-8333-444455556666'
const SID3 = '9e8d7c6b-1111-4222-8333-444455556666'
// Today at 14:02 (the pane says times in the computer's own clock, "yesterday", or a date).
const T0 = (() => { const d = new Date(); d.setHours(14, 2, 0, 0); return d.getTime() })()
const YESTERDAY = (() => { const d = new Date(T0 - 86400000); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getDate() })()
const SESSIONS = {
  total: 5, running: 2, waiting: 1, names: { main: 'Make the header blue' },
  groups: [
    { key: 'here', computer: null, title: 'This computer', slots: { running: 0, limit: 4 }, rows: [
      { key: 'pc:' + SID, kind: 'page', name: 'Make the header blue', ownName: 'Make the header blue', renamed: true, state: 'working', running: true, current: true, how: 'Page control',
        model: 'claude-opus-5-5', effort: 'high', mode: 'auto', startedAt: T0, at: null, folder: '/work', sessionId: SID, command: 'cd "/work" && claude --resume ' + SID, follow: 'main' },
      { key: 'pc:' + SID2, kind: 'page', name: 'Fix the menu prices', ownName: 'Fix the menu prices', renamed: false, state: 'stopped', running: false, current: false, how: 'Page control',
        model: 'claude-opus-5-5', effort: 'high', mode: 'auto', startedAt: T0 - 86400000, at: T0 - 86400000 + 3600000, folder: '/work', sessionId: SID2, command: 'cd "/work" && claude --resume ' + SID2, follow: null },
    ] },
    { key: 'r:vps-123456', computer: 'vps-123456', title: '◆ vps-123456', slots: { running: 4, limit: 4 }, rows: [
      { key: 'r:vps-123456:aaaaaaaaaaaa', kind: 'there', computer: 'vps-123456', name: 'Fix the header spacing', ownName: 'Fix the header spacing', renamed: false, state: 'working', running: true,
        how: 'Task · copy of this project', model: 'claude-opus-5-5', effort: 'xhigh', mode: 'auto', startedAt: T0, at: T0, folder: '/root/.claude/editlens/workspaces/aaaaaaaaaaaa', sessionId: SID3,
        command: 'cd "/root/.claude/editlens/workspaces/aaaaaaaaaaaa" && claude --resume ' + SID3, follow: 'r:vps-123456:aaaaaaaaaaaa', slots: null },
      { key: 'r:vps-123456:bbbbbbbbbbbb', kind: 'there', computer: 'vps-123456', name: 'Add a footer', ownName: 'Add a footer', renamed: false, state: 'waiting', running: true,
        how: 'Task · copy of this project', model: null, effort: null, mode: null, startedAt: T0, at: T0, folder: null, sessionId: null, command: null, follow: 'r:vps-123456:bbbbbbbbbbbb', slots: { running: 4, limit: 4 } },
      { key: 'r:vps-123456:cccccccccccc', kind: 'there', computer: 'vps-123456', name: 'Update the README', ownName: 'Update the README', renamed: false, state: 'idle', running: false,
        how: 'Task · its own project', model: 'claude-sonnet-5', effort: 'medium', mode: 'auto', startedAt: T0 - 7200000, at: T0 - 600000, folder: null, sessionId: null, command: null, follow: 'r:vps-123456:cccccccccccc', slots: null },
    ] },
  ],
}

// The /sessions routes as the server gives them; `post` answers each POST.
function sessionRoutes(post) {
  const calls = []
  const fetch = (e) => {
    if (!/\/sessions\b|\/agents\/follow/.test(e.url)) return null
    const init = e.init || {}
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url: e.url, method: init.method || 'GET', key: init.headers && init.headers['x-editlens-token'], body })
    const [status, out] = (init.method || 'GET') === 'GET' ? [200, SESSIONS] : post(body, e.url)
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify(out) } }
  }
  return { calls, fetch }
}

test('/editlens sessions opens the Sessions pane: groups, rows, the picked one\'s line, Continue here (shown, never run), Open, Stop, Rename', async ($, on) => {
  const { calls, fetch } = sessionRoutes((body, url) => (/rename$/.test(url) ? [200, { ok: true, key: body.key, name: body.name, renamed: true }] : /follow$/.test(url) ? [200, { ok: true, pages: 1 }] : [200, { ok: true, stopped: 'Make the header blue', kind: 'page' }]))
  const { runs } = stubs(on, SUMMARY, { open: false, fetch })
  const opened = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.command.run({ command: 'editlens', args: 'sessions', origin: { kind: 'composer' } })
  expect(out.text).toBeUndefined()
  expect(opened).toEqual(['editlens-sessions'])
  expect(runs.length).toBe(0)
  expect(calls[0]).toEqual({ url: 'http://127.0.0.1:4317/sessions?cwd=%2Fwork', method: 'GET', key: 'tok', body: null })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...SESSIONS_PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Sessions' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5 · 2 running · 1 waiting' })).toBeDefined()
    expect(elements(await ui.find({ key: 'group-here' })).find((x) => x.type === 'Text').props.color).toBe('subtle')
    expect(await ui.find({ type: 'Text', text: 'This computer' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '◆ vps-123456' })).toBeDefined()
    // Layout B rows: mark, name (the button), dots, the status column.
    expect((await ui.find({ key: 'session-pc:' + SID })).props.label).toBe('Make the header blue')
    expect((await ui.find({ key: 'session-r:vps-123456:bbbbbbbbbbbb' })).props.label).toBe('Add a footer')
    for (const text of ['Working', 'Stopped · yesterday', 'Waiting', 'Done · 13:52']) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    expect(elements(await ui.find({ key: 'session-row-pc:' + SID })).find((x) => x.props.key === 'dots')).toBeDefined()
    // The first running row is selected: its line, the command (here: claude --resume alone), the
    // buttons.
    expect(await ui.find({ type: 'Text', text: 'Page control · Opus 5.5 · High · Auto · 14:02' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Continue here' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'claude --resume ' + SID })).toBeDefined()
    expect((await ui.find({ key: 'open-session' })).props.label).toBe('Open')
    expect((await ui.find({ key: 'stop-session' })).props.label).toBe('Stop')
    expect((await ui.find({ key: 'rename-session' })).props.label).toBe('Rename')
    expect(await ui.find({ type: 'Text', text: SESSIONS_HINT })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /NaN|undefined|\[object/ })).toBeUndefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...SESSIONS_PANE, surface: 'terminal' })
  // Stop: POST /sessions/stop with its key; nothing is run in this terminal.
  await ui.press({ key: 'stop-session' })
  expect(calls.filter((c) => c.method === 'POST').pop()).toEqual({ url: 'http://127.0.0.1:4317/sessions/stop', method: 'POST', key: 'tok', body: { cwd: '/work', key: 'pc:' + SID } })
  expect(await ui.find({ type: 'Text', text: 'Stopped Make the header blue.' })).toBeDefined()
  // Open: the project's pages follow it.
  await ui.press({ key: 'open-session' })
  expect(calls.filter((c) => c.method === 'POST').pop()).toMatchObject({ url: 'http://127.0.0.1:4317/agents/follow', body: { cwd: '/work', key: 'main' } })
  // Rename: an Input; Enter saves through POST /sessions/rename.
  await ui.press({ key: 'rename-session' })
  expect((await ui.find({ key: 'rename-input' })).props.value).toBe('Make the header blue')
  await ui.input({ key: 'rename-input', text: 'Blue header' })
  expect(calls.filter((c) => c.method === 'POST').pop()).toEqual({ url: 'http://127.0.0.1:4317/sessions/rename', method: 'POST', key: 'tok', body: { cwd: '/work', key: 'pc:' + SID, name: 'Blue header' } })
  expect(await ui.find({ type: 'Text', text: 'Renamed to Blue header.' })).toBeDefined()
  expect(await ui.find({ key: 'rename-input' })).toBeUndefined()
  // A paired computer's waiting task: no command yet, "4 of 4 already running", Stop; a done one: no Stop.
  await ui.press({ key: 'session-r:vps-123456:bbbbbbbbbbbb' })
  expect(await ui.find({ type: 'Text', text: 'Task · 4 of 4 already running' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Continue on ◆ vps-123456' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: "after Claude's first reply" })).toBeDefined()
  expect(await ui.find({ key: 'stop-session' })).toBeDefined()
  await ui.press({ key: 'session-r:vps-123456:aaaaaaaaaaaa' })
  expect(await ui.find({ type: 'Text', text: 'cd "/root/.claude/editlens/workspaces/aaaaaaaaaaaa" && claude --resume ' + SID3 })).toBeDefined()
  await ui.press({ key: 'session-r:vps-123456:cccccccccccc' })
  expect(await ui.find({ key: 'stop-session' })).toBeUndefined()
  await ui.press({ key: 'session-pc:' + SID2 })
  expect(await ui.find({ key: 'open-session' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'claude --resume ' + SID2 })).toBeDefined()
  await ui.unmount()
  // Nothing in this terminal ran: the command is shown only.
  expect(runs.length).toBe(0)
})

// Sol M14: the list is loaded again while the pane is open, so a session that stops shows it.
test('the Sessions pane reloads its list while it is open, and not after it closes', async ($, on) => {
  let list = SESSIONS
  const gets = []
  const fetch = (e) => {
    if (!/\/sessions\b/.test(e.url)) return null
    gets.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(list) } }
  }
  const { clock } = stubs(on, SUMMARY, { fetch })
  let open = true
  on('ui.panes', () => ({ value: open ? [{ id: 'editlens-sessions', title: 'Sessions', isPlaced: true }] : [] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'editlens', args: 'sessions', origin: { kind: 'composer' } })
  expect(gets.length).toBe(1)
  const ui = await $.ui.mount({ ...SESSIONS_PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
  const row = SESSIONS.groups[0].rows[0]
  list = { ...SESSIONS, running: 1, groups: [{ ...SESSIONS.groups[0], rows: [{ ...row, state: 'stopped', running: false, at: T0 }, SESSIONS.groups[0].rows[1]] }, SESSIONS.groups[1]] }
  for (let i = 0; i < 4; i++) await clock.advance(2000)
  expect(gets.length).toBeGreaterThan(1)
  expect(await ui.find({ type: 'Text', text: '5 · 1 running · 1 waiting' })).toBeDefined()
  await ui.unmount()
  open = false
  const before = gets.length
  for (let i = 0; i < 4; i++) await clock.advance(2000)
  expect(gets.length).toBe(before)
})

test('/editlens sessions as text where no pane can be shown, and when EditLens is off', async ($, on) => {
  const { fetch } = sessionRoutes(() => [200, {}])
  stubs(on, SUMMARY, { open: false, fetch })
  on('ui.open', () => ({ value: { isPlaced: false } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.command.run({ command: 'editlens', args: 'sessions' })
  const text = sessionsText(SESSIONS, { cwd: '/work', now: T0 + 60000 })
  expect(out.text.split('\n')[0]).toBe('✦ Sessions  5 · 2 running · 1 waiting')
  const lines = text.split('\n')
  expect(lines).toContain('This computer')
  expect(lines).toContain('◆ vps-123456')
  expect(lines).toContain('  ◐ Make the header blue ·············· Working')
  expect(lines).toContain('      Page control · Opus 5.5 · High · Auto · 14:02')
  expect(lines).toContain('      Continue here  claude --resume ' + SID)
  expect(lines).toContain('  ● Add a footer ······················ Waiting')
  expect(lines).toContain('      Task · 4 of 4 already running')
  expect(lines).toContain('      Page control · Opus 5.5 · High · Auto · ' + YESTERDAY + ', 14:02')
  expect(lines).toContain('  ○ Fix the menu prices ··············· Stopped · yesterday')
  expect(lines).toContain('  /editlens stop <name>  stops a running one')
  for (const l of lines) if (!/ cd "/.test(l)) expect(l.length).toBeLessThanOrEqual(80)
  expect(text).not.toMatch(/NaN|undefined/)
  const recs = recordsFromText(text)
  expect(recs[0]).toMatchObject({ k: 'head', title: 'Sessions  5 · 2 running · 1 waiting' })
  expect(recs.filter((r) => r.k === 'cmd').map((r) => r.cmd)).toEqual(['/editlens stop <name>', '/editlens details'])
  expect(sessionsText(null, { down: true })).toContain('! Fix  Run /editlens to start it and connect your page')
  expect(sessionsModel({ groups: [{ key: 'x', rows: [{ key: 'k', state: 'nonsense', startedAt: 'x', slots: { running: NaN, limit: 4 } }] }] }).groups[0].rows[0]).toMatchObject({ name: 'Session', status: { text: 'Ended' } })
})

test('/editlens stop <name>: typed by the person, it stops that session by its name; from Claude or a plugin it is refused', async ($, on) => {
  const { calls, fetch } = sessionRoutes((body) => (body.name === 'Fix the header spacing' ? [200, { ok: true, stopped: 'Fix the header spacing', kind: 'there' }]
    : body.name === 'Fix the menu prices' ? [409, { error: '"Fix the menu prices" is not running.', name: 'Fix the menu prices' }]
      : body.name === 'Twice' ? [409, { error: '2 running sessions are named "Twice".', choices: ['Twice', 'Twice'] }] : [404, { error: 'No session here is named "x".' }]))
  const { runs } = stubs(on, SUMMARY, { fetch })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ok = await $.command.run({ command: 'editlens', args: 'stop Fix the header spacing', origin: { kind: 'composer' } })
  expect(calls.pop()).toEqual({ url: 'http://127.0.0.1:4317/sessions/stop', method: 'POST', key: 'tok', body: { cwd: '/work', name: 'Fix the header spacing' } })
  expect(ok.text).toBe('✓ Stopped Fix the header spacing  · it stays in /editlens sessions')
  const none = await $.command.run({ command: 'editlens', args: 'stop nobody', origin: { kind: 'bridge' } })
  expect(none.text).toBe('✕ No session here is named "nobody"\n! Fix  See their names in › /editlens sessions')
  const idle = await $.command.run({ command: 'editlens', args: 'stop Fix the menu prices', origin: { kind: 'composer' } })
  expect(idle.text.split('\n')[0]).toBe('✕ "Fix the menu prices" is not running')
  const twice = await $.command.run({ command: 'editlens', args: 'stop Twice', origin: { kind: 'composer' } })
  expect(twice.text).toBe('✕ 2 running sessions are named "Twice"\n! Fix  Rename one in › /editlens sessions, then try again')
  // Not typed by the person (Claude, another plugin): refused before anything is sent.
  const before = calls.length
  const claude = await $.command.run({ command: 'editlens', args: 'stop Fix the header spacing', origin: { kind: 'sdk' } })
  expect(claude.text).toBe('✕ Only you can stop a session by its name\n! Fix  Type › /editlens stop Fix the header spacing at the prompt yourself')
  expect(calls.length).toBe(before)
  // Plain stop and stop remove still disconnect (bin/start.js); page control's own words are kept.
  await $.command.run({ command: 'editlens', args: 'stop remove', origin: { kind: 'composer' } })
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['stop', 'remove'])
  expect(stopName('stop')).toBe(null)
  expect(stopName('stop remove')).toBe(null)
  expect(stopName('STOP  Blue   header')).toBe('Blue header')
  expect(notTypedStop('stop x', 'composer')).toBe(false)
  expect(notTypedStop('stop x', 'sdk')).toBe(true)
  expect(stopNameRecords({ status: 200, json: { ok: true, stopped: 'Blue header', kind: 'page' } }, 'blue header')[0].plain[0]).toBe('✓ Stopped Blue header  · the page is in Manual again')
  expect(stopNameRecords({ down: true }, 'x').map((r) => r.k)).toEqual(['fail', 'fix'])
})

test('Tasks at once: a layout-B row under Other computers; a press steps 1 to 8, then back to 1', async ($, on) => {
  const manifest = JSON.stringify({ name: 'editlens', userConfig: { ...JSON.parse(FULL).userConfig,
    remote_tasks: { type: 'boolean', title: 'Paired computers can run Claude here', description: 'd', default: true },
    tasks_at_once: { type: 'number', title: 'Tasks at once', description: 'Each running task adds about 0.3–0.5 GB of memory and uses your plan\'s limits in parallel. More.', min: 1, max: 8, default: 4 } } })
  const { sets } = stubs(on, SUMMARY, { manifest })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const sections = settingSections(JSON.parse(manifest).userConfig)
  expect(sections.find((sec) => sec.title === 'Other computers').rows.map((r) => r.key)).toEqual(['remote_tasks', 'tasks_at_once', 'task_account'])
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal', props: { ...SETTINGS_PANE.props, bodyColumns: 64 } })
  expect(textOf(await ui.find({ key: 'row-tasks_at_once' }))).toMatch(/^ ?Tasks at once ·+ ?4$/)
  await ui.press({ key: 'set-tasks_at_once' })
  expect(sets).toEqual([{ key: 'editlens.tasks_at_once', value: 5 }])
  await ui.unmount()
  const field = JSON.parse(manifest).userConfig.tasks_at_once
  expect(nextValue(field, 8, 'tasks_at_once')).toBe(1)
  expect(nextValue(field, NaN, 'tasks_at_once')).toBe(5)
  expect(rangeNote(field)).toBe('1 to 8. ')
  // The port's range is too large to step: changed in /config.
  expect(nextValue(JSON.parse(FULL).userConfig.port, 4317, 'port')).toBe(undefined)
  expect(rangeNote(JSON.parse(FULL).userConfig.port)).toBe('')
})

test('M12: a summary answer is applied in full before the next request, so settings change in order', async ($, on) => {
  let now: Record<string, unknown> = { ...SUMMARY, seq: 1 }
  const done: string[] = []
  let release = () => {}
  // The first change is slow: the next tick comes while it is still being made.
  const configSet = async (e) => {
    if (e.value === 'Dark') await new Promise<void>((r) => { release = r })
    done.push(e.value)
    return { value: e.value }
  }
  const { clock } = stubs(on, null, { fetch: (e) => (/\/summary\?/.test(e.url) ? ok(now) : null), configSet })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  now = { ...SUMMARY, seq: 2, settingsPending: [{ id: 1, key: 'theme', value: 'Dark' }] }
  await clock.advance(2100)
  now = { ...SUMMARY, seq: 3, settingsPending: [{ id: 2, key: 'theme', value: 'Light' }] }
  await clock.advance(2100)
  await clock.advance(2100)
  release()
  await clock.advance(2100)
  await clock.advance(2100)
  expect(done).toEqual(['Dark', 'Light'])
})

test('M13: after the server restarts (a new instance), its request and notice ids count as new', async ($, on) => {
  let now: Record<string, unknown> = { ...SUMMARY, instance: 'a', settingsPending: [{ id: 1, key: 'theme', value: 'Dark' }],
    pairing: [{ id: 1, at: Date.now(), text: 'Paired with ◆ laptop-1', kind: 'paired', name: 'laptop-1', pairing: 'c0de01' }] }
  const { sets, clock } = stubs(on, null, { fetch: (e) => (/\/summary\?/.test(e.url) ? ok(now) : null) })
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2100)
  expect(sets).toEqual([{ key: 'editlens.theme', value: 'Dark' }])
  // The same instance again: nothing twice.
  await clock.advance(2100)
  expect(sets.length).toBe(1)
  // A restarted server numbers from 1 again.
  now = { ...SUMMARY, instance: 'b', settingsPending: [{ id: 1, key: 'theme', value: 'Light' }],
    pairing: [{ id: 1, at: Date.now(), text: 'Paired with ◆ vps-2', kind: 'paired', name: 'vps-2', pairing: 'c0de02' }] }
  await clock.advance(2100)
  expect(sets).toEqual([{ key: 'editlens.theme', value: 'Dark' }, { key: 'editlens.theme', value: 'Light' }])
  expect(toasts.filter((t) => /vps-2/.test(t)).length).toBe(1)
})

test('L5: /editlens keeps a quoted argument as one, spaces and all', async ($, on) => {
  const { runs } = stubs(on, SUMMARY)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'editlens', args: '"my  app/web site"' })
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['my  app/web site'])
  await $.command.run({ command: 'editlens', args: "help   'page  control'" })
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['help', 'page  control'])
  await $.command.run({ command: 'editlens', args: '  control   new ' })
  expect(runs[runs.length - 1].argv.slice(2)).toEqual(['control', 'new'])
  expect(stopName('stop "Blue  header"')).toBe('Blue  header')
})

test('L11: a time too large for a date is never shown as NaN', () => {
  expect(editTime(1e20)).toBe('')
  expect(editTime(Date.now(), 1e20)).not.toMatch(/NaN|Invalid/)
  const sessions = sessionsText({ total: 1, running: 0, groups: [{ key: 'here', title: 'This computer', rows: [{ key: 'pc:x', kind: 'page', name: 'Old one', state: 'stopped', at: 1e20, startedAt: 1e20 }] }] }, { cwd: '/work', now: T0 })
  expect(sessions).not.toMatch(/NaN|Invalid/)
  const agents = agentsText({ ...SUMMARY, agents: [{ key: 'toolu_9', agentId: 'a9', name: 'Far future', type: 'general-purpose', status: 'working', startedAt: 1e20 }] })
  expect(agents).not.toMatch(/NaN|Invalid/)
})

test('L3: a second /editlens of the same kind while one runs says so and starts nothing; restart gets the long time', async ($, on) => {
  let release = () => {}
  const gate = new Promise((r) => { release = r })
  const { runs } = stubs(on, SUMMARY, { run: async () => {
    await gate
    return { value: { exitCode: 0, stdout: 'Connected: open http://127.0.0.1:5174/', stderr: '' } }
  } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const first = $.command.run({ command: 'editlens', args: '', origin: { kind: 'composer' } })
  await new Promise((r) => setTimeout(r, 20))
  const second = await $.command.run({ command: 'editlens', args: '', origin: { kind: 'composer' } })
  expect(runs.length).toBe(1)
  expect(String(second.text)).toMatch(/already running/)
  expect(String(second.text)).toMatch(/Wait for its answer/)
  release()
  await first
  await $.command.run({ command: 'editlens', args: 'restart' })
  expect(runs[runs.length - 1].init.timeoutMs).toBe(600000)
})

// Settings check S5: a Port setting changed during the session applies after a restart. The port the
// session started with is kept (for the hooks in <state>/session-ports/<session>), and this file,
// reloaded with the new setting, continues with it.
const KEPT = '/home/u/.claude/editlens/session-ports/s1'
test('S5: reloaded with a new Port setting, the mod keeps the port the session started with', { options: { port: 5326 } }, async ($, on) => {
  const { urls, runs, posts } = stubs(on, SUMMARY, { files: { [KEPT]: '4317' } })
  // Claude Code reloaded this file after the change, while the session runs: the line is drawn, then
  // Claude Code sends session.start again (SN2). It keeps the port this Claude Code started with.
  on('state.get', ($, e) => ({ value: { value: e.key === 'port' ? 4317 : undefined, version: 1 } }))
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(urls.length).toBeGreaterThan(0)
  expect(urls.filter((u) => !u.startsWith('http://127.0.0.1:4317/'))).toEqual([])
  expect(runs.filter((r) => /serve\.js$/.test(r.argv[1]))).toEqual([])
  expect(posts.find((p) => /\/settings\/report$/.test(p.url)).body.values.port).toBe(5326)
  await band.unmount()
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  expect(textOf(await ui.find({ key: 'row-port' }))).toContain('Applies after a restart.')
  await ui.unmount()
})

test('S5: when Claude Code starts, the Port setting is used and kept for the session', { options: { port: 5326 } }, async ($, on) => {
  // What was kept before the restart (a resumed session has the same id) is replaced.
  const { urls, writes } = stubs(on, SUMMARY, { files: { [KEPT]: '4317' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(writes.filter((w) => w.path === KEPT)).toEqual([{ path: KEPT, text: '5326' }])
  expect(urls.filter((u) => !u.startsWith('http://127.0.0.1:5326/'))).toEqual([])
})

// Settings check U2: after /clear the session continues under another id, with no session.start.
// The hooks of that SessionStart find the port kept for the new id before they run.
test('U2: /clear after a Port change keeps the running port for the hooks of the new session', { options: { port: 5326 } }, async ($, on) => {
  const { writes } = stubs(on, SUMMARY, { files: { [KEPT]: '4317' } })
  on('state.get', ($, e) => ({ value: { value: e.key === 'port' ? 4317 : undefined, version: 1 } }))
  const kept = KEPT.replace(/s1$/, 's2')
  let seen = null
  on('classic.SessionStart', () => {
    seen = writes.filter((w) => w.path === kept)
    return {}
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'clear', session_id: 's2' })
  expect(seen).toEqual([{ path: kept, text: '4317' }])
})

// Settings check V1: Claude Code keeps $.state per session, so a /clear starts it empty. A setting
// changed after the /clear reloads this file, which must still find the port it started with.
test('V1: after /clear, a setting change (a reload) keeps the running port', { options: { port: 5326 } }, async ($, on) => {
  const held = new Map([['port', 4317]])
  on('state.get', ($, e) => ({ value: { value: held.get(e.key), version: 1 } }))
  on('state.set', ($, e) => {
    held.set(e.key, e.value)
    return { value: { isSet: true, version: 2 } }
  })
  const { urls } = stubs(on, SUMMARY, { files: { [KEPT]: '4317' } })
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  held.clear()
  await $.classic.SessionStart({ source: 'clear', session_id: 's2' })
  // The reload: Claude Code sends session.start again.
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const after = urls.length
  await $.command.run({ command: 'editlens', args: 'status' })
  expect(urls.slice(after).filter((u) => !u.startsWith('http://127.0.0.1:4317/'))).toEqual([])
})

// Settings check V2: the line drawn before session.start must not start the server. A process run
// from a drawing ends with that drawing ("aborted"), and the port may not be known yet.
test('V2: the server is started from session.start, not from a drawing before it', { options: { port: 5326 } }, async ($, on) => {
  const { runs } = stubs(on, null)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(runs.filter((r) => /serve\.js$/.test(r.argv[1]))).toEqual([])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const serves = runs.filter((r) => /serve\.js$/.test(r.argv[1]))
  expect(serves.map((r) => r.init.env.EDITLENS_PORT)).toEqual(['5326'])
  await band.unmount()
})

// Settings check V2 (rest): session.start while the line's first drawing still reads the settings
// list. The port is chosen once the list is read, not from an empty one (4317).
test('V2: session.start during a slow read of the settings list takes the Port setting', { options: { port: 5326 } }, async ($, on) => {
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  const held = new Map()
  on('state.get', ($, e) => ({ value: { value: held.get(e.key), version: 1 } }))
  on('state.set', ($, e) => {
    held.set(e.key, e.value)
    return { value: { isSet: true, version: 2 } }
  })
  const { urls } = stubs(on, SUMMARY, { gate })
  const drawn = $.ui.mount({ ...BAND, surface: 'terminal' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const starting = $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  release()
  await starting
  const band = await drawn
  expect(held.get('port')).toBe(5326)
  const after = urls.length
  await $.command.run({ command: 'editlens', args: 'status' })
  expect(urls.slice(after).filter((u) => !u.startsWith('http://127.0.0.1:5326/'))).toEqual([])
  await band.unmount()
})

// Settings check S8: Reset to defaults leaves the port alone (it changes in /config, and only
// after a restart).
test('S8: Reset to defaults does not reset the port', { options: { port: 5326, theme: 'Dark' } }, async ($, on) => {
  const { sets } = stubs(on, SUMMARY)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  await ui.press({ key: 'reset' })
  expect(sets).toContainEqual({ key: 'editlens.theme', value: 'Auto' })
  expect(sets.map((x) => x.key)).not.toContain('editlens.port')
})

// Settings check S9: each change reloads this file; the row that had the focus gets it back.
test('S9: the row picked in the Settings pane is kept across reloads', async ($, on) => {
  const { saved } = stubs(on, SUMMARY)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  // Enter on a row changes it, and Claude Code reloads this file with the new value.
  await ui.press({ key: 'set-theme' })
  expect(saved.get('settingsRow')).toEqual({ key: 'theme', session: 's1' })
  await ui.unmount()
})

test('S9: after a reload the picked row has the focus, not the first', async ($, on) => {
  const { saved } = stubs(on, SUMMARY)
  saved.set('settingsRow', { key: 'theme', session: 's1' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'set-theme' })).props.autoFocus).toBe(true)
  expect((await ui.find({ key: 'set-start' })).props.autoFocus).toBeUndefined()
  expect(textOf(await ui.find({ key: 'row-theme' }))).toMatch(/^›/)
  await ui.unmount()
})

test('S9: a row kept by another session is not used', async ($, on) => {
  const { saved } = stubs(on, SUMMARY)
  saved.set('settingsRow', { key: 'theme', session: 'other' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'set-start' })).props.autoFocus).toBe(true)
})

// Settings check S10: every choice fits the 12-cell value column.
test('S10: Dictation\'s "On this device" is short enough for the value column', async ($, on) => {
  const manifest = JSON.stringify({ name: 'editlens', userConfig: { dictation: { type: 'string', title: 'Dictation', description: 'd', options: ['On this device', 'Allow online', 'Off'], default: 'On this device' } } })
  stubs(on, SUMMARY, { manifest })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'set-dictation' })).props.label).toBe('This device')
})

// Settings check S11: the text form of /editlens settings has the same notes as bin/start.js.
test('S11: /editlens settings as text says when EDITLENS_PORT or EDITLENS_GUARD overrides a setting', async ($, on) => {
  stubs(on, SUMMARY, { open: false, env: { EDITLENS_PORT: '5327', EDITLENS_GUARD: 'off' } })
  // Where no pane can be shown (a remote session): the text form.
  on('ui.open', () => ({ value: { isPlaced: false } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.command.run({ command: 'editlens', args: 'settings' })
  expect(out.text).toContain('! EditLens uses port 5327: EDITLENS_PORT overrides the Port setting (4317).')
  expect(out.text).toContain('! The safety check is off: EDITLENS_GUARD=off turns it off.')
})

test('S11: the notes name a value that is not valid, and a port kept until Claude Code restarts', () => {
  const schema = JSON.parse(MANIFEST).userConfig
  expect(effectNotes({ schema, raw: { theme: 'Purple', port: 4317 }, env: {}, port: 4317 })).toEqual(['Panel colors: "Purple" is not a valid value, so the default is used.'])
  expect(effectNotes({ schema, raw: { port: 5326 }, env: {}, port: 4317 })).toEqual(['EditLens uses port 4317 until Claude Code restarts (the Port setting is 5326).'])
  expect(effectNotes({ schema, raw: {}, env: {}, port: 4317 })).toEqual([])
})

// Settings check S12: the Port row can't be selected, so where to change it is always shown.
test('S12: the Port row always says to change it in /config', async ($, on) => {
  stubs(on, SUMMARY)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...SETTINGS_PANE, surface })
    expect(textOf(await ui.find({ key: 'row-port' }))).toContain('Change it in /config.')
    await ui.unmount()
  }
})

// Settings check S19: each value in the text summary has its name; a choice made only in /config
// reads right whether or not it is the value now.
test('S19: the settings summary names each value', () => {
  const schema = {
    permission_mode: { type: 'string', options: ['Ask', 'Auto', "Don't ask"], default: 'Auto' },
    theme: { type: 'string', options: ['Auto', 'Light', 'Dark'], default: 'Auto' },
    text_size: { type: 'string', options: ['Small', 'Medium', 'Large'], default: 'Medium' },
    line_above_prompt: { type: 'boolean', default: true },
  }
  const bits = settingsLines(schema, { permission_mode: 'Auto', theme: 'Auto', text_size: 'Medium', line_above_prompt: true }).flatMap((l) => l.bits)
  expect(bits).toEqual(['mode Auto', 'colors Auto', 'text Medium', 'line above prompt on'])
  expect(paneNote('permission_mode', 'Ask')).toBe(" Don't ask is chosen in /config.")
})

// Sol 0.24.46 L5: an array or object is never a setting value, as lib/settings.js check() says.
test('L5 (0.24.46): arrays and objects are not setting values in the mod either', () => {
  const schema = JSON.parse(MANIFEST).userConfig
  for (const raw of [['off'], ['1'], ['Dark'], { toString: () => 'on' }, {}, []]) {
    for (const k of ['safety_check', 'line_above_prompt', 'port', 'theme']) expect(checkSetting(schema[k], raw)).toBeUndefined()
  }
  expect(checkSetting(schema.safety_check, 'off')).toBe(false)
  expect(checkSetting(schema.port, '5000')).toBe(5000)
  expect(checkSetting(schema.theme, 'Dark')).toBe('Dark')
})

// Sol 0.24.46 M10: a page's request Claude Code refuses is reported back, so the server removes it.
test('M10 (0.24.46): a page request Claude Code refuses is reported to the server', async ($, on) => {
  const { posts, sets, clock } = stubs(on, { ...SUMMARY, settingsPending: [{ id: 7, key: 'theme', value: 'Dark' }, { id: 8, key: 'line_above_prompt', value: false }] }, {
    configSet: (e) => (e.key === 'editlens.theme' ? { deny: 'Blocked by your policy' } : { value: e.value }),
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(4100)
  expect(sets.map((x) => x.key)).toEqual(['editlens.theme', 'editlens.line_above_prompt'])
  const refused = posts.filter((p) => /\/settings\/report$/.test(p.url) && p.body.refused)
  expect(refused.map((p) => p.body.refused)).toEqual([[7]])
  expect(refused[0].body.from).toBe('mod')
  expect(refused[0].headers['x-editlens-token']).toBe('tok')
})

// Sol 0.24.46 M11: every program /editlens starts gets the port this session uses, not a Port setting
// changed since (it applies after Claude Code restarts).
test('M11 (0.24.46): /editlens commands get the port in use, not a Port setting changed since', { options: { port: 5326 } }, async ($, on) => {
  const { runs } = stubs(on, SUMMARY, { files: { [KEPT]: '4317' } })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (const args of ['status', '', 'undo 1', 'pair']) {
    await $.command.run({ command: 'editlens', args })
    const last = runs[runs.length - 1]
    expect(last.argv[1]).toMatch(/bin\/start\.js$/)
    expect(last.init.env.EDITLENS_PORT).toBe('4317')
  }
  await band.unmount()
})

// Settings check SN1 (0.24.47): a Claude EditLens started (page control or a task, EDITLENS_DRIVEN)
// has its defaults, not the user's settings. Its mod makes none of the page's requests and sends the
// server no values (a refused request sent them, and the user's saved settings went back to defaults).
test('SN1: a Claude EditLens started makes no page requests and sends no setting values', async ($, on) => {
  const { posts, sets, urls, clock } = stubs(on, { ...SUMMARY, settingsPending: [{ id: 7, key: 'effort', value: 'High' }] }, {
    env: { EDITLENS_DRIVEN: '1' }, configSet: () => ({ deny: '$.config.set: no /config row with key editlens.effort' }),
  })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await clock.advance(4100)
  expect(sets).toEqual([])
  expect(posts.filter((p) => /\/settings\/report$/.test(p.url))).toEqual([])
  // The server is told, so it never counts this mod as the user's Claude Code.
  expect(urls.filter((u) => /\/summary\?/.test(u)).every((u) => /&driven=1(&|$)/.test(u))).toBe(true)
})

test('SN1: a request Claude Code refuses is reported by its id only, never with the values', async ($, on) => {
  const { posts, clock } = stubs(on, { ...SUMMARY, settingsPending: [{ id: 7, key: 'theme', value: 'Dark' }] }, {
    configSet: () => ({ deny: 'Blocked by your policy' }),
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(4100)
  const refused = posts.filter((p) => /\/settings\/report$/.test(p.url) && p.body.refused)
  expect(refused.map((p) => p.body)).toEqual([{ from: 'mod', refused: [7] }])
})

// Settings check SN2 (0.24.47): after a setting change Claude Code reloads this file and sends
// session.start again. The port this Claude Code started with ($.state, kept through a reload) is
// used, not the new Port setting.
test('SN2: a reload\'s session.start keeps the port the session started with', { options: { port: 5326 } }, async ($, on) => {
  const { urls, writes, runs } = stubs(on, SUMMARY, { files: { [KEPT]: '4317' } })
  on('state.get', ($, e) => ({ value: { value: e.key === 'port' ? 4317 : undefined, version: 1 } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(writes.filter((w) => w.path === KEPT && w.text !== '4317')).toEqual([])
  expect(urls.length).toBeGreaterThan(0)
  expect(urls.filter((u) => !u.startsWith('http://127.0.0.1:4317/'))).toEqual([])
  expect(runs.filter((r) => /serve\.js$/.test(r.argv[1]))).toEqual([])
})

test('SN2: when Claude Code starts, the port it uses is kept for its reloads', { options: { port: 5326 } }, async ($, on) => {
  stubs(on, SUMMARY)
  const kept = []
  on('state.set', ($, e) => {
    kept.push([e.key, e.value])
    return { value: { isSet: true, version: 1 } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(kept).toEqual([['port', 5326]])
})

// Settings check SN5 (0.24.47): a change reloads this file while the pane keeps the keyboard, so
// autoFocus does not apply again; the focus ring is restored to the changed row, once per load. This
// kit has no $.ui.focus (it says "no implementation"): the test counts the requests in both cases.
test('SN5: after a change (a reload), the focus is restored to the changed row', async ($, on) => {
  const { saved, clock } = stubs(on, SUMMARY)
  saved.set('settingsRow', { key: 'theme', session: 's1' })
  const asked = []
  on('ui.focus', ($, e) => {
    asked.push(e.requestId + ' ' + (e.element || e.key))
    return { value: {} }
  })
  on('ui.log', ($, e) => {
    if (/focus/.test(e.text)) asked.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  await clock.advance(50)
  expect(asked.length).toBe(1)
  expect(asked[0]).toMatch(/^editlens-settings set-theme$|^EditLens: could not move the focus: no implementation for ui\.focus$/)
  // Drawn again (Claude Code's own repaints after a reload, a summary): asked again immediately, as a
  // request before those repaints could leave the keys at the prompt (S9-e: 2 s for a typed key).
  await ui.redraw()
  await clock.advance(50)
  expect(asked.length).toBe(2)
  expect(asked[1]).toMatch(/^editlens-settings set-theme$|^EditLens: could not move the focus on a later drawing: no implementation for ui\.focus$/)
  // Once more on the next tick, the last try (5 of 461 live presses before 0.24.54). Then no more.
  await clock.advance(2000)
  expect(asked.length).toBe(3)
  expect(asked[2]).toMatch(/^editlens-settings set-theme$|^EditLens: could not move the focus on the next tick: no implementation for ui\.focus$/)
  await ui.redraw()
  await clock.advance(2000)
  expect(asked.length).toBe(3)
  await ui.unmount()
})

// Settings check S9-d (0.24.55): a Tab right after a change, while the reloaded file still reads the
// settings list, counts; before, the move was ignored and the changed row took the focus back.
test('S9-d: a person\'s move before the settings list is read picks that row', () => {
  const person = { kind: 'person' }
  const plugin = { kind: 'plugin', name: 'editlens' }
  expect(focusedRow('set-hover_code', person, {})).toBe('hover_code')
  expect(focusedRow('set-hover_code', plugin, {})).toBe(null)
  expect(focusedRow('set-theme', plugin, { theme: {} })).toBe('theme')
  expect(focusedRow('set-gone', person, { theme: {} })).toBe(null)
  expect(focusedRow('agent-main', person, {})).toBe(null)
  expect(focusedRow(undefined, person, {})).toBe(null)
})

// Settings check S9-d (0.24.58): a Tab whose hook runs while the first drawing reads the kept row picks
// the moved-to row before that drawing continues, and before focusTarget sees the pane drawn. The
// drawing still asks for the focus, on the moved-to row (33 of 36 live moves got none).
test('S9-d: a move during the first drawing still gets a focus request, on the moved-to row', () => {
  // The order seen live: the drawing waits for the kept row; the move picks hover_code meanwhile.
  expect(firstFocus({ selected: 'hover_code', kept: 'highlight', refocus: false })).toEqual({ selected: 'hover_code', refocus: true })
  // Without a move: the kept row, asked for once drawn.
  expect(firstFocus({ selected: null, kept: 'highlight', refocus: false })).toEqual({ selected: 'highlight', refocus: true })
  // Not after a reload (no kept row): nothing to ask.
  expect(firstFocus({ selected: null, kept: null, refocus: false })).toEqual({ selected: null, refocus: false })
  expect(firstFocus({ selected: 'hover_code', kept: null, refocus: false })).toEqual({ selected: 'hover_code', refocus: false })
})

// Settings check S9-d (0.24.57): after a Tab during the reload, Claude Code's repaints can take the
// focus out of the pane. The focus requests continue, for the row the person moved to.
test('S9-d: after a person\'s move, the focus requests go to that row', () => {
  const later = { requestId: 'editlens-settings', key: 'set-highlight', picked: 'highlight' }
  // Before the first drawing: that drawing asks for the focus (on the picked row, now the moved-to row).
  expect(focusTarget({ refocus: false, refocusLater: null, drawn: false }, 'hover_code'))
    .toEqual({ refocus: true, refocusLater: null })
  // After it: the later requests go to the moved-to row.
  expect(focusTarget({ refocus: false, refocusLater: later, drawn: true }, 'hover_code'))
    .toEqual({ refocus: false, refocusLater: { requestId: 'editlens-settings', key: 'set-hover_code', picked: 'hover_code' } })
  // None waiting (after the tick): nothing new is asked.
  expect(focusTarget({ refocus: false, refocusLater: null, drawn: true }, 'hover_code'))
    .toEqual({ refocus: false, refocusLater: null })
})

// Settings check S9-d (0.24.56): a move Claude Code refused is not a pick, so the changed row still
// gets the focus back (a). A move onto Reset or the close mark goes to no row.
test('S9-d: only a move that happened counts', () => {
  const person = { kind: 'person' }
  const plugin = { kind: 'plugin', name: 'editlens' }
  const fields = { theme: {}, hover_code: {} }
  const refused = { deny: 'the focus moved meanwhile' }
  expect(focusMove({ element: 'set-hover_code', origin: person }, refused, fields)).toEqual({ row: null, person: false })
  expect(focusMove({ element: 'set-hover_code', origin: person }, {}, fields)).toEqual({ row: 'hover_code', person: true })
  expect(focusMove({ element: 'set-hover_code', origin: person }, undefined, {})).toEqual({ row: 'hover_code', person: true })
  expect(focusMove({ element: 'reset', origin: person }, {}, fields)).toEqual({ row: null, person: true })
  expect(focusMove({ origin: person }, {}, fields)).toEqual({ row: null, person: true })
  expect(focusMove({ element: 'set-theme', origin: plugin }, {}, fields)).toEqual({ row: 'theme', person: false })
  expect(focusMove({ element: 'set-theme', origin: plugin }, refused, fields)).toEqual({ row: null, person: false })
})

// Settings check S9-d (0.24.54): a row the person moved to keeps the focus; the extra requests for
// the changed row are not sent after that. Here the move is a press on another row: this kit raises no
// ui.focus from the person, and both pick the row (pickRow).
test('S9-d: after the person moves to another row, the changed row does not take the focus back', async ($, on) => {
  const { saved, clock } = stubs(on, SUMMARY)
  saved.set('settingsRow', { key: 'theme', session: 's1' })
  const asked = []
  on('ui.log', ($, e) => {
    if (/focus/.test(e.text)) asked.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  await clock.advance(50)
  expect(asked.length).toBe(1)
  await ui.press({ key: 'set-line_above_prompt' })
  await ui.redraw()
  await clock.advance(50)
  await clock.advance(2000)
  expect(asked.length).toBe(1)
  await ui.unmount()
})

// Directory Validate 2: the permission mode is changed in the Settings pane's hook itself. A press
// and Reset to defaults still change it, and a refusal still shows.
test('the Settings pane changes the permission mode, and Reset puts it back', { options: { permission_mode: 'Plan' } }, async ($, on) => {
  const { sets } = stubs(on, SUMMARY, { manifest: FULL })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  await ui.press({ key: 'set-permission_mode' })
  expect(sets).toEqual([{ key: 'editlens.permission_mode', value: 'Auto' }])
  await ui.press({ key: 'reset' })
  expect(sets).toContainEqual({ key: 'editlens.permission_mode', value: 'Auto' })
  await ui.unmount()
})

test('a refused permission mode change shows why', { options: { permission_mode: 'Plan' } }, async ($, on) => {
  stubs(on, SUMMARY, { manifest: FULL, configSet: () => ({ deny: 'Blocked by your policy' }) })
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  await ui.press({ key: 'set-permission_mode' })
  expect(toasts).toContain("✦ ✕ Couldn't change Permission mode · your admin's policy blocks it")
  await ui.unmount()
})
