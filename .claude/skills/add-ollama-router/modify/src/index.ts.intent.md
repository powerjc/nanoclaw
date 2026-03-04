# Intent: Add Ollama LLM router fast path

We need to add the local Ollama LLM router into two places in the message loop:
1. When checking pending group messages in `processGroupMessages()`
2. When intercepting streaming messages in `startMessageLoop()`

First, add this import at the top:
`import { tryOllamaRoute } from './llm-router.js';`

Second, right before `let hadError = false;` inside `processGroupMessages()`, insert:
```typescript
  // Try Ollama for simple/privacy queries — skip spawning a container
  // Skip Ollama entirely if the batch contains an image (Ollama has no vision)
  const ollamaResponse = imageData
    ? null
    : await tryOllamaRoute(missedMessages, group.name);
  if (ollamaResponse !== null) {
    await channel.setTyping?.(chatJid, false);
    await channel.sendMessage(chatJid, ollamaResponse);
    return true;
  }
```

Third, in `startMessageLoop()`, right before `// Pipe to container or start a new one`, replace `if (queue.sendMessage(chatJid, formatted)) {` with:
```typescript
          // Try Ollama before piping to container or starting a new one
          // Skip if any message in the batch has pending image data (Ollama has no vision)
          const hasImage = messagesToSend.some((m) =>
            pendingImageData.has(m.id),
          );
          const ollamaResponse = hasImage
            ? null
            : await tryOllamaRoute(messagesToSend, group.name);
          if (ollamaResponse !== null) {
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            await channel.sendMessage(chatJid, ollamaResponse);
          } else if (queue.sendMessage(chatJid, formatted)) {
```
