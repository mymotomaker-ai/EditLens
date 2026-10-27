# Security policy

## Report a vulnerability

Report security problems privately. Don't open a public issue.

- **GitHub:** Go to the **Security** tab of this repository, and then select **Report a vulnerability**.
- **Email:** Send the report to mymotomaker@gmail.com with "EditLens security" in the subject.

Include:

- The EditLens version (run `/plugin` in Claude Code to see it)
- What happens, and what you expected
- The steps to make it happen

We reply within 7 days, and we tell you when a fix is released.

## Supported versions

Only the latest version receives fixes. To update, run these in Claude Code, and then restart it:

```
/plugin marketplace update editlens
/plugin update editlens@editlens
```

## What EditLens protects

[docs/security.md](docs/security.md) describes what the local server accepts and from where. [What EditLens runs and reads](README.md#what-editlens-runs-and-reads) lists every process, port, and file it uses.
