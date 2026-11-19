# BND checker

Own uptime monitoring - like UptimeRobot, but self-hosted and without plan limits.

- Checks each monitor in `data/monitors.json` every 5 minutes (GitHub Actions cron)
- A failure is retried once after 20 seconds before it counts as DOWN (no false alerts)
- Emails a DOWN alert when a monitor goes down and an UP alert (with the downtime) when it recovers
- History and incidents are committed back to `data/` and shown on the dashboard

## Dashboard

Static page (`index.html`) hosted on Vercel. It reads `data/summary.json` from this repo and refreshes every minute.

## How it works

1. `.github/workflows/check.yml` runs `scripts/check.mjs` every 5 minutes
2. The script updates `data/state.json`, `data/history/<monitor>.json`, `data/incidents.json` and `data/summary.json`, then commits them
3. Status changes trigger email alerts over Gmail SMTP

## Secrets (repo Settings > Secrets and variables > Actions)

- `GMAIL_USER` - Gmail address the alerts are sent from
- `GMAIL_APP_PASSWORD` - app password for that Gmail account
- `ALERT_TO` - where alerts go (defaults to `GMAIL_USER`)

## Add a monitor

Append to `data/monitors.json`:

```json
{
  "id": "my-api",
  "name": "My API",
  "url": "https://example.com/health",
  "expectStatus": 200,
  "timeoutMs": 30000,
  "intervalMin": 5,
  "enabled": true
}
```

## Run a check locally

```bash
npm ci
DRY_RUN=1 node scripts/check.mjs
```

