# Contributing to EditLens

Thanks for helping. Bug reports, ideas, and pull requests are welcome.

## Report a bug

1. Check the [open issues](https://github.com/mymotomaker-ai/editlens/issues) first.
2. [Open a new issue](https://github.com/mymotomaker-ai/editlens/issues/new/choose) and choose **Bug report**.
3. Add the EditLens version, your operating system, and the logs from `~/.claude/editlens/`.

Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

## Make a change

1. Fork the repository and create a branch.
2. Install Node.js 18 or later. EditLens has no npm dependencies to install.
3. Load your copy in Claude Code: `claude --plugin-dir /path/to/editlens`
4. Write a test that fails without your change, in `test/`.
5. Make the change.
6. Run the tests: `npm test`
7. Run `claude plugin validate --strict .`
8. Open a pull request and fill in the template.

The test setup, the preview scripts, and the end-to-end runs are in [docs/development.md](docs/development.md).

## Guidelines

- **Keep it local.** EditLens sends nothing to its author. Don't add analytics, tracking, or new network calls.
- **Disclose what it runs.** If your change runs a new process, opens a port, or reads a new file, add it to [What EditLens runs and reads](README.md#what-editlens-runs-and-reads).
- **Use plain words.** User-facing text uses short, common words and no figures of speech. Use sentence-style capitalization.
- **Match the code around you.** Same naming, same comment style, short and literal comments.
- **No bare catch blocks.** Handle or log each error.
- **One change per pull request.**

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part, you agree to follow it.
