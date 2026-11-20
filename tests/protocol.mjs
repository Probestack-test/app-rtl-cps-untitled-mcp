import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const client = new Client({ name: 'generated-protocol-test', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/stdio.js'], stderr: 'pipe' }));
if (true) assert.equal((await client.listTools()).tools.length, 1, 'tools/list must return the generated catalog');
if (true) assert.equal((await client.listResources()).resources.length, 1);
if (true) assert.equal((await client.listPrompts()).prompts.length, 1);
await client.close();
console.log('verified generated MCP capabilities over stdio');
