# Render env vars and quick test

## Deploy fails with "Used disallowed intents"

If the bot crashes on Render with `Error: Used disallowed intents`, enable **Privileged Gateway Intents** in the Discord Developer Portal:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot**.
2. Under **Privileged Gateway Intents**, turn **ON**:
   - **SERVER MEMBERS INTENT** (for `guildMemberAdd` / welcomes)
   - **MESSAGE CONTENT INTENT** (for reading message text in gv-general)
3. Click **Save Changes**, then redeploy on Render.

---

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
| **OFFTOPIC_TO_GENERAL_USER_ID** | (Discord user ID) | No — if set, that user’s image/GIF posts in off-topic are moved to gv-general. **Set in Render only; do not put real IDs in the repo.** |
| REDIRECT_CHANNEL_ID | (hardcoded in code as 1168446788810842172) | — |
| DEBUG | `1` | No (set to `1` only when debugging) |

**Minimal setup:** only **DISCORD_TOKEN** is required. Leave the rest unset to use defaults.

**If triggers still don’t run in gv-general:** In Discord Developer Portal → Bot → **Privileged Gateway Intents**, turn **MESSAGE CONTENT INTENT** and **SERVER MEMBERS INTENT** ON and save.

---

## Privacy: DMs and Message Content Intent

Discord's [Message Content FAQ](https://support-dev.discord.com/hc/en-us/articles/4404772028055) says that with Message Content Intent enabled, bots can receive message content in DMs. This bot does not use DM content:

- **In code:** The first thing the `messageCreate` handler does is `if (!message.guild) return;` so every DM is ignored. No DM text is processed, logged, or stored.
- **In practice:** Message Content Intent is used only to read messages in #gv-general (and for the off-topic to gv-general image move). The bot never acts on or stores anything from DMs.

You can confirm this in `index.js`: the handler exits immediately when there is no guild (i.e. when the message is from a DM).

---

## Gateway intents this bot uses (from [Discord Gateway docs](https://docs.discord.com/developers/events/gateway-events))

| Event / feature | Intent required | In Developer Portal |
|------------------|------------------|----------------------|
| `messageCreate` + reading message text | **MESSAGE CONTENT** (privileged) | “MESSAGE CONTENT INTENT” → ON |
| `guildMemberAdd` / `guildMemberUpdate` | **GUILD MEMBERS** (privileged) | “SERVER MEMBERS INTENT” → ON |
| Basic guild + messages | Guilds, Guild Messages | Default (no toggle) |

You don’t need any other gateway events from the docs; the code already requests these intents.

---

## If Bot / Intents settings reset when you refresh

Some users see Privileged Gateway Intents (or other Bot settings) revert after refresh. Try:

1. **Save correctly**  
   On the **Bot** page, scroll to the **very bottom**, click **“Save Changes”** (green button), wait **5–10 seconds**, then refresh.

2. **Browser**  
   Try another browser or an **incognito/private** window in case of cache or extensions.

3. **One change at a time**  
   Turn **one** intent ON → Save → wait → refresh. Then turn the other ON → Save again.

4. **Confirm the right app**  
   Check the app name/icon in the top bar; if you have several apps, make sure you’re editing the one the bot uses.

5. **Re-invite the bot**  
   Bot permissions in the **invite URL** (OAuth2 → URL Generator) are not stored like intents. If you only changed the invite link’s “Bot Permissions”, that doesn’t persist in the same way; regenerate the link and re-invite the bot with “Administrator” (or the scopes you need) so the bot has permission in the server. Intents are still toggled under **Bot** → **Privileged Gateway Intents**.

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
