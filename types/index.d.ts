// The values EditLens's mod (hooks/mod.mjs) has Claude Code keep for a session ($.state):
// they stay through a reload of the mod, and end with the Claude Code process.
// port: the port this Claude Code started with (a Port setting changed later applies after a restart).
export type EditlensPort = number

declare module 'claude-code' {
  interface PluginState {
    editlens: { port: EditlensPort }
  }
}
