# Live Chat App (1:1 DM)

Production-ready real-time 1:1 chat app with:
- Register/Login (username + password)
- Profile photo upload (base64)
- Search users and start direct chat
- Real-time messages via Socket.IO
- File sharing (image/video/audio/pdf/doc/docx)
- Message timestamps (Today/Yesterday/date + AM/PM)
- Auto-delete inactive users after 90 days

## Tech stack
- Node.js + Express
- Socket.IO
- SQLite (`better-sqlite3`)
- Vanilla JS frontend

## Local run
```bash
cd /Users/surajsingh/Downloads/live-chat-app
npm install
npm start
```

App runs on `http://localhost:3000`.

## Env vars
- `PORT` (optional, default `3000`)
- `DB_PATH` (optional)
  - If not set, default DB is `data/chat_pro.sqlite`.
  - Useful for Railway volume path, e.g. `/data/chat_pro.sqlite`.

## Deploy (recommended: Railway)
Vercel is not recommended for this app because Socket.IO needs a long-running server process.

### 1. Push to GitHub
Repo: [https://github.com/Suraj1812/ChatApp](https://github.com/Suraj1812/ChatApp)

### 2. Deploy on Railway
1. Go to [https://railway.app/new](https://railway.app/new)
2. Choose **Deploy from GitHub repo**
3. Select `Suraj1812/ChatApp`
4. Railway auto-detects Node app and runs `npm start`

### 3. Add persistent volume for SQLite
1. Open your Railway project
2. Go to **Service Settings → Volumes**
3. Add volume and mount path: `/data`
4. Add env var:
   - `DB_PATH=/data/chat_pro.sqlite`

### 4. Final env
- `NODE_ENV=production`
- `PORT` is auto-provided by Railway

### 5. Open app
Use Railway provided public domain.

## Notes
- Attachments are stored in SQLite as base64; keep volume attached for persistence.
- If `better-sqlite3` ABI error appears locally after Node version change:
```bash
npm rebuild better-sqlite3
```
