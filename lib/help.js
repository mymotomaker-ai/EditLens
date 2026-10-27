'use strict';
// /editlens help, grouped by when you need each command. A test checks that the editlens-guide
// skill covers every command here.
const GROUPS = [
  ['Everyday', [
    ['/editlens', 'connect your page'],
    ['/editlens 3000', 'connect the dev server on a port'],
    ['/editlens new', 'no app yet: create a starter page'],
    ['/editlens control', 'use Claude from the page'],
    ['/editlens manual', 'use Claude here only'],
    ['/editlens stop', 'disconnect'],
    ['/editlens undo', 'list recent changes to undo'],
    ['/editlens undo N', 'undo only change N'],
    ['/editlens restore N', 'restore the file from before change N'],
    ['/editlens effort', 'Claude\'s effort level: low to max'],
  ]],
  ['Info', ['details', 'agents', 'sessions', 'status', 'settings', 'usage', 'line', 'restart']],
  ['Other computers', ['pair', 'join', 'task-user']],
];

const MORE = {
  3000: '/editlens 3000 connects the dev server on port 3000. You can also enter an address, such as /editlens http://localhost:5173, or a folder: /editlens <folder>.',
  new: '/editlens new creates a starter page (index.html) in a folder that has no app yet, and connects it. It never replaces a file. Only you can run it. It doesn\'t run in your home folder, a system folder, or a folder with more than 20 files that aren\'t web files. To start, create a folder (mkdir my-site), open Claude Code there, and enter /editlens new.',
  stop: '/editlens stop disconnects. Your own dev server keeps running. /editlens stop remove also removes the EditLens lines marked in your files. /editlens stop <name> stops the page control session or task with that name. Only you can enter it.',
  control: '/editlens control lets you use Claude from the panel on your page. control new starts a new conversation. control <name> uses Claude on a paired computer. Page control runs in one project at a time. If it runs in another project, control take moves it here: that page switches to Manual, and any reply in progress there stops. If nobody uses it there, control moves it by itself.',
  manual: '/editlens manual switches to Manual: you use Claude here only, and the page shows what Claude does. manual <name> does the same on a paired computer.',
  undo: '/editlens undo lists the recent changes in this session, with the same numbers as on the page. /editlens undo N undoes only change N and keeps later changes. /editlens undo N back cancels the undo. If a later change changed the same lines, EditLens gives you a message to send to Claude instead.',
  restore: '/editlens restore N puts the whole file back as it was before change N. Later changes to the file are removed too. /editlens restore N back cancels the restore.',
  effort: '/editlens effort shows Claude\'s effort level: for page control now, for new tasks (the Effort setting), for this terminal, and for each running task. To change it, enter /editlens effort low|medium|high|xhigh|max. This saves the Effort setting, except Max, which is used for the current page control session only. /editlens effort auto (the default) uses the level set with /effort in Claude Code. Your organization\'s settings can allow less.',
  details: '/editlens details shows Manual or page control, the page, the agents, and token use.',
  agents: '/editlens agents lists all agents: Main, its subagents, and the tasks on paired computers. For each working agent, it shows the computer, model, effort, mode, and start time. In /editlens details, use the arrow keys to select an agent to follow or stop.',
  sessions: '/editlens sessions lists page control\'s sessions and this project\'s tasks, on this computer and on paired computers. Use the arrow keys to select one. It shows the command that continues it in Claude Code (claude --resume), and Open, Stop, and Rename. The desktop app may not list these sessions.',
  status: '/editlens status shows what is connected, and the EditLens lines in your files.',
  settings: '/editlens settings shows the settings. They are also in /config: search for "editlens".',
  usage: '/editlens usage shows the status line to add to Claude Code, to see exact context, cost, and plan limits in the panel.',
  line: '/editlens line hides or shows the line above the prompt.',
  restart: '/editlens restart starts the newest installed version of EditLens now, and then does what /editlens does. Page control that was running starts again in the same conversation when its page reconnects. A paired computer\'s running task stops.',
  pair: '/editlens pair lets another computer connect to this one. It shows a line to enter on the other computer. Use the second line, with --key "<path of your key file>", if SSH doesn\'t use your key file by default. pair open is for a direct connection without SSH: you open the pairing port in the firewall yourself. pair off ends every pairing.',
  join: '/editlens join lists the paired computers. join <address> <code> pairs with a computer. Add --key "<path of your key file>" if SSH needs one. join off unpairs all of them. join off <name> unpairs one computer, including one that joined this one.',
  'task-user': '/editlens task-user (on a server where Claude Code runs as root) makes paired computers\' tasks run as a normal account, for safety. task-user status shows what is set up. task-user off removes it.',
};

// The command column, as lib/say.js pads a cmd record (the mod draws the same width).
const WIDTH = require('./say').CMD;

const HELP = [
  ...GROUPS.flatMap(([title, items]) => [
    title,
    ...(typeof items[0] === 'string'
      ? ['  /editlens ' + items.join('  ') + (title === 'Other computers' ? '    more: /editlens help pair' : '')]
      : items.map(([cmd, what]) => '  ' + cmd.padEnd(WIDTH) + what)),
  ]),
].join('\n');

// The topic for the word after "help": its first word; any port or local address uses the 3000 topic.
// -> a MORE key, '' for none given, or null when there is no help for it
function topicOf(word) {
  const first = String(word || '').trim().toLowerCase().replace(/^\/?editlens(\s+|$)/, '').split(/\s+/)[0] || '';
  if (!first) return '';
  if (/^\d{1,5}$/.test(first) || /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(first)) return '3000';
  return Object.prototype.hasOwnProperty.call(MORE, first) ? first : null;
}

// Prints the help through lib/say.js. word: one command to say more about.
function sayHelp(say, word) {
  const key = topicOf(word);
  if (key) {
    say.head(null, '', 'help ' + key);
    say.text(MORE[key]);
    return;
  }
  const asked = String(word || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  if (key === null) say.head(null, '', `no help for "${asked}", here are all the commands`);
  else say.head(null, '');
  for (const [title, items] of GROUPS) {
    say.blank();
    say.title(title);
    if (typeof items[0] === 'string') say.cmds(items, title === 'Other computers' ? '/editlens help pair' : '');
    else for (const [cmd, what] of items) say.cmd(cmd, what);
  }
}

module.exports = { HELP, GROUPS, MORE, sayHelp, topicOf };
