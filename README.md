# Live Chat App (Pro UI + Sidebar + Search + RBAC)

## New product features

- Left sidebar with separate lists for:
  - Groups
  - Direct chats
- Top search for both:
  - Groups
  - People
- Click people search result to:
  - Open direct chat
  - View profile popup
- Group metadata support:
  - Group image
  - Group bio
- Group RBAC roles:
  - owner
  - admin
  - member
- Role management in Members popup
- Profile includes:
  - first/last name
  - avatar
  - bio
  - theme (ocean/sunset/forest)
- Voice + video call still available

## Pages

- `/` -> login/register
- `/chat.html` -> chat app (auth required)

## APIs added

- `GET /api/sidebar`
- `GET /api/discovery?q=...`
- `GET /api/users/:id`

## Database

- Schema: `/Users/surajsingh/Downloads/live-chat-app/db/schema.sql`
- SQLite file: `/Users/surajsingh/Downloads/live-chat-app/data/chat_pro.sqlite`

## Run

```bash
cd /Users/surajsingh/Downloads/live-chat-app
npm start
```

If `better-sqlite3` ABI error appears (Node module version mismatch), rebuild with your current Node version:

```bash
npm rebuild better-sqlite3
```

If still failing:

```bash
rm -rf node_modules package-lock.json
npm install
npm rebuild better-sqlite3
npm start
```
