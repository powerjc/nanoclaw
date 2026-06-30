/**
 * Inbound webhook — lets external services (n8n, scripts, etc.) inject
 * messages directly into an agent session without going through a channel
 * adapter. Bypasses the Telegram bot-sees-bot limitation entirely.
 *
 * POST /webhook/inbound/:folder
 * Headers: x-nanoclaw-token: <INBOUND_WEBHOOK_TOKEN from .env>
 * Body: { "text": "...", "sender": "n8n" }
 *
 * The message lands in the agent group's active session as a chat message,
 * indistinguishable from a user message. The agent wakes and responds via
 * whatever channels are wired to that group.
 */
import type http from 'http';

import { getAgentGroupByFolder } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { routeInbound } from './router.js';
import { registerWebhookHandler } from './webhook-server.js';

function getToken(): string | undefined {
  const fromFile = readEnvFile(['INBOUND_WEBHOOK_TOKEN']);
  return process.env.INBOUND_WEBHOOK_TOKEN || fromFile.INBOUND_WEBHOOK_TOKEN;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

registerWebhookHandler('inbound', async (req, res) => {
  // Only POST
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  // Token auth
  const token = getToken();
  if (token) {
    const provided = req.headers['x-nanoclaw-token'];
    if (provided !== token) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
  }

  // Parse folder from path: /webhook/inbound/<folder>
  const folder = req.url?.split('/').pop();
  if (!folder) {
    res.writeHead(400);
    res.end('Missing folder in path');
    return;
  }

  // Parse body
  let body: { text?: string; sender?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400);
    res.end('Invalid JSON');
    return;
  }

  const text = body.text?.trim();
  if (!text) {
    res.writeHead(400);
    res.end('Missing text');
    return;
  }

  const sender = body.sender || 'webhook';

  // Resolve agent group
  const agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    res.writeHead(404);
    res.end(`No agent group with folder: ${folder}`);
    return;
  }

  // Find a wired messaging group to route through
  const db = getDb();
  const mgRow = db
    .prepare(
      `
    SELECT mg.channel_type, mg.platform_id, mg.instance
    FROM messaging_group_agents mga
    JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
    WHERE mga.agent_group_id = ?
    LIMIT 1
  `,
    )
    .get(agentGroup.id) as { channel_type: string; platform_id: string; instance: string | null } | undefined;

  if (!mgRow) {
    res.writeHead(404);
    res.end(`No messaging groups wired to: ${folder}`);
    return;
  }

  if (!mgRow) {
    res.writeHead(500);
    res.end('Could not resolve messaging group');
    return;
  }

  await routeInbound({
    channelType: mgRow.channel_type,
    instance: mgRow.instance ?? mgRow.channel_type,
    platformId: mgRow.platform_id,
    threadId: null,
    message: {
      id: `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'chat',
      content: JSON.stringify({ text, sender }),
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: true,
    },
  });

  log.info('Inbound webhook routed', { folder, sender, textLength: text.length });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, folder, sender }));
});

log.info('Inbound webhook registered', { path: '/webhook/inbound/:folder' });
