# Admin Hub: one admin panel for every payment app

Sign in once, pick an app (GGPay, PayTwin, and any future clone), and control it with the full admin panel: users, balances, transactions, banks, billers, plans, rewards, offers, banners, notifications, support tickets, settings, audit logs and admins. Switch apps from the sidebar at any time. The **All apps** page shows every app's status and key numbers side by side, with a one-click maintenance switch per app.

## How it fits together

```
                ┌──────────── Admin Hub (this repo) ────────────┐
 Browser ──────▶│ hub login, app list, a saved admin session    │  database: adminhub
                │ for each app                                   │
                └───────────────────────────────────────────────┘
     │ after choosing an app, the page calls that app directly (API + live socket)
     ▼
 GGPay server  ── its own database (ggpay)      ◀── GGPay Android app
 PayTwin server ── its own database (paytwin)   ◀── PayTwin Android app
 Next clone    ── its own database (...)        ◀── its Android app
```

- **Apps stay independent.** Each app has its own server, its own database and its own repo, and keeps working without the hub (its own `/admin` page still works too).
- The hub stores only: hub admins, the list of apps (name, server URL, colour), and an admin session token per app. It never stores app passwords: the first time you open an app it asks for that app's admin login once, and the session is reused by every hub admin after that.
- Each app server publishes `GET /api/admin/schema`, which tells the hub about its own feature switches, home sections, branding fields, extra user fields and so on. The hub draws those controls automatically, so a new clone with new options needs **no hub changes**.

## Run locally

| Thing | Port | Start |
|---|---|---|
| GGPay server | 4000 | `Gpay\START-SERVER.bat` |
| PayTwin server | 4001 | `paytm\START-SERVER.bat` |
| Admin Hub | 5000 | `admin-hub\START-HUB.bat` → <http://localhost:5000> |

Hub login: `admin` / `admin123`. When opening an app the first time, sign in with that app's admin login (`admin` / `admin123` in demo data).

## Online (Render)

1. Push this folder to its own GitHub repo (e.g. `admin-hub`).
2. Render → **New → Blueprint** → pick the repo. Enter `MONGODB_URI` (the same Atlas cluster is fine; the hub uses its own `adminhub` database) and `HUB_ADMIN_PASSWORD` (the hub's admin password).
3. `HUB_APPS` in `render.yaml` lists the apps for the first start (GGPay and PayTwin online URLs). Add or edit apps later from the hub page itself.

The hub and the apps are on Render's free plan, so a sleeping app shows **offline** for up to a minute while it wakes up.

## Adding a new clone app (the next 3 apps)

1. Build the clone from the PayTwin codebase (copy `paytm/`), with its **own** server, Render service and database name (`MONGODB_DB=<clone name>`), and a free local port (4002, 4003, 4004…).
2. In the clone's `server/src/index.js`, update `GET /api/admin/schema` to describe its own feature switches, home sections, branding fields and user fields.
3. In the hub: **All apps → Add an app** → name, server URL, colour. Open it and sign in with its admin login once. Done.

## Hub API (for reference)

`POST /hub/login` · `GET /hub/apps` · `POST /hub/apps` · `PUT/DELETE /hub/apps/:id` · `GET /hub/apps/:id/status` · `POST /hub/apps/:id/login` (sign the hub in to an app) · `POST /hub/apps/:id/connect` (get the session for the browser) · `POST /hub/apps/:id/disconnect` · `/hub/admins` · `/hub/password` · `GET /hub/log`
