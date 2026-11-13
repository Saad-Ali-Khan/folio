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
| `DISCORD_BOT_TOKEN`     | for Discord | Bot token; requires the Message Content intent.                   |
| `DISCORD_CHANNEL_ID`    | for Discord | The only channel allowed to send commands.                        |
| `INVENTORY_DISCORD_PIN` | for Discord | Shared PIN that must start every Discord command.                 |
| `INVENTORY_DISCORD_SECRET` | for Discord | Shared secret between the bot process and the local route.     |
| `INVENTORY_API_URL`     | no       | Where `bot:discord` reaches the app. Defaults to localhost:3000.  |
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
  api/discord/inventory/route.ts   localhost-only stock updates for the Discord bot
components/                     header, catalog, book cards, cart provider
lib/db/                         Drizzle schema and client (Postgres or PGlite)
lib/stripe.ts                   lazy Stripe client
scripts/                        setup-db.ts, seed.ts, books.ts, discord-bot.ts
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
| `npm run bot:discord`| Run the Discord inventory bot (loads `.env.local`) |

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

   `dune` can be any book slug, ISBN, or title (multi-word titles work — the
   command parser takes the last token as the quantity). The webhook replies with the new level,
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

Typos and unknown titles no longer dead-end:

- If the identifier is close to an existing book — even misspelled — the bot
  replies with up to three numbered suggestions. Answer `yes` to apply your
  command to the first one, a number to choose another, or `no` to cancel.
  The offer expires after five minutes, and a new command replaces it.
- `ADD` with no close match creates the book: metadata (title, author, ISBN,
  cover) is pulled from Open Library, stock is set to the quantity you sent,
  and price is left at $0.00 — set it afterwards with
  `npm run books -- edit <slug> --price 9.99`. `SET`, `SOLD`, and `GET` never
  create books.

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

## Inventory by Discord (free)

Discord is the free channel for networks where the Telegram API is blocked. The
bot holds an **outbound** gateway connection to Discord, so no tunnel or public
endpoint is needed. It forwards commands to a localhost-only route guarded by a
shared secret.

### Setup

1. Create an application at
   [discord.com/developers/applications](https://discord.com/developers/applications),
   open **Bot**, and copy the token.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content** —
   without it messages arrive with empty content.
3. Invite the bot to a private server: **OAuth2 → URL Generator**, scope `bot`,
   permissions `Send Messages` and `Read Message History`.
4. Enable Developer Mode in Discord, right-click the channel, and **Copy Channel
   ID**.
5. Add these to `.env` (a PIN and secret are already generated in `.env.local`):

   ```text
   DISCORD_BOT_TOKEN=
   DISCORD_CHANNEL_ID=
   INVENTORY_DISCORD_PIN=
   INVENTORY_DISCORD_SECRET=
   INVENTORY_API_URL=http://localhost:3000
   ```

6. Run both processes — the dev server first, then the bot:

   ```bash
   npm run dev
   npm run bot:discord
   ```

7. Send commands in the allowlisted channel, prefixed with the PIN. The
   identifier can be a slug, ISBN, or title — `east of eden` works as-is:

   ```text
   4821 SET dune 20
   4821 ADD dune 5
   4821 SOLD dune 2
   4821 GET dune
   4821 /get dune
   ```

### Security notes

- `INVENTORY_DISCORD_SECRET` authenticates the bot process to the route; keep it
  out of git and do not reuse it.
- Only `DISCORD_CHANNEL_ID` gets replies; other channels are ignored silently.
  The PIN is still required, so a member of the channel cannot change stock
  without it.
- Each message ID is recorded in `discord_commands` in the same transaction as
  the stock change, so a repeated delivery cannot adjust stock twice.
- A leaked bot token can be reset in the Developer Portal; update the env var and
  restart `bot:discord`.

The bot must run on the same machine as the app because it talks to
`INVENTORY_API_URL`, and PGlite allows only one process to hold the database.

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
| Discord bot is online but ignores messages     | Enable the Message Content intent, confirm `DISCORD_CHANNEL_ID` matches, and check the PIN prefix.                  |
| Discord route returns 503                      | `DISCORD_CHANNEL_ID` or `INVENTORY_DISCORD_PIN` is empty; fill `.env.local` and restart the server.                 |
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

## Draft books and inventory audit

New books added by Discord or the CLI start as drafts and are hidden from the
catalog, book pages, and checkout. Existing positively priced books remain
published after migration. Review the edition and author before publishing.

In your configured Discord channel, prefix these commands with your PIN:

```text
<PIN> PRICE east-of-eden 14.99
<PIN> PUBLISH east-of-eden
<PIN> DRAFT east-of-eden
```

Use an ISBN or exact slug to select an edition. PRICE does not publish a draft.
If metadata lookup returns Unknown author, fix it with the CLI before publishing:

```powershell
npm run books -- edit east-of-eden --author "John Steinbeck"
npm run books -- publish east-of-eden
npm run books -- draft east-of-eden
```

Stop the local dev server before CLI database commands when using PGlite.
`npm run books -- list` includes publication status.

The stock_movements table records opening balances, receipts, and every stock
change through a database trigger, including CLI and payment updates. Discord
stock commands include the command as the reason; other updates currently use
an inventory-adjustment reason. This is a quantity audit, not a revenue ledger
or a per-user audit. Discord SOLD rejects quantities above available stock.

Regression checks: `npx tsx scripts/test-business-logic.ts` uses an isolated,
in-memory database and does not change your catalog.

Checkout now aggregates duplicate item IDs and rejects draft/unpriced books.
Stock reservations, shipping rules, payment/fulfillment lifecycle, per-operator
permissions, and sale-price snapshots still require implementation before a
production launch.

## Pakistan checkout, reservations, and fulfillment

The store now charges PKR and accepts delivery addresses in Pakistan only.
`lib/store-policy.ts` defines the shipping rules in minor units (100 paisa =
PKR 1): PKR 250 below a PKR 5,000 book subtotal, free at PKR 5,000 and above.
The cart shows the fee and total before payment; the server calculates them
again from current prices. No tax calculation is configured.

**Currency migration:** existing USD-entered book prices are preserved but all
books are moved to drafts. Review and set PKR prices before republishing. Seed
books are drafts too. Historical orders retain their USD currency label.

Stock now means **available to sell**, excluding active checkout reservations.
SET adjusts available stock, not the physical count including held copies.
Checkout atomically reserves stock and creates an immutable snapshot of titles,
ISBNs, quantities, and prices. Stripe sessions expire after one hour. Closing
Stripe or returning to the cart does not immediately cancel the session; stock
is released on confirmed expiry or explicit cancellation. Paid checkouts do
not deduct stock a second time.

Configure Stripe keys and forward webhooks as before. Subscribe to:
- checkout.session.completed
- checkout.session.expired
- checkout.session.async_payment_succeeded
- checkout.session.async_payment_failed
- charge.refunded

Only card payments are offered initially. Payment events are verified against
Stripe's latest session, the saved totals, and a Pakistan shipping address.
Unknown legacy sessions and mismatches require manual reconciliation rather
than silently inventing an order. Refund events track partial/full refunds but
do not return physical stock automatically.

Order operations (stop the local app first when using PGlite):

```powershell
npm run orders -- list
npm run orders -- show 1
npm run orders -- packed 1
npm run orders -- shipped 1 TRACKING123
npm run orders -- delivered 1
npm run orders -- return 1 2 1 return-reference-unique
npm run orders -- cancel-order 1
npm run orders -- reconcile
npm run orders -- cancel-checkout CHECKOUT_UUID
```

`return` arguments are order ID, order-item ID, quantity, and a unique return
reference. Only record inspected, resaleable items; reusing the same reference
is safe. Different partial returns require different references. Refund money
through Stripe; the CLI does not execute financial refunds. cancel-order
requires a full refund and an unshipped order. Restock inspected copies with
return separately. Shipment requires packing, payment, and a tracking number;
delivery requires shipment.

Run reconcile after downtime or webhook failures. Confirmed expired sessions
release stock; paid sessions create the order once. Lost session-creation
responses are recovered using Stripe metadata or the original idempotency key.
If the outcome cannot be proven, the command reports manual review and leaves
the stock held. Never release uncertain holds solely because local time passed.
Run `npm run orders -- reconcile-loop` as a supervised PostgreSQL-backed worker
in staging and production. It checks held orders every five minutes, recovers
known Stripe sessions, releases confirmed expired checkouts, and logs unresolved
holds for review. It never creates a payment session for an abandoned checkout.
Configure Stripe for PKR card payments before taking live orders.

Tests: `npx tsx scripts/test-orders.ts`, `npx tsx scripts/test-business-logic.ts`,
`npm run typecheck`, and `npm run lint`. Order tests use an isolated database and
simulated Stripe objects; live Stripe integration still needs test keys and a
webhook listener.

## Inventory management page

Open http://localhost:3000/admin or select **Manage inventory** in the footer.
Unlock it with your existing Discord inventory PIN. The page shows drafts,
published books, search by title/author/ISBN, and an editor for title, author,
description, PKR price, available copies, and publication status. No server
restart is needed when saving. New books received through Discord appear after
Refresh. Drafts stay hidden from shoppers.

Use **Edit**, review details and the PKR price, choose Published under Visibility,
and select **Save & publish**. Set Visibility back to Draft to unpublish.
Stock changes are audited; conflicting edits are rejected rather than overwriting
changes made by checkout or Discord. ISBN and slug are shown read-only to keep
edition identity stable.

Admin API reads and writes require a signed, HttpOnly eight-hour session. Writes
also require a matching Origin. Five incorrect PIN attempts temporarily block
login. **Lock inventory** clears the current browser session. By default the
server uses INVENTORY_DISCORD_PIN and INVENTORY_DISCORD_SECRET; set ADMIN_PIN and
ADMIN_SESSION_SECRET for separate credentials (then restart the app). Changing
the PIN or secret invalidates existing sessions. Use HTTPS when hosting it.

Run `npx tsx scripts/test-admin.ts` to test admin validation and auth against an
isolated database.

## Import books from Discord photos

Upload a clear photo of the front cover or ISBN barcode to the inventory channel
without a caption. The bot adds one copy per matched photo. A new ISBN creates
a draft, and an ISBN already in inventory increases its stock. For new ISBNs,
Folio checks Open Library, verified British Council editions in
`lib/isbn-catalogs.ts`, then the public HathiTrust Bibliographic API. British
Council coverage grows as verified editions are added to the list. If none of
these sources yields a match, the draft keeps its ISBN for review.

Front-cover scanning reads the printed title and author locally. Use a clear
Latin-script cover with both visible. A confident catalog match creates or adds
to a draft for edition review. Cover-only imports have no verified ISBN. Scan the
barcode to identify a specific edition. If the bot cannot distinguish a match,
it asks for a clearer photo or the barcode.

The Discord server owner can use caption-free imports by default. Set
`DISCORD_PHOTO_USER_IDS` to a comma-separated list of Discord user IDs to
choose who can use them. Existing PIN captions still support quantities and
the `ADD`, `SET`, and `SOLD` commands.

## English and original display titles

New Discord imports prefer a verified English edition title from the same Open
Library work. If the work/catalog title differs, the bot pauses the import and
asks whether to use English (recommended) or the original/catalog title. The
scanned ISBN and cover remain those of the scanned edition. Selecting an English
display title does not mean the physical copy is English-language.

Choose **English**, **Original title**, or **Cancel** using the buttons in the
bot's reply.

Only the initiating Discord user in that channel can resolve the request. Choices
are stored in the database, expire after 15 minutes, and add stock only once.
If no verified English title is available, the import keeps its edition/catalog
title and explicitly asks you to review it manually; translations are not guessed.
Open Library's work title is labeled original/catalog because it is not always
reliably identified as the original-language title.

To review an existing book without adding stock:

```text
<PIN> TITLES 9780141037455
```

This offers the same title choice and changes only the display title, leaving
its ISBN, cover, slug, price, and stock alone. Existing titles are never silently
rewritten. Restart `npm run bot:discord` after updating so it forwards the
Discord user ID needed to bind title choices to the requester.

Test with `npx tsx scripts/test-title-choice.ts` and `npx tsx scripts/test-discord-photo.ts`.

## Staging and production setup

Use Node.js 22.9 or later and a dedicated PostgreSQL database for each environment.
Set `DATABASE_URL` and the HTTPS `NEXT_PUBLIC_APP_URL` before building and starting
the app. Run `npm run db:setup` before deploying. Pending migrations and their
ledger entries commit together. Back up the target database and verify that the
backup restores before migrating an existing store.

Set `ADMIN_PIN` to a generated access code of 16–128 characters and
`ADMIN_SESSION_SECRET` to a separate random value of at least 32 characters.
Production rejects Discord credentials for admin login. Rotate the shared
Discord inventory PIN before launch. Set `TRUSTED_CLIENT_IP_HEADER` to the
single-address header your reverse proxy overwrites on each request. Block
direct access to the app server so a caller cannot supply its own IP header.
Checkout and admin login require this header in production.

When Discord suggests an edition for an ambiguous inventory command, the
requester replies with `<PIN> CONFIRM <code> <number>` in the same channel.
Use `CANCEL` in place of the number to cancel. Exact ISBN and slug commands
still run directly.

For Stripe staging, configure test credentials and the signed webhook, then
start the web app, Discord bot, and `npm run orders -- reconcile-loop` under
your host's process supervisor. Use the same Stripe account for the web app,
webhook, and recovery worker. The worker logs uncertain reservations for
operator review. Check its logs and Stripe's webhook deliveries after a test.

Before opening checkout, verify a PKR purchase with a Pakistan address, a
cancelled or expired checkout, a repeated checkout request, and a partial
refund followed by fulfillment of the remaining items. Confirm the order,
stock balance, and refund in the database after each flow. Run lint and the
test scripts against the release and complete a production build on the
target host before using live credentials.
