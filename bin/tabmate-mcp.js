#!/usr/bin/env node
'use strict';
const VERSION = require('../package.json').version;
const HELP = `tabmate-mcp ${VERSION}: every website, an MCP server.

  npx tabmate-mcp install --token <token>   Add Tabmate to Claude Desktop and Claude Code
        [--only desktop|code]               (the token is in the Tabmate popup, under "Connect to Claude")
  npx tabmate-mcp uninstall                 Remove it again
  tabmate-mcp                               Run the server (Claude does this for you)

Local only: listens on 127.0.0.1 and talks to the Tabmate extension, nothing else.`;

function flag(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] || '' : '';
}

function report(results) {
  for (const r of results) {
    const line = r.status === 'added' || r.status === 'updated' ? 'ok   ' : r.status === 'removed' ? 'ok   ' : r.status === 'error' ? 'FAIL ' : 'skip ';
    console.log(line + r.app + ': ' + r.status + (r.reason ? ' (' + r.reason + ')' : '') + '\n       ' + r.file + (r.backup ? '\n       backup: ' + r.backup : ''));
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return console.log(HELP);
  if (cmd === '--version' || cmd === '-v') return console.log(VERSION);
  if (cmd === 'install' || cmd === 'uninstall') {
    const { install, uninstall } = require('../lib/install');
    const only = flag('only');
    const results = cmd === 'install' ? install({ token: flag('token') || process.env.TABMATE_TOKEN, only }) : uninstall({ only });
    report(results);
    if (results.some((r) => r.status === 'error')) process.exitCode = 1;
    if (cmd === 'install' && results.some((r) => r.status === 'added' || r.status === 'updated')) {
      console.log('\nDone. Restart Claude Desktop (Claude Code picks it up in new sessions).\nThe Tabmate popup says "Connected to Claude" once Claude starts the server.');
    }
    return;
  }
  if (cmd && cmd !== 'serve') { console.error(HELP); process.exitCode = 2; return; }
  const { startServer } = require('../lib/server');
  await startServer();
}

main().catch((e) => { console.error('tabmate-mcp: ' + (e && e.message ? e.message : e)); process.exit(1); });
