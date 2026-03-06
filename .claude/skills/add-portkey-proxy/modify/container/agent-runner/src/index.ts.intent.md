# Intent: Add Portkey Proxy and Model Switcher Interceptor

1. Import `startProxy` from `./proxy.js`.
2. At the beginning of `main()`, start the proxy and override `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` to route all Claude SDK traffic through the local gateway on port 4000.
3. Inside the `main()` message loop (where `prompt = nextMessage` is assigned), inject a check for `/model <name>`.
4. If a `/model` command is detected, write the target model to `/workspace/group/.current-model`, notify the user, and bypass the agent evaluation for that turn so no tokens are spent.
