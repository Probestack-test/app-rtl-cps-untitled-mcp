import assert from 'node:assert/strict';
import { prompts, resources, tools } from '../dist/catalog.js';
import { invokeToolForTest } from '../dist/server.js';
assert.ok(Array.isArray(tools)); assert.ok(Array.isArray(resources)); assert.ok(Array.isArray(prompts));
for (const name of ["current_time"]) await invokeToolForTest(name, { name: 'ForgeSphere' });
console.log('verified generated MCP catalog module');
