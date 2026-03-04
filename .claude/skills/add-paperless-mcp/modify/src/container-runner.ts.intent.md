# Intent: Add Paperless-ngx env variables

In `src/container-runner.ts`, inside `buildVolumeMounts`, locate the `readEnvFile` call and add `PAPERLESS_URL` and `PAPERLESS_TOKEN`. Then add them to the `settings.env` object.
