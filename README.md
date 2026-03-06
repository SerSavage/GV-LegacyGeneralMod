# GV-Legacy General Mod (Discord bot)
<<<<<<< HEAD
=======

The bot **only runs in the channel gv-general** (`<#1166738417539887218>`). There it does the following:

When someone posts a message containing any word from `words.txt`, the bot replies with:
- The GIF: [Person of Interest – "I think we're getting off topic"](https://tenor.com/view/person-of-interest-hersh-i-think-we're-getting-off-topic-gif-13873963244115564618)
- The message: **Please move to \<#1168446788810842172\> instead.**

---

## Render (free tier)

1. **Repo:** Push this project to [GitHub: SerSavage/GV-LegacyGeneralMod](https://github.com/SerSavage/GV-LegacyGeneralMod.git).

2. **Render dashboard:** [dashboard.render.com](https://dashboard.render.com)  
   - **New → Web Service**  
   - Connect the repo **GV-LegacyGeneralMod**  
   - **Language:** Node  
   - **Build Command:** `yarn` (or `npm install`)  
   - **Start Command:** `yarn start` (or `npm start`)  
   - Render can use `render.yaml` from the repo, or set these manually to match.

3. **Environment variable (required):**  
   - In the service → **Environment** tab → **Add Environment Variable**  
   - Key: `DISCORD_TOKEN`  
   - Value: your Discord **bot token** (from [Discord Developer Portal](https://discord.com/developers/applications) → your app → Bot → Reset Token / Copy).

4. **Discord Developer Portal (for the bot):**
   - Application ID: `1302711260491546655` (your app).
   - **Bot** tab: create/copy token → use as `DISCORD_TOKEN` on Render.
   - **Privileged Gateway Intents:** enable **MESSAGE CONTENT INTENT** (required for the bot to read message text).
   - Invite the bot to your server with scope `bot` and permission **Read Message History** (and **Send Messages**).

5. **Interactions Endpoint URL:**  
   Not required for this bot. It uses the **Gateway** (WebSocket) to receive messages. Leave the interactions URL blank unless you add slash commands later.

---

## Local run

```bash
cd GV-LegacyGeneralMod
npm install
DISCORD_TOKEN=your_bot_token npm start
```

Optional: `WORDS_FILE=path/to/words.txt` to override the word list.

---

## Files

| File        | Purpose |
|------------|--------|
| `index.js` | Bot: load `words.txt`, listen for messages, reply with redirect + GIF link. Health server on `PORT` (Render sets `PORT`). |
| `words.txt` | Comma-separated trigger words (from your GVWords list). |
| `render.yaml` | Render web service config (node, build/start, env hint). |
| `package.json` | discord.js, start script. |

---

## Free tier note

On Render’s free tier, the web service may spin down after ~15 minutes with no HTTP traffic. Discord Gateway uses WebSockets; some sources say Render keeps the service up while it receives WebSocket traffic. If the bot goes offline when idle, add a free cron (e.g. [cron-job.org](https://cron-job.org)) to hit `https://your-service.onrender.com/` every 10 minutes to reduce spin-downs.
# GV-LegacyGeneralMod
>>>>>>> 79ac040 (Update mod files)
