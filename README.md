# Bluetick — WhatsApp Business CRM

Bluetick is a CRM built on the official WhatsApp Business (Meta Cloud)
API: a shared team inbox, customers, campaigns, a visual bot builder,
sales pipelines, AI replies, and analytics.

## Features

- **Shared inbox** — multiple agents on one WhatsApp number, queues,
  saved views, assignment, notes, scheduled messages.
- **Customers** — contacts, tags, custom fields, CSV/XLSX import,
  deduplication.
- **Campaigns** — Meta-approved templates, broadcasts and scheduled
  broadcasts with delivery/read tracking, Click-to-WhatsApp ad leads.
- **Bot Builder (Flows)** — visual canvas with triggers, messages,
  conditions, API calls, business hours, round-robin assignment, and a
  simulator.
- **Automations** — event and schedule triggers, waits, tags, webhooks.
- **AI agents** — bring your own OpenAI or Anthropic key, AI-drafted
  replies, auto-reply bot with human handoff, knowledge base.
- **Sales pipelines** — Kanban deals linked to conversations.
- **Insights** — analytics dashboards and downloadable reports.
- **Team accounts** — invite by link, roles (owner / admin / agent /
  viewer).
- **Public REST API** (`/api/v1`) with scoped API keys and signed
  outbound webhooks — see [docs/public-api.md](./docs/public-api.md).

## Stack

Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, Supabase
(Postgres, Auth, Storage, RLS), Meta WhatsApp Cloud API.

## Getting started

```bash
git clone https://github.com/shipra-neoteric/Bluetick.git
cd Bluetick
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta credentials
npm run dev
```

Open <http://localhost:3000>.

### Database

Apply every file in [`supabase/migrations/`](./supabase/migrations) to
your Supabase project **in filename order** (SQL editor or
`supabase db push`). When you pull new code, apply any new migration
files before restarting the app.

### Environment

All variables are documented in
[`.env.local.example`](./.env.local.example). The required ones are the
Supabase URL/keys, `ENCRYPTION_KEY`, and `META_APP_SECRET`.

### Scheduled jobs

These endpoints must be called every minute by a scheduler (Vercel
Cron, a server cron, or any uptime pinger), with the header
`x-cron-secret: <AUTOMATION_CRON_SECRET>`:

- `/api/automations/cron`
- `/api/flows/cron`
- `/api/broadcasts/cron`
- `/api/inbox/cron`

### Languages

The UI ships in English, Korean, Portuguese and Spanish. Set
`NEXT_PUBLIC_APP_LOCALE` to `en`, `ko`, `pt` or `es` (catalogues live in
[`messages/`](./messages)).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Vitest) |

## More docs

- [WhatsApp connection troubleshooting](./docs/whatsapp-connection-troubleshooting.md)
- [Several WhatsApp Business Accounts on one deployment](./docs/multi-waba.md)
- [Public API](./docs/public-api.md)

## License

[MIT](./LICENSE).
