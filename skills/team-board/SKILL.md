---
name: team-board
description: Coordinate parallel subagents through the shared team board (claims, notes, findings). Use when splitting work across two or more subagents, or when merging what they found.
---

# Working as a team through the board

The EditLens plugin gives you and every subagent in this project one shared board, shown live
in the browser panel's Team tab. Each entry is tagged with the agent that wrote it.

Tools (from the `live-page` MCP server):

- `read_board` — open claims plus recent notes and findings. Pass `since` to get only new ones.
- `claim_task` — reserve a part of the work and the files it touches. Refused if another agent
  already claimed overlapping work.
- `complete_task` — close a claim with a one-line result (or `status: "dropped"`).
- `share_finding` — a file, a line range and a note. The user can click it to open those lines.
- `post_note` — a note, question, answer, decision or blocker. `reply_to` makes it a reply.

## When you delegate

1. Split the work into parts that touch different files. Give each subagent one part.
2. In each subagent's prompt, name its part and say which files are someone else's. Subagents are
   already told about the board when they start; you don't need to explain the tools.
3. When several subagents research at the same time, ask each subagent to put what it finds on the board with
   `share_finding` and keep its final reply short.
4. While they run, or after they finish, call `read_board` and use their findings and
   decisions instead of asking them to repeat everything.
5. Answer questions they posted (`post_note` with `kind: "answer"` and `reply_to`) when a later
   subagent will need the answer.

## Good posts

- One to three sentences. Name files and lines rather than pasting code.
- Decisions others must follow (an API shape, a naming rule) go in `post_note` with
  `kind: "decision"`.
- If you can't continue without something, post a `blocker`.
- Close your claims. Claims still open when a subagent finishes are released automatically.
