# Folio

A small independent bookstore: browse and search a seeded catalog, add books to a
cart, and pay through Stripe Checkout. Guest checkout only — no accounts, no
admin UI.

## Stack

- Next.js 16 (App Router, Cache Components, Partial Prerendering) + React 19
- TypeScript, Tailwind CSS v4
- Drizzle ORM on Postgres (postgres.js), with embedded PGlite for local dev
- Stripe Checkout + signed webhooks

## Quick start

```bash
npm install
cp .env.example .env
npm run db:generate   # only needed after editing lib/db/schema.ts
npm run db:setup      # apply migrations
npm run db:seed       # 18 books
npm run dev
```

Open http://localhost:3000.

No database is required to get started. With `DATABASE_URL` unset the app runs
on PGlite, an in-process Postgres stored in `./.pglite` (gitignored). Set
`DATABASE_URL` to point at a real Postgres instance — the schema and queries are
identical.

## Starting and stopping

### Development server

```bash
npm run dev
```

Serves http://localhost:3000 and watches files for changes. Leave the terminal
open — compile errors and request logs print there. Stop it with `Ctrl+C`.

If the terminal was closed but port 3000 is still held:

```bash
lsof -ti:3000 | xargs kill
```

To use another port when 3000 is taken:

```bash
npm run dev -- --port 3001
```

The app reads `.env` once at startup, so **restart after changing any
environment variable**.

### Production mode

```bash
npm run build
npm run start
```

`npm run start` serves the built app on http://localhost:3000 and stops with
`Ctrl+C`. It does not watch files; run `npm run build` again after code changes.

### Stripe webhook listener

When testing payments, run this in a second terminal and leave it running:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Stop it with `Ctrl+C`. Orders are only written to the database while this is
running and `STRIPE_WEBHOOK_SECRET` matches the `whsec_...` it prints.

### Local database

The embedded PGlite database lives in `./.pglite` and allows only one process at
a time. Stop the dev server before running `books`, `db:setup`, or `db:seed`
commands. To wipe local data and start over:

```bash
rm -rf .pglite
npm run db:setup
npm run db:seed
```

This deletes all local books and orders. It has no effect when `DATABASE_URL`
points at a real Postgres server.

## Enabling payments

Without keys the catalog, cart, and success page all work; only checkout is
disabled and surfaces a message instead of failing.

1. Put your Stripe **test** secret key in `.env` as `STRIPE_SECRET_KEY`.
2. Forward webhooks locally so orders are recorded:

   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```

3. Copy the printed `whsec_...` into `.env` as `STRIPE_WEBHOOK_SECRET` and
   restart the dev server.

Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

## Environment variables

| Variable                | Required | Purpose                                                           |
| ----------------------- | -------- | ----------------------------------------------------------------- |
| `DATABASE_URL`          | no       | Postgres connection string. Omit to use PGlite.                    |
| `STRIPE_SECRET_KEY`     | for pay  | Creates Checkout Sessions and reads them on the success page.      |
| `STRIPE_WEBHOOK_SECRET` | for pay  | Verifies webhook signatures.                                       |
| `TWILIO_AUTH_TOKEN`     | for SMS  | Verifies Twilio request signatures.                                |
| `INVENTORY_SMS_FROM`    | for SMS  | The one phone number allowed to send stock commands (E.164).       |
| `INVENTORY_SMS_PIN`     | for SMS  | Shared PIN that must start every stock command.                    |
| `TELEGRAM_BOT_TOKEN`    | for Telegram | BotFather token used to send replies.                          |
| `TELEGRAM_WEBHOOK_SECRET` | for Telegram | Must match the `secret_token` registered on the webhook.     |
| `INVENTORY_TELEGRAM_CHAT_ID` | for Telegram | The only chat allowed to send commands (may be negative). |
| `INVENTORY_TELEGRAM_PIN` | for Telegram | Shared PIN that must start every Telegram command.             |
| `NEXT_PUBLIC_APP_URL`   | no       | Base URL for Stripe redirects and Twilio signature validation.     |

## How checkout works

1. `POST /api/checkout` receives `{ items: [{ bookId, qty }] }`, re-reads every
   price and stock level from the database (client prices are never trusted),
   and creates a Stripe Checkout Session with `book_id` in each line's product
   metadata.
2. Stripe redirects back to `/checkout/success?session_id=...`, which retrieves
   the session and shows the receipt.
3. `POST /api/webhooks/stripe` verifies the signature, then on
   `checkout.session.completed` (with `payment_status = paid`) writes the order
   and line-item snapshot and decrements stock in one transaction. The insert is
   idempotent on `stripe_session_id`, so retried deliveries cannot double-count.

The success page is a convenience, not the source of truth — an order only
exists once the webhook has been processed.

## Project layout

```
app/
  page.tsx                      static hero + streamed catalog
  books/[slug]/page.tsx         book detail, 404s for unknown slugs
  cart/page.tsx                 cart with live prices/stock
  checkout/success/page.tsx     receipt from the Stripe session
  api/books/route.ts            price + stock lookup for the cart
  api/checkout/route.ts         creates the Checkout Session
  api/webhooks/stripe/route.ts  order capture and stock decrement
  api/sms/inventory/route.ts    authenticated Twilio inbound stock updates
  api/telegram/inventory/route.ts  authenticated Telegram bot stock updates
components/                     header, catalog, book cards, cart provider
lib/db/                         Drizzle schema and client (Postgres or PGlite)
lib/stripe.ts                   lazy Stripe client
scripts/                        setup-db.ts, seed.ts, books.ts
drizzle/                        generated SQL migrations
```

The cart lives in `localStorage` (`folio.cart.v1`) through
`useSyncExternalStore`, so it survives reloads and syncs across tabs without an
account.

## Scripts

| Command              | Does                                            |
| -------------------- | ----------------------------------------------- |
| `npm run dev`        | Dev server with Turbopack                       |
| `npm run build`      | Production build                                 |
| `npm run start`      | Serve the production build                       |
| `npm run lint`       | ESLint                                           |
| `npm run typecheck`  | `tsc --noEmit`                                   |
| `npm run db:generate`| Generate SQL from schema changes                 |
| `npm run db:setup`   | Apply pending migrations                         |
| `npm run db:seed`    | Insert the sample catalog (idempotent)          |
| `npm run db:studio`  | Drizzle Studio (needs `DATABASE_URL`)            |
| `npm run books -- …` | List, add, or remove books (see below)           |

## Managing the catalog

There is no admin UI. The `books` CLI talks to whichever database the app uses.
Start with `list` — every other command accepts the slug, ISBN, or numeric id it
prints.

```bash
npm run books -- list

npm run books -- add \
  --title "The Left Hand of Darkness" \
  --author "Ursula K. Le Guin" \
  --isbn 9780441478125 \
  --price 15.99 \
  --stock 8

npm run books -- edit dune --price 13.50 --stock 20
npm run books -- edit dune --title "Dune (Deluxe Edition)" --description "New anniversary edition."

npm run books -- remove the-left-hand-of-darkness   # or an ISBN / id
```

`--price` is in dollars; `--stock` defaults to 0; the cover defaults to the Open
Library image for the ISBN. Pass `--slug`, `--description`, or `--cover` to
override. `edit` accepts any subset of `--title`, `--author`, `--price`,
`--stock`, `--description`, `--slug`, `--isbn`, and `--cover`; `--description ""`
clears the description. Changing `--slug` changes the book's URL — existing
links to the old slug will 404.

A book that appears in a past order cannot be deleted, because order history
references it. Stop selling it instead:

```bash
npm run books -- set-stock dune 0
```

With the embedded PGlite database, stop the dev server before running a CLI
command: PGlite allows one process at a time. With `DATABASE_URL` set, commands
can run while the app is up, and changes appear on the next request. Adding to
`scripts/seed.ts` still works for new titles, but rerunning the seed never
updates or deletes existing rows.

## Inventory by SMS

A predefined staff phone can text stock updates to a Twilio number. Every
request passes three checks before anything changes: Twilio's request
signature, the sender's phone number, and a PIN in the message body.

### Setup

1. Activate an SMS-capable number in Twilio.
2. Add these to `.env`:

   ```bash
   TWILIO_AUTH_TOKEN=...        # Console → Account Info → Auth Token
   INVENTORY_SMS_FROM=+15550001111   # the staff phone allowed to update stock
   INVENTORY_SMS_PIN=4821       # any shared secret
   ```

3. For local testing, expose port 3000 and point Twilio at it:

   ```bash
   ngrok http 3000
   ```

   Set `NEXT_PUBLIC_APP_URL` to the `https://...ngrok...` URL, restart
   `npm run dev`, then in Twilio Console → Phone Numbers → your number →
   Messaging configuration set "A message comes in" to
   `https://<public-host>/api/sms/inventory` (method `POST`).

4. Text the number from the allowlisted phone. The PIN comes first:

   ```text
   4821 SET dune 20      absolute stock
   4821 ADD dune 5       increase by 5
   4821 SOLD dune 2      decrease by 2 (never below 0)
   4821 GET dune         current stock
   ```

   `dune` can be any book slug or ISBN. The webhook replies with the new level,
   e.g. `OK dune: stock 20 (was 15).`, or a short error such as
   `No book matches "dune2".`

Replies are sent as TwiML — no outbound API call or account SID is needed.
Each `MessageSid` is recorded in `sms_commands` in the same transaction as the
stock update, so a retried delivery answers `Already processed.` instead of
adjusting stock twice.

### Security notes

- The signature check proves the request came from Twilio. The phone allowlist
  restricts which human can act. The PIN defends against sender-ID spoofing and
  a reassigned phone number. Keep all three.
- SMS is plaintext and the PIN travels with every command. Use a PIN that is not
  reused elsewhere, rotate it if the phone is lost, and keep `.env` out of git.
- Numbers that are not `INVENTORY_SMS_FROM` get an empty response — no stock
  information and no reply.
- For stronger authorization later, replace the PIN with a TOTP code or move
  inventory edits to an authenticated admin UI.

## Inventory by Telegram (free)

Telegram is the free alternative to SMS: the Bot API charges nothing per message.
Commands, PIN, stock rules, and idempotency are identical to the SMS channel.

### Setup

1. Message `@BotFather` in Telegram, run `/newbot`, and copy the bot token.
2. Find your numeric chat ID (message `@userinfobot`, or add the bot to a group
   and call `getUpdates` before registering a webhook).
3. Add these to `.env` — use a long random value for the webhook secret:

   ```text
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_WEBHOOK_SECRET=
   INVENTORY_TELEGRAM_CHAT_ID=
   INVENTORY_TELEGRAM_PIN=
   ```

4. Expose the app. For local testing, Cloudflare Quick Tunnels are free and need
   no account:

   ```zsh
   ~/.local/bin/cloudflared tunnel --url http://localhost:3000 --no-autoupdate
   ```

   Put the printed `https://....trycloudflare.com` URL in `NEXT_PUBLIC_APP_URL`,
   restart `npm run dev`, then register the webhook:

   ```zsh
   set -a; source .env; set +a
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" -d "url=${NEXT_PUBLIC_APP_URL}/api/telegram/inventory" -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
   ```

   A successful response is `{"ok":true,"result":true,"description":"Webhook was set"}`.

5. Send commands from the allowlisted chat:

   ```text
   4821 SET dune 20
   4821 ADD dune 5
   4821 SOLD dune 2
   4821 GET dune
   4821 /set dune 20
   ```

### Security notes

- Telegram does not sign webhooks the way Twilio does. Instead, `setWebhook`
  registers a `secret_token` that Telegram echoes in the
  `X-Telegram-Bot-Api-Secret-Token` header; the route rejects mismatches with 401.
- Only `INVENTORY_TELEGRAM_CHAT_ID` gets replies; other chats are ignored
  silently. The PIN is still required, so a compromised group member cannot
  change stock.
- Each `update_id` is recorded in `telegram_updates` in the same transaction as
  the stock change, so redelivered updates cannot adjust stock twice.
- A leaked bot token can be rotated in BotFather; update the env var and
  re-register the webhook.

Cloudflare Quick Tunnels are for testing: the URL changes on every restart and
there is no uptime guarantee. For production, deploy the app or use a named
Cloudflare Tunnel with a stable hostname.


## Troubleshooting

| Symptom                                        | Fix                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Checkout says "Stripe is not configured"       | Add `STRIPE_SECRET_KEY` to `.env`, then restart the dev server.                                                   |
| Payment succeeds but there is no order row     | The `stripe listen` process is not running, or `STRIPE_WEBHOOK_SECRET` does not match. Restart the listener.       |
| `books` CLI fails while the dev server is up   | PGlite allows one process. Stop `npm run dev`, run the command, then start it again.                              |
| Port 3000 already in use                       | `lsof -ti:3000 \| xargs kill`, or run `npm run dev -- --port 3001`.                                                |
| A book edit is not visible                     | Refresh the page. Confirm you edited the database the app uses: `.pglite` when `DATABASE_URL` is empty.           |
| Valid slug returns 404 after an edit           | The slug changed. Use the new URL or restore the old `--slug`.                                                    |
| Telegram bot never replies                     | Re-run `setWebhook` and inspect `getWebhookInfo`: `curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"`. Check `last_error_message`. |
| Telegram replies stop after a restart          | Quick Tunnel URLs change. Restart the tunnel, update `NEXT_PUBLIC_APP_URL`, restart the server, re-run `setWebhook`. |
| Telegram webhook returns 503                   | One of the four `TELEGRAM_*` / `INVENTORY_TELEGRAM_*` variables is empty. Fill `.env` and restart the server.        |
| SMS or Telegram command is ignored             | The sender/chat is not the allowlisted one, the PIN is wrong, or the book identifier does not match a slug or ISBN. |

## Deploying

Use a managed Postgres (Neon, Supabase, RDS) and set `DATABASE_URL`, plus the
three Stripe variables, in your host's environment. Run `npm run db:setup` and
`npm run db:seed` against that database once. PGlite is single-process and meant
for local development only. Add the deployed webhook endpoint in the Stripe
dashboard so orders are recorded in production.

## Intentionally out of scope

Accounts, reviews, wishlists, admin CRUD, inventory reservations during
checkout, shipping/tax calculation, refunds and order history. Catalog changes
go through the `books` CLI, or Drizzle Studio when `DATABASE_URL` is set.
