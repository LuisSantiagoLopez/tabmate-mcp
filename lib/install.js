// `npx tabmate-mcp install --token <token>`: adds Tabmate to Claude Desktop and Claude Code.
// Rules: back up every file before changing it, only touch the "tabmate" entry,
// never write a file we could not parse, and skip apps that are not installed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const VERSION = require('../package.json').version;

const SERVER_NAME = 'tabmate';
const TOKEN_RE = /^[a-f0-9]{32,128}$/;

function desktopConfigPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

function codeConfigPath(home = os.homedir()) {
  return path.join(home, '.claude.json');
}

// How Claude should start this server. From npx: through npx. From a checkout: this exact file.
function launchCommand(binPath = path.join(__dirname, '..', 'bin', 'tabmate-mcp.js')) {
  if (/[\\/]_npx[\\/]/.test(binPath)) return { command: 'npx', args: ['-y', 'tabmate-mcp@' + VERSION] };
  return { command: process.execPath, args: [path.resolve(binPath)] };
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function readJson(file) {
  if (!fs.existsSync(file)) return { data: {}, existed: false };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { data: {}, existed: true };
  const data = JSON.parse(raw); // throws on bad JSON: caller skips the file
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
  return { data, existed: true };
}

function writeJsonSafely(file, data, existed) {
  let backup = '';
  let mode = 0o600;
  if (existed) {
    backup = file + '.tabmate-backup-' + stamp();
    fs.copyFileSync(file, backup);
    mode = fs.statSync(file).mode & 0o777;
  }
  const tmp = file + '.tabmate-tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  return backup;
}

// Changes one config file. Returns { app, file, status: added|updated|removed|skipped|error, backup, reason }.
function editConfig(app, file, change, appDir) {
  if (!fs.existsSync(file) && !fs.existsSync(appDir)) return { app, file, status: 'skipped', reason: app + ' not found' };
  let doc;
  try { doc = readJson(file); } catch (e) {
    return { app, file, status: 'error', reason: 'could not read it as JSON, left it alone (' + e.message + ')' };
  }
  const servers = doc.data.mcpServers && typeof doc.data.mcpServers === 'object' ? doc.data.mcpServers : {};
  const had = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  const next = change(Object.assign({}, servers[SERVER_NAME] || {}));
  if (next === undefined && !had) return { app, file, status: 'skipped', reason: 'Tabmate was not there' };
  const merged = Object.assign({}, servers);
  if (next === undefined) delete merged[SERVER_NAME]; else merged[SERVER_NAME] = next;
  doc.data.mcpServers = merged;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = writeJsonSafely(file, doc.data, doc.existed);
  return { app, file, status: next === undefined ? 'removed' : had ? 'updated' : 'added', backup };
}

function targets({ home = os.homedir(), env = process.env, platform = process.platform, only = '' } = {}) {
  const desktop = desktopConfigPath(env, platform, home);
  const list = [
    { app: 'Claude Desktop', key: 'desktop', file: desktop, appDir: path.dirname(desktop), extra: {} },
    { app: 'Claude Code', key: 'code', file: codeConfigPath(home), appDir: path.join(home, '.claude'), extra: { type: 'stdio' } },
  ];
  return only ? list.filter((t) => t.key === only) : list;
}

function install({ token, only, home, env, platform, launch = launchCommand() }) {
  if (!TOKEN_RE.test(String(token || ''))) throw new Error('Pass the pairing token from the Tabmate popup: npx tabmate-mcp install --token <token>');
  return targets({ home, env, platform, only }).map((t) =>
    editConfig(t.app, t.file, () => Object.assign({}, t.extra, { command: launch.command, args: launch.args, env: { TABMATE_TOKEN: token } }), t.appDir));
}

function uninstall({ only, home, env, platform } = {}) {
  return targets({ home, env, platform, only }).map((t) => editConfig(t.app, t.file, () => undefined, t.appDir));
}

module.exports = { install, uninstall, desktopConfigPath, codeConfigPath, launchCommand, SERVER_NAME };
