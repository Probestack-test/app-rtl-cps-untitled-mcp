import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { prompts, resources, tools, upstreamBaseUrl } from './catalog.js';
import { tracer } from './telemetry.js';
import { logError } from './logger.js';


type Arguments = Record<string, unknown>;
let consecutiveFailures = 0; let circuitOpenUntil = 0;
const retryEnabled = true; const circuitEnabled = false; const timeoutEnabled = true;
const upstreamAuth: string = 'NONE'; const upstreamApiKeyHeader = 'X-API-Key';
let cachedToken: { value: string; expiresAt: number } | undefined;
function value(args: Arguments, name: string): unknown { return args[name]; }
function encode(v: unknown): string { return encodeURIComponent(String(v)); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function invokeBuiltin(tool: any, args: Arguments): unknown {
  const binding = tool.builtin;
  switch (binding.operation) {
    case 'ECHO': return value(args, String(binding.argument));
    case 'CONSTANT': return binding.value;
    case 'TEMPLATE': return String(binding.template).replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g,
      (_match: string, name: string) => String(value(args, name) ?? ''));
    case 'CURRENT_TIME': return { timestamp: new Date().toISOString() };
    default: throw new Error(`Unsupported builtin operation ${String(binding.operation)}`);
  }
}

async function invokeDatabase(_tool: any, _args: Arguments): Promise<unknown> {
  throw new Error('This bundle was not generated with database support');
}


async function upstreamAuthHeaders(): Promise<Record<string, string>> {
  if (upstreamAuth === 'NONE') return {};
  if (upstreamAuth === 'API_KEY') {
    const value = process.env.UPSTREAM_API_KEY;
    if (!value) throw new Error('UPSTREAM_API_KEY is required');
    return { [upstreamApiKeyHeader]: value };
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return { authorization: `Bearer ${cachedToken.value}` };
  const clientId = process.env.UPSTREAM_CLIENT_ID; const clientSecret = process.env.UPSTREAM_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('UPSTREAM_CLIENT_ID and UPSTREAM_CLIENT_SECRET are required');
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  const scopes = ''; if (scopes) form.set('scope', scopes);
  const response = await fetch('', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` }, body: form,
    signal: timeoutEnabled ? AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS ?? 10000)) : undefined });
  if (!response.ok) throw new Error(`Upstream token endpoint returned ${response.status}`);
  const token = await response.json() as { access_token?: string; expires_in?: number };
  if (!token.access_token) throw new Error('Upstream token response has no access_token');
  cachedToken = { value: token.access_token, expiresAt: Date.now() + Number(token.expires_in ?? 300) * 1000 };
  return { authorization: `Bearer ${cachedToken.value}` };
}

async function invokeConnector(tool: any, args: Arguments): Promise<unknown> {
  const connector = tool.connector;
  const request = connector.request;
  let path = request.path as string;
  for (const name of request.pathParams ?? []) path = path.replace(`{${name}}`, encode(value(args, name)));
  const url = new URL(path);
  for (const binding of request.query ?? []) if (value(args, binding.arg) !== undefined)
    url.searchParams.set(binding.name, String(value(args, binding.arg)));
  // No token is required for providers/operations that allow unauthenticated access
  // (e.g. GitHub's public-repo reads); the upstream API rejects the call itself,
  // with a clear status, when a token actually is needed.
  const token = process.env[`CONNECTOR_${connector.provider}_TOKEN`];
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  // GitHub's REST API requires this versioned Accept header and recommends pinning the
  // API version explicitly; every other provider ignores both.
  if (connector.provider === 'GITHUB') {
    headers.accept = 'application/vnd.github+json';
    headers['x-github-api-version'] = '2022-11-28';
  }
  for (const binding of request.headers ?? []) if (value(args, binding.arg) !== undefined)
    headers[binding.name] = String(value(args, binding.arg));
  const bodyValue = request.bodyArg ? value(args, request.bodyArg) : undefined;
  let body: string | undefined;
  // Stripe's API only accepts form-encoded bodies; every other connector here uses JSON.
  if (bodyValue !== undefined && connector.provider === 'STRIPE') {
    const form = new URLSearchParams();
    for (const [key, entryValue] of Object.entries(bodyValue as Record<string, unknown>))
      if (entryValue !== undefined) form.set(key, String(entryValue));
    body = form.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (bodyValue !== undefined) {
    body = JSON.stringify(bodyValue);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(url, { method: request.method, headers, body });
  const text = await response.text();
  let data: unknown = text; try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!response.ok) throw new Error(`Connector ${connector.provider} ${response.status}: ${text.slice(0, 500)}`);
  return data;
}

async function invoke(tool: any, args: Arguments): Promise<unknown> {
  if (tool.bindingType === 'BUILTIN') return invokeBuiltin(tool, args);
  if (tool.bindingType === 'DATABASE') return invokeDatabase(tool, args);
  if (tool.bindingType === 'CONNECTOR_SDK') return invokeConnector(tool, args);
  if (tool.bindingType !== 'HTTP') throw new Error(`Unsupported binding ${String(tool.bindingType)}`);
  if (circuitEnabled && Date.now() < circuitOpenUntil) throw new Error('Upstream circuit is open');
  let path = tool.http.path as string;
  for (const name of tool.http.pathParams ?? []) path = path.replace(`{${name}}`, encode(value(args, name)));
  const relativePath = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(relativePath, upstreamBaseUrl.endsWith('/') ? upstreamBaseUrl : upstreamBaseUrl + '/');
  for (const binding of tool.http.query ?? []) if (value(args, binding.arg) !== undefined)
    url.searchParams.set(binding.name, String(value(args, binding.arg)));
  const headers: Record<string, string> = { accept: 'application/json', ...await upstreamAuthHeaders() };
  for (const binding of tool.http.headers ?? []) if (value(args, binding.arg) !== undefined)
    headers[binding.name] = String(value(args, binding.arg));
  const body = tool.http.bodyArg && value(args, tool.http.bodyArg) !== undefined
    ? JSON.stringify(value(args, tool.http.bodyArg)) : undefined;
  if (body) headers['content-type'] = 'application/json';
  const attempts = retryEnabled ? Number(process.env.UPSTREAM_MAX_ATTEMPTS ?? 3) : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = timeoutEnabled
      ? setTimeout(() => controller.abort(), Number(process.env.UPSTREAM_TIMEOUT_MS ?? 10000)) : undefined;
    try {
      const response = await fetch(url, { method: tool.http.method, headers, body, signal: controller.signal });
      const text = await response.text();
      let data: unknown = text; try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!response.ok) throw new Error(`Upstream ${response.status}: ${text.slice(0, 500)}`);
      consecutiveFailures = 0; return data;
    } catch (error) {
      consecutiveFailures++;
      if (circuitEnabled && consecutiveFailures >= Number(process.env.UPSTREAM_BREAKER_THRESHOLD ?? 5))
        circuitOpenUntil = Date.now() + Number(process.env.UPSTREAM_BREAKER_RESET_MS ?? 30000);
      if (attempt + 1 >= attempts) throw error;
      await delay(100 * (2 ** attempt));
    } finally { if (timer) clearTimeout(timer); }
  }
  throw new Error('Upstream invocation exhausted all attempts');
}

export async function invokeToolForTest(name: string, args: Arguments): Promise<unknown> {
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  return invoke(tool, args);
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'untitled', version: '1.0.0' });
  for (const tool of tools) server.registerTool(tool.name, {
    description: tool.description,
    inputSchema: fromJsonSchema(tool.inputSchema),
    ...(tool.outputSchema && Object.keys(tool.outputSchema).length
      ? { outputSchema: fromJsonSchema(tool.outputSchema) } : {})
  }, async (args: unknown) => tracer.startActiveSpan(`mcp.tool.${tool.name}`, async span => {
    try {
      const result = await invoke(tool, (args ?? {}) as Arguments);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { result } };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Tool invocation failed';
      const message = true ? 'Tool invocation failed' : rawMessage;
      logError('tool_call_failed', { tool: tool.name, message });
      return { isError: true, content: [{ type: 'text' as const, text: message }] };
    } finally { span.end(); }
  }));
  for (const resource of resources) server.registerResource(resource.name, resource.uri, {
    description: resource.description,
    mimeType: resource.mimeType
  }, async (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: resource.mimeType, text: resource.text }] }));
  for (const prompt of prompts) {
    const properties = Object.fromEntries((prompt.arguments ?? []).map((arg: any) =>
      [arg.name, { type: 'string', description: arg.description }]));
    const required = (prompt.arguments ?? []).filter((arg: any) => arg.required).map((arg: any) => arg.name);
    server.registerPrompt(prompt.name, {
      description: prompt.description,
      argsSchema: fromJsonSchema({ type: 'object', properties, required, additionalProperties: false })
    }, async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const text = String(prompt.template).replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g,
        (_match: string, name: string) => String(args[name] ?? ''));
      return { description: prompt.description, messages: [{ role: prompt.role,
        content: { type: 'text' as const, text } }] };
    });
  }
  return server;
}
