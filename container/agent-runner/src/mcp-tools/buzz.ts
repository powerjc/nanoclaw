/**
 * Buzz MCP tools: buzz_set_profile.
 *
 * Fire-and-forget, same shape as self-mod's install_packages/add_mcp_server
 * and agents.ts's create_agent: the tool writes a system action row and
 * returns immediately; the host performs the actual signed Nostr operation
 * (it holds BUZZ_NSEC, which never enters this container — see
 * src/channels/buzz.ts and src/modules/buzz-actions/ on the host) and
 * notifies the agent with the result via a normal chat message.
 *
 * Proof-of-concept scope: buzz_set_profile only. See
 * docs/buzz-mcp-tooling-spec.md for the fuller planned tool surface.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const buzzSetProfile: McpToolDefinition = {
  tool: {
    name: 'buzz_set_profile',
    description:
      'Update this identity\'s Buzz profile (display name, about text, and/or avatar URL). Only requires being wired to a Buzz channel — no approval needed. Fire-and-forget: returns immediately, result arrives as a follow-up chat message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Display name shown in Buzz' },
        about: { type: 'string', description: 'Short bio / about text' },
        picture: { type: 'string', description: 'Avatar image URL' },
      },
    },
  },
  async handler(args) {
    const name = args.name as string | undefined;
    const about = args.about as string | undefined;
    const picture = args.picture as string | undefined;
    if (name === undefined && about === undefined && picture === undefined) {
      return err('provide at least one of name, about, picture');
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'buzz_set_profile',
        requestId,
        name: name ?? undefined,
        about: about ?? undefined,
        picture: picture ?? undefined,
      }),
    });

    log(`buzz_set_profile: ${requestId}`);
    return ok('Buzz profile update submitted. You will be notified with the result.');
  },
};

registerTools([buzzSetProfile]);
