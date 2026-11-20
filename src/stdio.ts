import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
const handle = serveStdio(() => createServer());
process.on('SIGTERM', () => { void handle.close(); });
