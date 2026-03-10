# Render env vars and quick test

## What TRIGGER_CHANNEL_ID is for

**TRIGGER_CHANNEL_ID** = the channel where the bot **listens for messages** (slurs, off-topic, religion/politics, Soon, etc.). That channel is **#gv-general**, not off-topic.

- **TRIGGER_CHANNEL_ID** = **#gv-general** (1166738417539887218) → bot reads messages here and reacts (delete + forward to off-topic, or Soon emoji).
- **REDIRECT_CHANNEL_ID** = **#off-topic** (1168446788810842172) → where the bot **sends** moved messages.

So do **not** remove TRIGGER_CHANNEL_ID. If you leave it **unset** on Render, the bot uses the default gv-general ID. If you set it to the wrong value (e.g. the off-topic channel), the bot would listen in the wrong place and gv-general would never trigger. **Either leave it unset (recommended) or set it to `1166738417539887218`.**

---

## Render env vars (recommended)

In Render: your service → **Environment** tab.

| Key | Value | Required? |
|-----|--------|-----------|
| **DISCORD_TOKEN** | (your bot token) | **Yes** |
| TRIGGER_CHANNEL_ID | `1166738417539887218` | No (default is gv-general) |
| GV_GENERAL_CHANNEL_ID | `1166738417539887218` | No (default = same as trigger) |
| ADMIN_JOIN_CHANNEL_ID | `1166746316999757864` | No (default = admin) |
| REDIRECT_CHANNEL_ID | (hardcoded in code as 1168446788810842172) | — |
| DEBUG | `1` | No (set to `1` only when debugging) |

**Minimal setup:** only **DISCORD_TOKEN** is required. Leave the rest unset to use defaults.

**If triggers still don’t run in gv-general:** In Discord Developer Portal → Bot → **Privileged Gateway Intents**, turn **MESSAGE CONTENT INTENT** and **SERVER MEMBERS INTENT** ON and save.

---

## Quick test: admin-join welcome

This checks that when the admin channel gets a “user joined” style message, the bot posts the welcome in gv-general.

1. In **#admin** (1166746316999757864), post a message that:
   - **Mentions a user** (e.g. type `@YourAlt` or `@YourMain`), and
   - Contains one of: **joined**, **welcome**, **just joined**, or **joined the server**.

   Example:  
   `Welcome @YourUsername!`  
   or  
   `@YourUsername joined the server`

2. Within a few seconds, the bot should post in **#gv-general**:  
   `Welcome, @YourUsername!` + the Knights with sub video link.

3. If it doesn’t:
   - Confirm the bot can **read messages** in #admin and **send messages** in #gv-general.
   - Set **DEBUG=1** on Render, redeploy, and check logs when you send the test message (you should see `[admin-join] Welcomed ...` if the handler ran).
