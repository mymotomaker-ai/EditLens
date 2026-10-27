'use strict';
// /editlens help, grouped by when you need each command. A test checks that the editlens-guide
// skill covers every command here.
const GROUPS = [
  ['Everyday', [
    ['/editlens', 'connect your page'],
    ['/editlens 3000', 'connect the dev server on a port'],
    ['/editlens new', 'no app yet: make a starter page'],
    ['/editlens control', 'run Claude from the page'],
    ['/editlens manual', 'run Claude here'],
    ['/editlens stop', 'disconnect'],
    ['/editlens undo', 'recent edits: undo one, or restore its file'],
    ['/editlens undo N', 'undo only edit N (back: put it back)'],
    ['/editlens restore N', 'the whole file from before edit N'],
    ['/editlens effort', 'Claude\'s effort level: low … max'],
  ]],
  ['Info', ['details', 'agents', 'sessions', 'status', 'settings', 'usage', 'line', 'restart']],
  ['Other computers', ['pair', 'join', 'task-user']],
];

const MORE = {
  3000: '/editlens 3000 connects the dev server on that port. Also /editlens http://localhost:5173, or /editlens <folder> for the app in a folder one level down.',
  new: '/editlens new makes a starter page (index.html) in a folder that has no app yet, then connects it. It never replaces a file, and only you can run it: Claude can only suggest it. It is not made in your home folder, a system folder or a folder with more than 20 files that are not web files: make a folder for the site first (mkdir my-site), open Claude Code there, then type /editlens new.',
  stop: '/editlens stop disconnects (your own dev server keeps running). /editlens stop remove also removes marked EditLens lines. /editlens stop <name> stops the running page control session or task with that name in /editlens sessions; only you can type it.',
  control: '/editlens control runs Claude from the panel on your page. control new starts a new chat; control <name> runs Claude on a paired computer. Claude runs from the page in one project at a time: when it runs in another one, control take ends it there (that page switches to Manual, and a reply in progress stops) and starts it here; control <name> take does the same on a paired computer. When no page is open there and Claude is not working, control moves it by itself.',
  manual: '/editlens manual runs Claude here again. manual <name>: on a paired computer.',
  undo: '/editlens undo lists this session\'s recent edits, numbered as on the page. /editlens undo N undoes only edit N and keeps later changes; /editlens undo N back puts it back. When a later edit changed the same lines, EditLens gives you a message for Claude instead.',
  restore: '/editlens restore N puts the whole file back as it was before edit N; later changes to it are undone too. /editlens restore N back undoes the restore.',
  effort: '/editlens effort shows Claude\'s effort level: page control now, what new tasks use (the Effort setting), this terminal (set with /effort here; EditLens never changes it) and each running task. /editlens effort low|medium|high|xhigh|max changes page control from Claude\'s next step and saves the Effort setting, except Max: it lasts for the page control session running now and is never saved, so a new session starts at the saved level. /editlens effort auto (the default) follows the level set with /effort in Claude Code. Your organization\'s settings can allow less.',
  details: '/editlens details shows Manual or page control, the page, agents and token use.',
  agents: '/editlens agents lists Main, its subagents and the tasks on paired computers, with what each working one is doing: computer, model, effort, mode and when it started. In the Details pane (/editlens details), arrow keys pick one to follow on your page or stop.',
  sessions: '/editlens sessions lists page control\'s sessions and this project\'s tasks, here and on paired computers. Arrow keys pick one: it shows the command that continues it in Claude Code (claude --resume, never run for you), then Open, Stop and Rename. The desktop app may not list these sessions.',
  status: '/editlens status shows what is connected, and EditLens lines in your files.',
  settings: '/editlens settings shows the settings (also in /config: search "editlens").',
  usage: '/editlens usage shows the status line that puts exact context, cost and plan limits in the panel.',
  line: '/editlens line hides or shows the line above the prompt.',
  restart: '/editlens restart replaces the running EditLens with the newest installed one now, instead of waiting until page control stops, then does what /editlens does (page control too when the setting What /editlens does says so). Page control that was running starts again in the same conversation when its page reconnects; a paired computer\'s running task stops.',
  pair: '/editlens pair pairs another computer with this one: it prints the line to type there, and the same line with --key "<path of your key file>" for a key file ssh doesn\'t use by itself. pair open is for a direct join without SSH (open the pairing port in the firewall yourself). pair off ends every pairing.',
  join: '/editlens join lists paired computers. join <address> <code> pairs (add --key "<path of your key file>" when ssh needs one); join off unpairs. join off <name> also removes a computer that joined this one.',
  'task-user': '/editlens task-user (on a root server) makes paired computers\' tasks run as a normal account. task-user status checks it; task-user off undoes it.',
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
