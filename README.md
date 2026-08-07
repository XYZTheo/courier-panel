# Courier Panel

An Uber-style live courier tracking web panel controlled entirely from a Telegram admin bot. Switch brands (company A/B/C/D with logo + theme), push client info, move the courier on a live map, and simulate a live trip — all from Telegram.

## Features
- Uber-style dark client tracking page (Leaflet map, live ETA, courier card, "Open Uber" deep link, prep instructions).
- **Status timeline** (Order received → Courier assigned → Picking up → En route → Arriving → Arrived → Delivered) with a live progress bar.
- **Delivery code / OTP** generated per order, shown to the client and available via `/code`.
- **"Call courier"** button (`tel:` link) driven by the courier phone field.
- **Auto-ETA** computed from courier-to-destination distance (override with `/setcourier ... eta`).
- **State persistence** (`state.json`) — survives server restarts.
- Switchable company branding (name, logo, primary/accent colors, light/dark theme) updated live on the page; editable via `/setname`, `/settheme`, `/setcolor`.
- Telegram admin bot (polling) drives everything via inline menus + commands.
- Upload a new company logo straight from Telegram (send a photo, optional caption = new company name).
- Live map simulation: set destination, courier auto-walks the route, status timeline auto-advances to Arriving then Arrived.
- Realtime updates pushed to all open web clients via Socket.IO, with a notification beep + browser notification on status change.

## Setup
```bash
cd courier-panel
cp .env.example .env        # then edit .env and paste your bot token + admin chat id
npm install
npm start
```
Open `http://localhost:3000` for the client panel.

### Getting the bot token
1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Talk to [@userinfobot](https://t.me/userinfobot) → copy your Id into `ADMIN_CHAT_ID` (leave blank to allow anyone).

## Telegram commands
```
/start                 admin menu
/help                  full command list
/setcompany UPS|FEDEX|BOA|DHL|NFCU|PNC|CHASE   switch brand
/setname <name>        rename current company
/settheme light|dark   set page theme
/setcolor #1FBAD6 #1434CB   set brand primary + accent colors
/setclient name | address | city | phone
/setcourier name | vehicle | eta | rating | phone
/setorder items | note
/setstatus <text>      set live status message
/nextstatus            advance to next status in the timeline
/setstatusN <n>        jump to status #n (1-7)
/neworder              reset to a fresh order (new tracking id + delivery code)
/demo                  run the automated end-to-end demo flow (initiation → carrier pickup → delivery)
/stopdemo              abort a running demo
/code                  show the delivery code
/alert <text>          push a toast to all open client pages
/setuber <url>         set the "Open Uber" deep link
/move <lat> <lng>      jump courier to a point
/route <lat> <lng>     set destination + start live simulation
/simulate on|off       toggle auto movement
/step                  advance courier one step
/show                  show current panel state
```
Send a **photo** to set the current company logo. Optional caption = new company name.

## Files
```
server.js              Express + Socket.IO + Telegram bot + live state + persistence
companies.json         pre-defined company presets: UPS, FedEx, Bank of America, DHL, Navy Federal, PNC, Chase (editable via bot)
state.json             persisted live state (auto-created on first change)
public/index.html      client tracking page
public/style.css       Uber-style theme
public/app.js          frontend: Socket.IO client + Leaflet map + timeline
public/logos/          company logos (SVG placeholders + uploaded)
```

## Customizing companies
Edit `companies.json` to add presets (id, name, logo, primary, accent, theme). The bot can switch between them live; name and logo can also be changed from Telegram.
