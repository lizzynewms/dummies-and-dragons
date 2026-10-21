# Dummies & Dragons

A Jackbox-style comedy D&D one-shot. One screen is the TV. Up to six friends join from their phones with a link or a QR code (no accounts, no app). An AI dungeon master runs the story using everyone's madlib answers.

## Put it online (about 15 minutes, free hosting)

You'll make three free accounts: **GitHub** (stores the code), **Render** (runs the website) and **Anthropic** (powers the AI DM, pay as you go).

### 1. Get an Anthropic API key
1. Go to **console.anthropic.com** and sign up. This is separate from your Claude subscription.
2. Open **Billing** and add a little credit ($5 is plenty to start).
3. Open **Limits** and set a monthly spend limit you're comfortable with. That's your safety net.
4. Open **API Keys** → **Create Key**. Copy it somewhere safe; it starts with `sk-ant-`. Never paste it into the code or share it.

### 2. Put the code on GitHub
1. Go to **github.com**, sign up, then click **+** (top right) → **New repository**.
2. Name it `dummies-and-dragons`. Leave it **Public** or choose **Private**, either works. Click **Create repository**.
3. On the next page, click **uploading an existing file**.
4. Unzip `dummies-and-dragons.zip` on your computer. Open the folder, select **everything inside it** (`server.js`, `package.json`, `render.yaml`, `README.md`, the `public` folder…) and drag it all onto the GitHub page. Don't drag the outer folder itself.
5. Click **Commit changes**.

### 3. Launch it on Render
1. Go to **render.com** and sign up with your GitHub account.
2. Click **New +** → **Blueprint**. Pick your `dummies-and-dragons` repository. (If it isn't listed, click "Configure account" and give Render access to it.)
3. Render reads the settings from `render.yaml` and asks for two values:
   - **ANTHROPIC_API_KEY**: paste your key from step 1.
   - **HOST_PASSWORD**: make up a password. Only people with it can open a table and spend your API credit. Players never need it.
4. Click **Apply**. The first build takes a few minutes. When it says **Live**, your link is at the top, like `https://dummies-and-dragons.onrender.com`.

That's it. Open the link on a laptop hooked to the TV, enter the host password, and click **Open a table**. Friends scan the QR code or type the link plus the room code.

## Good to know
- **The free plan naps.** After about 15 minutes with nobody on the site, Render puts it to sleep, and the next visit takes up to a minute to wake it. Open the site a minute or two before game night. Render's cheapest paid plan removes the nap.
- **Cost.** Each game makes roughly 20–40 DM calls. Expect cents to around a dollar per game depending on length. Check the Usage page in the Anthropic Console after your first game to see your real number. Each table is capped at 120 DM calls.
- **"Snappy" DM brain** in the lobby uses a faster, cheaper model. "Clever" is funnier but has longer dramatic pauses.
- **If the DM errors,** the TV shows **Retry** and **Skip ahead**, so the game never gets stuck.
- **If the server restarts mid-game** (it happens on free plans), refresh the TV and click **Resume**. Phones reconnect by themselves.

## Changing things
- Story frameworks, madlib prompts, races and classes are near the top of the script in `public/index.html` (search for `FRAMEWORKS`, `PROMPTS`, `RACES`, `CLASSES`).
- The DM's personality and rules are in `public/index.html` (search for `const RULES`).
- After editing, upload the changed file to GitHub again. Render redeploys automatically.

## Running it on your own computer (optional)
Needs Node.js 18+.
```
npm install
npm run dev          # test mode: canned DM replies, no API key needed
ANTHROPIC_API_KEY=sk-ant-... npm start   # real DM
```
Then open http://localhost:3000. Phones on the same Wi-Fi can join at your computer's local IP address, port 3000.

## Settings (environment variables)
| Name | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Required for the real DM. |
| `HOST_PASSWORD` | Optional. If set, opening a table needs this password. Strongly recommended for a public site. |
| `DM_MODEL` / `DM_MODEL_FAST` | Override the AI models (defaults `claude-sonnet-5-5` / `claude-haiku-5-5`). |
| `MAX_AI_CALLS_PER_ROOM` | Default 120. |
| `MOCK_DM` | Set to `1` for canned replies. |
