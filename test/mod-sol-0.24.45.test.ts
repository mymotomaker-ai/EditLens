// Sol scan of 0.24.45, L11 and L12, and G1 of the signed-in settings check, in the EditLens mod
// (hooks/mod.mjs), each a check that failed on 0.24.45. Run with `claude plugin test`.
import { expect, mock, test } from 'claude-code/testing'
import { totalTokens, bandItems } from '../hooks/mod.mjs'

const SUMMARY = {
  live: true, version: '0.24.14', sessionId: 's1', control: 'manual', state: 'idle', mode: 'default', model: 'claude-opus-5-5',
  pages: [], pageCount: 0, agents: [], agentCount: 0, agentsRunning: 0,
  tokens: { context: 48000, window: 200000, percent: 24, main: 1200, subagents: 400, costUSD: null },
  permissions: 0, connection: null, integrations: [],
}
const BAND = {
  plugin: 'editlens', component: 'AbovePrompt', requestId: 'band', viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 158, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const MANIFEST = JSON.stringify({ name: 'editlens', version: '0.24.33', userConfig: {} })
const ok = (body) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })

// Claude Code's side for a session: env has the variables the mod reads.
function stubs(on, env = {}) {
  const clock = mock.clock(on)
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', ($2, e) => ({ value: e.name === 'HOME' ? '/home/u' : env[e.name] }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('fs.read', ($2, e) => (/plugin\.json$/.test(e.path) ? { value: MANIFEST } : /token-4317$/.test(e.path) ? { value: 'tok\n' } : { deny: 'ENOENT' }))
  on('fs.write', () => ({ value: undefined }))
  on('config.set', ($2, e) => ({ value: e.value }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  return clock
}

// L11: two token counts that are each finite added up to Infinity.
test('L11: a token total past the largest number is unknown, not Infinity', () => {
  expect(totalTokens({ tokens: { main: 1e308, subagents: 1e308 } })).toBeNull()
  expect(totalTokens({ tokens: { main: 1200, subagents: 400 } })).toBe(1600)
})

// L12: while the server held a request, the 2 s local refresh drew the line without this plugin's
// version, so "0.24.33 installed, 0.24.14 running" went away until the answer came.
test('L12: the update note stays on the line while a request is held', async ($, on) => {
  const clock = stubs(on)
  let n = 0
  on('http.fetch', ($2, e) => {
    if (e.init && e.init.method === 'POST') return ok({ ok: true })
    if (!/\/summary\?/.test(e.url)) return { deny: 'ENOENT' }
    n++
    // The first answer immediately; the second held for 20 s.
    return n === 1 ? ok({ ...SUMMARY, seq: 7, changed: true }) : clock.sleep(20000).then(() => ok({ ...SUMMARY, seq: 8, changed: true }))
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /0\.24\.33 installed/ })).toBeDefined()
  // The held request starts, and ticks while it is held refresh only this session's numbers.
  for (let i = 0; i < 4; i++) await clock.advance(2000)
  expect(n).toBe(2)
  expect(await ui.find({ type: 'Text', text: /0\.24\.33 installed/ })).toBeDefined()
  expect(bandItems({ s: { ...SUMMARY, pluginVersion: '0.24.33' }, cols: 160 }).some((i) => i.id === 'update')).toBe(true)
})

// G1 (signed-in settings check): the own Claude of a task or of page control reported its default
// settings, which replaced the user's Tasks at once and effort. Its mod reports none now.
test('G1: the mod of a Claude EditLens started reports no settings', async ($, on) => {
  stubs(on, { EDITLENS_DRIVEN: '1' })
  const posts = []
  on('http.fetch', ($2, e) => {
    if (e.init && e.init.method === 'POST') {
      posts.push(e.url)
      return ok({ ok: true })
    }
    return /\/summary\?/.test(e.url) ? ok({ ...SUMMARY, seq: 7, changed: true }) : { deny: 'ENOENT' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(posts.filter((u) => /\/settings\/report$/.test(u))).toEqual([])
})

test('G1: the mod of a Claude the user started still reports its settings', async ($, on) => {
  stubs(on)
  const posts = []
  on('http.fetch', ($2, e) => {
    if (e.init && e.init.method === 'POST') {
      posts.push(e.url)
      return ok({ ok: true })
    }
    return /\/summary\?/.test(e.url) ? ok({ ...SUMMARY, seq: 7, changed: true }) : { deny: 'ENOENT' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(posts.filter((u) => /\/settings\/report$/.test(u)).length).toBe(1)
})
