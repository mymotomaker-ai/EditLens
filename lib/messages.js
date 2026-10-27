'use strict';
const { PRODUCT_NAME } = require('./name');
// How page messages are worded for Claude (Stop / UserPromptSubmit hooks).

const { formatAttachments } = require('./attachments');
const { describeShots } = require('./screenshots');

function formatMessages(list) {
  const quoted = list
    .map((m) =>
      m.command
        ? `> Run the \`/${m.command.name}\` command${m.command.args ? ` with arguments: ${m.command.args.replace(/\n/g, ' ')}` : ''} ` +
          '(use your Skill tool; the user picked it in the panel\'s command palette).'
        : '> ' + m.text.replace(/\n/g, '\n> ') + (m.attachments && m.attachments.length ? `\n\n${formatAttachments(m.attachments, m.text)}` : '') +
          (m.images && m.images.length ? `\n\n${describeShots(m.images)}` : ''),
    )
    .join('\n\n');
  return (
    `The user sent ${list.length === 1 ? 'this message' : 'these messages'} from the ${PRODUCT_NAME} panel on the page they are developing ` +
    `(your replies are shown in that panel):\n\n${quoted}`
  );
}

module.exports = { formatMessages };
