# Telegram notification on every conversation turn

Notify via Telegram **every time** a Grok agent turn ends in this project — including Q&A, chat, and completed tasks.

## Primary mechanism (automatic)

The `.grok/hooks/telegram-on-stop.json` hook runs `telegram-hook-stop.js` on every `Stop` event. **Do not manually run** `telegram-notify.js` unless the hook failed or you are debugging.

## Manual fallback (debug only)

```bash
node telegram-notify.js --status ok "<short summary>"
```

## Requirements

- Project must be trusted for hooks: add repo path to `~/.grok/trusted-hook-projects`
- After editing hook files, reload hooks in Grok (`/hooks` → press `r`) or restart the session
- Config: `telegram.config.local.js` (gitignored) or env vars `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`

## When to skip manual notify

Never skip the automatic hook. Only skip **manual** notify when you already see `[telegram-hook-stop] sent` in hook output.