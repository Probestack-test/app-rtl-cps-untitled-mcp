import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const provider: string = 'CONSOLE';
const destination: string = 'CONSOLE';
const logFile = process.env.LOG_FILE ?? 'logs/mcp-server.log';
function emit(level: string, event: string, fields: Record<string, unknown>): string {
  if (true || provider === 'GCP') return JSON.stringify({ severity: level === 'error' ? 'ERROR' : level.toUpperCase(),
    timestamp: new Date().toISOString(), event, ...fields });
  return `${new Date().toISOString()} ${level.toUpperCase()} ${event} ${JSON.stringify(fields)}`;
}
export function logError(event: string, fields: Record<string, unknown>): void {
  const line = emit('error', event, fields);
  if (destination !== 'FILE') console.error(line);
  if (destination !== 'CONSOLE') { mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, line + '\n', { encoding: 'utf8' }); }
}
