# De Sering Food Planner — Setup & Editing Guide (v4)

## What's new in v4

- **Google Sign-In** — only approved emails can access the app
- **Save indicator** — you can see whether changes are saved, saving, or failed
- **Automatic retry** — if a save fails (bad wifi), it retries up to 3 times
- **Activity log** — every save is logged with who did it and when (in a "log" tab in your Google Sheet)
- **Data validation** — the server rejects malformed data instead of silently corrupting the sheet
- **Proper IDs** — dishes use UUID instead of timestamps, preventing duplicate ID bugs
- **Search in planner** — the "add dish" popup now has a search box
- **Dessert badge** — desserts now have their own purple badge colour
- **HTML escaping** — dish names with special characters (& < >) no longer break the interface

---

## First-time setup

### 1. Environment variables

You need to set these environment variables (in Replit Secrets, .env file, or your hosting panel):

| Variable | What it is | Required? |
|---|---|---|
| `GOOGLE_CREDENTIALS` | Your Google service account JSON (for Sheets access) | Yes |
| `DB_SHEET_ID` | The Google Sheet ID used as your database | Yes |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (for login) | Yes for production |
| `ALLOWED_EMAILS` | Comma-separated emails allowed to log in | Yes for production |
| `INGREDIENT_DB_SHEET_ID` | Sheet ID for ingredient database | Optional (has default) |

### 2. Set up Google Sign-In

1. Go to https://console.cloud.google.com/apis/credentials
2. Click "Create Credentials" → "OAuth client ID"
3. Choose "Web application"
4. Add your app URL to "Authorised JavaScript origins" (e.g. `https://your-app.replit.app`)
5. Copy the Client ID and set it as `GOOGLE_CLIENT_ID`
6. Add your team's email addresses to `ALLOWED_EMAILS`:
   ```
   ALLOWED_EMAILS=chef@desering.nl,volunteer1@gmail.com,volunteer2@gmail.com
   ```

### 3. Install and run

```bash
npm install
npm start
```

### Dev mode (no Google login)

If `GOOGLE_CLIENT_ID` is not set, the app runs in dev mode:
- A "Dev mode login" button appears on the login screen
- No real authentication happens
- Good for local testing

---

## How the save system works

- Changes are **debounced** — the app waits 1.5 seconds after your last change, then saves everything at once
- While saving, the dot in the top bar turns **amber** (saving)
- When saved, it turns **green** (saved)
- If it fails, it turns **red** and retries up to 3 times
- If all retries fail, you see an error toast — your changes are still in memory, so don't close the tab

---

## Activity log

Every save is logged in the "log" tab of your database Google Sheet with:
- Timestamp
- Who saved (email + name)
- What changed (number of dishes)

This means you can always see who last modified the data.

---

## Common edits

All the editing instructions from v3 still apply. Here's the quick reference:

### Change a tab name
Search for the current name in quotes, e.g. `"Guest counts"`.

### Add a new storage state (e.g. "Fridge")
Search for `const STORAGE=` and add your new state.

### Add a new logistics option (e.g. a third location)
Search for `const LOGISTICS=` and add your new option.

### Change the days of the week
Search for `const DAYS=`.

### Change colours
Search for `:root {` at the top of `index.html`.

### Add a dish type
Search for `['Soup','Main course','Dessert']` — it appears in several places.

### Add someone to the allowed users list
Update the `ALLOWED_EMAILS` environment variable with their email address.

---

## Structure of index.html (v4)

```
1. <style> block          — all visual styling
2. Login screen HTML      — shown before auth
3. App shell HTML         — tabs, save indicator, user menu
4. <script> block:
   a. Constants            — DAYS, MEALS, STORAGE, LOGISTICS
   b. State (S object)     — all data in memory
   c. Auth functions        — handleGoogleLogin, checkSession, etc.
   d. UUID generator        — newId() using crypto.randomUUID()
   e. API + save system     — apiGet/apiPost, scheduleSave, doSave with retry
   f. Core logic            — calcRequired(), calcIngredients() etc.
   g. Screen renderers      — renderGuests/Planner/Dishes/Orders
   h. Action functions      — openEditDish, doSplit, etc.
   i. Modal + utils         — showModal, closeModal, esc()
   j. Init                  — checks session, loads data
```

---

## Things NOT to change

- The `newId()` function — it generates proper UUIDs
- The `scheduleSave()` / `doSave()` system — it handles debouncing and retries
- The `requireAuth` middleware in server.js — this protects your data
- The `validateDishes()` / `validateGuests()` functions — they prevent data corruption
- The `withWriteLock()` function — it prevents concurrent write conflicts

---

## Backing up

Your data lives in Google Sheets, which has its own version history (File → Version history).
The activity log tab shows who changed what and when.
Your code is in `index.html` and `server.js` — keep this zip as a backup.
