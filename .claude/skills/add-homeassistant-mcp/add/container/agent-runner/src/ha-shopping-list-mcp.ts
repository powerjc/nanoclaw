/**
 * Home Assistant Shopping List MCP Server
 *
 * Compiled alongside agent-runner and launched as a child process by the SDK.
 * Configuration via environment variables (injected as Docker env vars):
 *   HA_URL    - Base URL (e.g. https://homeassistant.example.com)
 *   HA_TOKEN  - Long-lived access token
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HA_URL = process.env.HA_URL?.replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN;

// --- API helpers ---

interface ShoppingItem {
  id: string;
  name: string;
  complete: boolean;
}

async function haRequest(method: string, path: string, body?: object): Promise<unknown> {
  if (!HA_URL || !HA_TOKEN) throw new Error('Home Assistant not configured. Set HA_URL and HA_TOKEN in .env.');
  const url = `${HA_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : null;
}

function ok(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function fail(text: string) { return { content: [{ type: 'text' as const, text }], isError: true as const }; }
function wrap(fn: () => Promise<ReturnType<typeof ok>>) {
  return fn().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
}

// --- MCP server ---

const server = new McpServer({ name: 'ha-shopping-list', version: '1.0.0' });

server.tool('shopping_list_get_items', 'Get all items on the Home Assistant shopping list', {}, () => wrap(async () => {
  const items = await haRequest('GET', '/api/shopping_list') as ShoppingItem[];
  if (!items?.length) return ok('Shopping list is empty.');
  const pending = items.filter((i) => !i.complete);
  const done = items.filter((i) => i.complete);
  const lines: string[] = [`${items.length} item(s) on shopping list:`];
  if (pending.length) lines.push(...pending.map((i) => `  [ ] ${i.name} (id: ${i.id})`));
  if (done.length) lines.push(...done.map((i) => `  [x] ${i.name} (id: ${i.id})`));
  return ok(lines.join('\n'));
}));

server.tool('shopping_list_add_item', 'Add a single item to the Home Assistant shopping list', {
  name: z.string().describe('Item name to add'),
}, ({ name }) => wrap(async () => {
  const item = await haRequest('POST', '/api/shopping_list/item', { name }) as ShoppingItem;
  return ok(`Added "${item.name}" to shopping list (id: ${item.id}).`);
}));

server.tool('shopping_list_add_items', 'Add multiple items to the Home Assistant shopping list in one call', {
  items: z.array(z.string()).describe('List of item names to add'),
}, ({ items }) => wrap(async () => {
  const results = await Promise.all(
    items.map((name) => haRequest('POST', '/api/shopping_list/item', { name }) as Promise<ShoppingItem>),
  );
  return ok(`Added ${results.length} item(s): ${results.map((r) => r.name).join(', ')}.`);
}));

server.tool('shopping_list_complete_item', 'Mark a shopping list item as purchased/completed', {
  item_id: z.string().describe('Item ID from shopping_list_get_items or shopping_list_find_item'),
}, ({ item_id }) => wrap(async () => {
  await haRequest('POST', `/api/shopping_list/item/${item_id}`, { complete: true });
  return ok(`Marked item ${item_id} as complete.`);
}));

server.tool('shopping_list_uncomplete_item', 'Uncheck a completed shopping list item', {
  item_id: z.string().describe('Item ID from shopping_list_get_items or shopping_list_find_item'),
}, ({ item_id }) => wrap(async () => {
  await haRequest('POST', `/api/shopping_list/item/${item_id}`, { complete: false });
  return ok(`Marked item ${item_id} as incomplete.`);
}));

server.tool('shopping_list_remove_item', 'Permanently remove an item from the shopping list', {
  item_id: z.string().describe('Item ID from shopping_list_get_items or shopping_list_find_item'),
}, ({ item_id }) => wrap(async () => {
  const items = await haRequest('GET', '/api/shopping_list') as ShoppingItem[];
  const item = items.find((i) => i.id === item_id);
  if (!item) return fail(`Item ${item_id} not found on shopping list.`);
  await haRequest('POST', '/api/services/shopping_list/remove_item', { name: item.name });
  return ok(`Removed "${item.name}" from shopping list.`);
}));

server.tool('shopping_list_clear_completed', 'Remove all completed items from the shopping list', {}, () => wrap(async () => {
  const items = await haRequest('GET', '/api/shopping_list') as ShoppingItem[];
  const completed = items.filter((i) => i.complete);
  if (!completed.length) return ok('No completed items to clear.');
  await haRequest('POST', '/api/shopping_list/clear_completed');
  return ok(`Cleared ${completed.length} completed item(s).`);
}));

server.tool('shopping_list_find_item', 'Find shopping list items by name (case-insensitive partial match)', {
  search: z.string().describe('Name or partial name to search for'),
}, ({ search }) => wrap(async () => {
  const items = await haRequest('GET', '/api/shopping_list') as ShoppingItem[];
  const query = search.toLowerCase();
  const matches = items.filter((i) => i.name.toLowerCase().includes(query));
  if (!matches.length) return ok(`No items matching "${search}".`);
  return ok(`Found ${matches.length} match(es):\n` + matches.map((i) =>
    `  ${i.complete ? '[x]' : '[ ]'} ${i.name} (id: ${i.id})`,
  ).join('\n'));
}));

const transport = new StdioServerTransport();
await server.connect(transport);
