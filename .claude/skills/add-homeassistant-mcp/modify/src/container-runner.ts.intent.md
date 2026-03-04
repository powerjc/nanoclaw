# Intent: Add HA env variables

In `src/container-runner.ts`, inside `buildVolumeMounts`, locate the `readEnvFile` call and add `HA_URL` and `HA_TOKEN`. Then add them to the `settings.mcpServers` object to initialize the robust SSE connection.
