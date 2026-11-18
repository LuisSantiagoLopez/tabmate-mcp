// tabmate-mcp: an MCP server (stdio) that exposes the workflows Tabmate learned as tools.
'use strict';
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { ExtensionLink } = require('./link');
const VERSION = require('../package.json').version;

const CONNECT_WAIT_MS = 35000; // the extension looks for us every 30 seconds
const NOT_CONNECTED = 'Tabmate is not connected. Open Chrome with the Tabmate extension, click the Tabmate icon, and turn on "Connect to Claude".';

const BUILT_IN = [
  {
    name: 'list_workflows',
    description: 'List the browser workflows Tabmate learned by watching the person (name, sites, inputs). Each one is also its own tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_workflow',
    description: 'Run a learned Tabmate workflow in the person\'s Chrome. Tabmate opens or focuses the right tabs, fills values from the page, and stops for passwords, card fields and pay/delete/transfer buttons.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Tool name or id from list_workflows.' },
        inputs: { type: 'object', description: 'Values for the workflow inputs. Leave out to use the last values.', additionalProperties: true },
        max_rows: { type: 'integer', minimum: 1, maximum: 500, description: 'For list workflows: most rows to process.' },
      },
      required: ['workflow'],
      additionalProperties: false,
    },
  },
];

function text(obj, isError) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], isError: !!isError };
}

function summary(res) {
  if (res.status === 'done') {
    const rows = res.rows > 1 ? res.rows + ' rows' : res.steps + ' steps';
    return 'Done: ' + res.workflow + ' (' + rows + (res.note ? ', ' + res.note : '') + ').';
  }
  if (res.status === 'running') return 'Started ' + res.workflow + '. ' + res.reason + '.';
  if (res.status === 'stopped') return 'The person stopped ' + res.workflow + '.';
  return 'Could not finish ' + (res.workflow || 'the workflow') + ': ' + (res.reason || 'unknown error') + '.';
}

async function startServer({ token = process.env.TABMATE_TOKEN, ports, extensionId = process.env.TABMATE_EXTENSION_ID || '' } = {}) {
  const link = new ExtensionLink({ token, ports, extensionId });
  await link.listen();
  const server = new Server({ name: 'tabmate', version: VERSION }, { capabilities: { tools: { listChanged: true } } });
  let tools = [];

  async function refresh() {
    if (!link.connected) { tools = []; return tools; }
    try { tools = await link.request('list', {}, 10000); } catch (e) { tools = []; }
    return tools;
  }
  const notify = () => refresh().then(() => server.sendToolListChanged().catch(() => {}));
  link.on('connected', notify);
  link.on('changed', notify);
  link.on('disconnected', notify);

  server.oninitialized = () => {
    const info = server.getClientVersion && server.getClientVersion();
    const n = String((info && info.name) || 'Claude');
    link.setClientName(/desktop/i.test(n) ? 'Claude Desktop' : /code/i.test(n) ? 'Claude Code' : n);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const learned = (await refresh()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    return { tools: BUILT_IN.concat(learned) };
  });

  async function run(params) {
    if (!(await link.waitConnected(CONNECT_WAIT_MS))) return text(NOT_CONNECTED, true);
    const res = await link.request('run', params, 125000);
    return text(summary(res) + '\n\n' + JSON.stringify(res, null, 2), res.status === 'error');
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments || {};
    try {
      if (name === 'list_workflows') {
        if (!(await link.waitConnected(CONNECT_WAIT_MS))) return text(NOT_CONNECTED, true);
        const list = (await refresh()).map((t) => ({ tool: t.name, id: t.id, description: t.description, sites: t.sites, loop: t.loop, inputs: t.inputSchema.properties }));
        return text(list.length ? list : 'No workflows yet. Do a task twice in Chrome and Tabmate learns it.');
      }
      if (name === 'run_workflow') {
        if (typeof args.workflow !== 'string' || !args.workflow) return text('Say which workflow to run (see list_workflows).', true);
        return run({ workflow: args.workflow, inputs: args.inputs && typeof args.inputs === 'object' ? args.inputs : {}, max_rows: args.max_rows });
      }
      if (!link.connected) await link.waitConnected(CONNECT_WAIT_MS);
      const known = (tools.length ? tools : await refresh()).find((t) => t.name === name);
      if (!known) return text('Unknown tool: ' + name + '. Call list_workflows.', true);
      const { max_rows: maxRows, ...inputs } = args;
      return run({ workflow: name, inputs, max_rows: maxRows });
    } catch (e) {
      return text(String(e.message || e), true);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => { link.close(); process.exit(0); };
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return { server, link };
}

module.exports = { startServer, summary };
