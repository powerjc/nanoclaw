import type { Migration } from './index.js';

/**
 * Add `env` JSON column to `container_configs` — a generic key/value map of
 * environment variables injected into the container at spawn time. Supports
 * ${VAR} references resolved from the host .env at spawn (same pattern as
 * mcp_servers env blocks). Default empty object.
 */
export const migration022: Migration = {
  version: 22,
  name: 'container-config-env',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}';`);
  },
};
