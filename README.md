GV-Legacy General Mod (Discord bot)

## Why isn't it triggering in general chat?

1. **Wrong channel** – The bot only listens in one channel (default ID `1166738417539887218`). If your "general" channel has a different ID, set `TRIGGER_CHANNEL_ID` in `.env` to that channel's ID (right‑click the channel → Copy channel ID; enable Developer Mode in Discord if you don't see it).

2. **Message Content Intent** – In [Discord Developer Portal](https://discord.com/developers/applications) → your app → Bot → Privileged Gateway Intents, turn **Message Content Intent** ON. Without it, the bot receives events but often gets empty `message.content`.

3. **Safe-context filter** – Messages that contain any of: `nations`, `guilds`, `players`, `voting`, `sub`, etc. are never triggered (to avoid reacting to game/community talk). If the message had one of those words plus "Faith" or "Christiandom", it won't reply.

4. **Debug** – Run with `DEBUG=1` in `.env` (or `DEBUG=true`) and check logs to see whether messages are skipped due to channel, empty content, safe-context, or no trigger word.
