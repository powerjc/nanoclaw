# Intent: Add Media Server environment variables

This skill adds the following environment variables to the container's `readEnvFile` call in `src/container-runner.ts`:
- `SONARR_URL`
- `SONARR_API_KEY`
- `RADARR_URL`
- `RADARR_API_KEY`
