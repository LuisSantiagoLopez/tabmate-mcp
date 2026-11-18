# tabmate-mcp

Every website, an MCP server.

[Tabmate](https://github.com/LuisSantiagoLopez/tabmate) is a Chrome extension that learns the tasks you repeat in the browser. This package lets Claude run them.

## Set up

1. Install the Tabmate extension.
2. Click the Tabmate icon. Under **Claude**, click **Copy**.
3. Paste in Terminal:

   ```bash
   npx -y github:LuisSantiagoLopez/tabmate-mcp install --token <token from the popup>
   ```

4. Restart Claude Desktop. The popup says **Connected to Claude**.

`install` adds a `tabmate` server to Claude Desktop (`claude_desktop_config.json`) and Claude Code (`~/.claude.json`). It backs up each file first, skips apps you don't have, never writes a file it can't read, and never touches other servers. Use `--only desktop` or `--only code` to pick one. `npx -y github:LuisSantiagoLopez/tabmate-mcp uninstall` removes it.

## Tools

- `list_workflows`: what Tabmate learned (name, sites, inputs)
- `run_workflow`: `{ workflow, inputs?, max_rows? }`
- one tool per learned workflow, with an input schema built from the values that change

Runs happen in your Chrome with Tabmate's safety rules: password and card fields, and pay, delete or transfer buttons, wait for you.

## Security

- Listens on `127.0.0.1` only (ports 47821 to 47830).
- Accepts a WebSocket only from a `chrome-extension://` origin, with a local `Host` header (blocks web pages and DNS rebinding).
- Both sides prove they hold the pairing token with an HMAC challenge. The token is never sent.
- No token, no start.

MIT license.
