/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * Resolve ${VAR} references in MCP server env blocks from the host .env file.
 * Secrets live in .env, DB stores only the reference — resolved at spawn time.
 */
function resolveMcpEnvRefs(mcpServers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const VAR_REF = /^\$\{(.+)\}$/;
  const varNames = Object.values(mcpServers).flatMap((s) =>
    Object.values(s.env ?? {})
      .map((v) => v.match(VAR_REF)?.[1])
      .filter((v): v is string => v != null),
  );
  if (varNames.length === 0) return mcpServers;
  const fromFile = readEnvFile(varNames);
  const resolve = (val: string): string => {
    const match = val.match(VAR_REF);
    if (!match) return val;
    return process.env[match[1]] ?? fromFile[match[1]] ?? val;
  };
  return Object.fromEntries(
    Object.entries(mcpServers).map(([name, server]) => [
      name,
      {
        ...server,
        env: server.env ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, resolve(v)])) : undefined,
      },
    ]),
  );
}

/** Resolve ${VAR} references in the top-level env block. */
function resolveEnvRefs(env: Record<string, string>): Record<string, string> {
  const VAR_REF = /^\$\{(.+)\}$/;
  const varNames = Object.values(env)
    .map((v) => v.match(VAR_REF)?.[1])
    .filter((v): v is string => v != null);
  if (varNames.length === 0) return env;
  const fromFile = readEnvFile(varNames);
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => {
      const match = v.match(VAR_REF);
      return [k, match ? (process.env[match[1]] ?? fromFile[match[1]] ?? v) : v];
    }),
  );
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  env: Record<string, string>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    env: JSON.parse(row.env ?? '{}') as Record<string, string>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);
  config.mcpServers = resolveMcpEnvRefs(config.mcpServers);
  config.env = resolveEnvRefs(config.env);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
