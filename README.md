# Folio

## Private R2 photo storage

The R2-enabled release binds `PHOTO_BUCKET` to private Standard bucket
`folio-photos`. Only the local importer and backup tool need bucket-scoped S3
credentials in ignored `.env.local`; never copy those credentials into release
archives. Apply migrations 0014–0015 before deploying this release. Keep local
`PHOTO_STORAGE` unset until production photo checks pass, then set it to `r2`
and restart the local inventory API. New cover/title-choice records then hold
an object reference instead of base64. Originals are preserved during cutover,
then reclaimed only through the verified-backup cleanup command.

`npm run photos:migrate -- --plan` is read only. `--copy` copies and verifies;
`--verify` rechecks reserved objects; `--link` verifies and links existing photos
without removing their database bytes. Limits are 512 KiB/photo, 8 GB tracked
capacity, 10,000 PUT attempts and 1,000,000 read attempts/month. These control
Folio's paths, not account-wide Cloudflare spending. Failed attempts stay counted.
Do not reset the ledger or switch its bucket/account. Unresolved uploads require
verification before another attempt; no automatic object retry is performed.

`npm run backup:create` now includes ready R2 image bytes and verifies offline
photo recovery. Keep archive/key copies off-device separately. The portable tool
stops at 64 MiB of external photos; plan a dedicated object backup before that
limit. A database-only dump does not contain R2 images.

Before rolling back to pre-R2 code, disable new R2 imports, run
`npm run photos:migrate -- --rollback`, and require success. This restores verified
legacy image bytes for listings and title choices without stock changes. If R2
is unavailable, use a verified encrypted backup and a new-database recovery.
Do not delete Neon fallbacks until deployed R2 serving, a new import and current
backup/rollback checks have passed. See [design documentation](docs/architecture.md).

## Retained covers and photo cleanup

Failed cover recognition now retains the image privately for 15 minutes. Send its
barcode next from the same Discord account and channel; select the matching image
in the preview prompt before stock is received. Up to four covers can wait per
account/channel. Use Barcode only if none match, or Cancel scan to add nothing.
Any English/original title choice follows that confirmation. Cleanup runs through
the local supervisor; keep it running. After sleep/shutdown, physical deletion
resumes at startup, while expired images cannot be selected or previewed.

To reclaim old base64 copies: run `npm run photos:migrate -- --prepare-reclaim`,
create a fresh verified backup, then run `npm run photos:migrate -- --reclaim "PATH_TO_BACKUP"`.
Cleanup requires matching archive/live
bytes and leaves active title choices and inventory quantities unchanged.

## Production monitoring and incident response

`npm run monitor:production` performs three unauthenticated, read-only checks:
the full storefront HTML (including catalog failure text despite HTTP 200), a
real database-backed availability query using an arbitrary valid book ID, and
the admin books API's expected HTTP 401. No listing needs to exist at that ID.
Each failed check retries once after two seconds, with a 30-second deadline per
request and a 512 KiB response limit. Failures exit nonzero; repeated response
times above five seconds merit investigation. Diagnostics contain no page bodies,
customer details, tokens, or database credentials. Override the HTTPS origin with
`FOLIO_MONITOR_ORIGIN` when testing another deployed environment.

`.github/workflows/production-monitor.yml` runs hourly at minute 23 UTC and can
also run manually. It needs no repository secrets or npm installation and uses
read-only repository permission. Standard GitHub-hosted runners are
[free for public repositories](https://docs.github.com/en/actions/concepts/billing-and-usage).
Checks make three requests per successful run (about 72/day); a fully failed run
makes six. These checks can wake Neon; hourly polling allows it to suspend
between runs. Do not switch database-backed checks to frequent polling without
reviewing compute usage. This is a basic smoke monitor, not an uptime SLA or a
checkout, WhatsApp, photo, or local-PC monitor.

After pushing the workflow to `main`:

1. Open GitHub **Settings → Notifications → Actions** and enable email notifications
   for failed workflows. The operator confirmed test email delivery on November 22, 2026.
2. In the repository **Actions → Folio production checks**, disable and re-enable
   the workflow from its menu using your own account. This assigns scheduled-run
   notifications to you, per [GitHub's notification rules](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs).
3. Use **Run workflow** normally and confirm the three checks pass. Then optionally
   select **notification_test** for one manual run. That run intentionally fails
   after the checks so you can verify email delivery; it does not simulate a real
   customer transaction or change the storefront. The normal hourly run leaves
   this option off.

Scheduled runs can be delayed. Public-repository schedules are
[disabled after 60 days without repository activity](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).
Check the last successful run weekly. This workflow is prepared and tested
locally and passed on GitHub. The operator confirmed failure-test email delivery on November 22, 2026; three recent scheduled runs were independently verified successful on November 23 under the operator's GitHub actor.

### Usage review and alerts

Availability probes do not measure account allowances. Keep this checklist open
until the actual Cloudflare and Neon dashboards have been inspected:

| Service | Review | Proposed warning / urgent threshold |
|---|---|---|
| Cloudflare | Account-wide daily Worker requests, Worker errors/CPU limits, current plan, and any paid usage | 80% / 90% of the actual account allowance |
| Neon | Project compute CU-hours, database storage, history and public network transfer; current plan and reset dates | 80% / 90% of each actual included allowance |

Review weekly while traffic is low, daily after a warning, and before bulk photo
imports. Cloudflare's [Free request limit](https://developers.cloudflare.com/workers/platform/limits/)
is shared at account level; inspect all Workers, not only Folio.
For paid accounts, inspect [Billing → Spend limits](https://developers.cloudflare.com/billing/manage/spend-management/)
and existing notification recipients. Dollar spend alerts do not warn of nearing
a free request quota. Do not upgrade or enable paid usage just to add monitoring.

In Neon, open the project's **Overview → Usage** and **Organization → Billing**;
the [usage documentation](https://neon.com/docs/introduction/monitor-usage)
explains that metrics may lag and transfer usage is visible on the Projects page
before charges. The [plan table](https://neon.com/docs/introduction/plans)
lists spending notifications for paid plans, not Free. Thus this change does not
claim automatic free-tier quota alerts are active. Verify this account's actual
allowances rather than reusing older estimates; wire available provider alerts
or a separately authorized usage collector once account access is available.

### Release tracking and rollback

`deploy/cloudflare/release-history.json` records the last verified Worker version
and source snapshot. After every deployment, append its actual version ID, exact
source commit (or source snapshot if the commit is unknown), date, migration
compatibility notes, and successful smoke checks. A GitHub push by itself does
not deploy this project. Avoid guessing a source commit for an older build.

For an incident, inspect the monitor's failing check, then in the authenticated
WSL build directory that contains the Folio Wrangler configuration run:

```bash
npx wrangler deployments list --name folio
npx wrangler tail folio --format pretty
```

Inspect timeouts, exception counts, and request IDs privately. Confirm the last
known good version still exists and works with the current database schema and
bindings. If reverting code is appropriate, stop the tail with Ctrl+C and run:

```bash
npx wrangler rollback <VERIFIED_GOOD_VERSION_ID> --name folio
```

This is an explicit incident action, not an automatic monitor response. Cloudflare
[rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
changes deployed code; it does not roll back Neon data. Check bindings/secrets and
assets, run `npm run monitor:production` from the source checkout, and check the
cart and admin manually. Record the resulting deployment and incident outcome.
For incompatible schema/data damage, use the documented backup/new-database
recovery procedure; never reverse a live migration merely to satisfy old code.

## Reviewing a book's edition

Open **Admin → Edit → Edition details** to enter publisher, translator, language
and edition/printing. Leave unknown values blank. Record the physical page or
reliable edition URL under **Sources / evidence**; check the verification box
only after reviewing the entered details. These values save atomically with the
existing book form. Reviewed, nonempty values appear on the public detail page.
Fields that exactly match a stored catalog record for the listing's linked ISBN
also appear, attributed to that catalog; this does not mark manual edits verified.
Unsupported or mismatched fields stay hidden until reviewed. A title/cover match
alone never establishes a translator. The old unconditional
“Paperback” label has been removed because the format was not verified.

Expand **Review catalog proposals** to compare stored covers and source links.
New cover imports retain up to five close artwork candidates, including near
ties that could not be chosen automatically. Up to ten proposals are retained
per listing. **Find proposals from saved cover** runs only in the local admin
(the photo must already be saved); Cloudflare admin can review saved proposals.
The local search uses the existing Readings, Open Library and Google Books
adapters, with no new paid service, and allows three searches per listing per
minute. An outage or lack of a close match can leave no proposals; it is not
proof that no edition exists. Translators and missing language/edition data
must still be checked from reliable evidence.

Review proposals tolerate more framing/exposure variation than automatic cover
selection. Such results carry **Possible cover match** warnings. The automatic
artwork threshold stays strict; a possible match does not verify the physical
edition or ISBN. This handles photographed paper whose lighting/background differ
from a digital cover without silently substituting the edition.

**Use catalog details** fills publisher/source and any translator, language and
edition details explicitly supplied by the catalog, clears unsupported fields,
and clears verification. Readings proposals fetch the exact matching book record
for its reported language and binding/publication year; Open Library contributes
explicit translator credits, language and edition name, and Google Books supplies
reported language/publication year. Descriptions about other translations are
never translator evidence. Existing proposals need a new saved-cover search to
retrieve these additional fields. Using catalog details selects that cover by
default; untick its separate checkbox to retain the current image. A known-ISBN
listing rejects a catalog cover whose ISBN differs.
For a manual work key, the catalog ISBN is also staged in the ISBN input, with
physical confirmation still unchecked and the optional note empty. Complete that physical check or
choose **Keep ISBN unlinked** before saving. Existing linked ISBNs are untouched.
Nothing applies until you save the book. Search stores proposals only,
without modifying the listing, stock, prices, photos, or reviewed fields.

A cover-only listing also offers **Link the physical copy's ISBN**. Enter or review an
ISBN-10 or ISBN-13 and confirm the
physical check. The server records this attestation and a matching stored catalog source automatically; a written ISBN note is optional. ISBN checksums are validated and ISBN-10 is stored as equivalent
ISBN-13. The book ID, slug, stock, uploaded photograph and order links stay intact.
An ISBN already linked to another listing stops the entire save with HTTP 409,
including any staged title/price/stock edits; no automatic merge or restock occurs.
Replacing an existing different ISBN is deliberately unsupported. The database
also rejects ISBN-10/13 aliases even during simultaneous imports. Discord imports
recognize those aliases as the same verified ISBN edition.

Migration `0012_book_editions.sql` adds a separate metadata table so older Worker
code can continue using `books`. Migration `0013_canonical_isbn.sql` adds the
canonical-key function and unique index. Back up first, then run `npm run db:setup`
before starting/deploying this UI. If existing equivalent ISBNs collide, migration
fails and rolls back; review them rather than merging automatically. The new UI
requires these migrations. Existing books are not backfilled with guessed data.
Run `npx tsx scripts/test-book-editions.ts` for metadata, stale-edit, ISBN-alias,
transaction rollback, deletion and stock-protection checks.

## Running local Discord and OCR reliably

From the Folio directory in PowerShell, use Node 24 or newer and the existing
`.env.local` configuration. Set `INVENTORY_API_URL=http://127.0.0.1:3000` (the
existing `http://localhost:3000` value is also accepted).

```powershell
cd "C:\Users\xsaaa\Documents\Codex\2026-11-11\ho\folio"
npm run local:up
npm run local:status
```

The hidden launcher starts a loopback-only Next development server using webpack,
then connects Discord once the local inventory API and OCR assets are ready.
Allow the first route compilation to finish, then run `local:status` again:
both `api.ready` and `bot.ready` should be `true`. Do not also run `npm run dev`
or `npm run bot:discord`. An occupied port or existing bot lock is reported;
the launcher does not terminate an independently started service.

`npm run local:stop` stops only the launcher's processes. `npm run local:start`
keeps the launcher in the current window for troubleshooting. Component logs are
under `.folio-local/logs`; each retains a 5 MiB file and two rotated copies.
Configured secrets and database URLs are redacted. Treat logs and the entire
Git-ignored `.folio-local` directory as private. Do not share `control.json`.

To start automatically at Windows logon, run `npm run local:install-startup`
in your own PowerShell session. It registers the current user's limited-privilege
**Folio Local Inventory** task, launches hidden, and stores no passwords. If
script execution is blocked, use the manual launcher for now rather than changing
machine security policy. Remove the task with
`powershell.exe -NoProfile -File scripts/install-local-startup.ps1 -Remove`.
The installer refuses to overwrite an existing task. Reinstall after moving the
project or replacing the Node executable. The operator installed the task successfully; automatic startup after the next
Windows logon remains to be verified.

The supervisor retries crashes with exponential delay (up to 60 seconds), waits
through startup compilation, and restarts a bot whose Gateway readiness or
heartbeat remains unavailable for 90 seconds. Three failed API probes suspend
the bot; after the two-minute startup/recovery grace the API is restarted too.
Inventory requests are never replayed by the supervisor. After interruption,
inspect the saved listing before resending an upload.

Health checks run every 15 seconds and inspect API configuration, native image
support, and English OCR assets. They do **not** query Neon, run an OCR job, or
prove an import will succeed. The PC must be awake, connected, and logged in;
Cloudflare storefront availability is independent of these local services.
Run lifecycle/redaction tests with `npx tsx scripts/test-local-services.ts`.

A small independent bookstore with a searchable catalog, inventory admin, and
cash on delivery checkout with manual WhatsApp confirmation.

## Knowledge base

- [Architecture and design decisions](docs/architecture.md)
- [Backlog and business rules under review](BACKLOG.md)

## Stack

- Next.js 16 (App Router, request-time rendering) + React 19
- TypeScript, Tailwind CSS v4
- Drizzle ORM on Postgres (postgres.js), with embedded PGlite for local dev
- WhatsApp Business click to chat for COD requests

## Cash on delivery

Run `npm run db:setup`. Set `COD_WHATSAPP_NUMBER` to the shop's WhatsApp
Business number in international format and restart Folio. Checkout accepts
delivery addresses nationwide in Pakistan. Customers enter their city or town,
and the shop reviews the address during WhatsApp approval. The shipping fee is
Rs 250 below a Rs 5,000 book subtotal and free at Rs 5,000 or more.

Customers enter a Pakistan delivery address and send the request reference
from their WhatsApp number. In `/admin`, unlock inventory and select **Load
requests** under **COD requests**. Review the address and cart, then enter the
reference and sender number from the incoming message. Approval creates the
order and reserves stock. Requests expire after 24 hours. An approved follow-up
for the same WhatsApp number, name, and address adds books to the existing
unshipped order. Shipping is recalculated from the combined book subtotal. A
packed order goes back to the packing queue. After dispatch, wait for delivery
or return before approving another request. Reply on WhatsApp with the order
number and the confirmed total.

When the customer returns to Folio in the same browser, the cart checks for
approval and removes the purchased copies. Copies added after submission stay
in the cart. Pending or expired requests preserve the cart.

Use **COD fulfillment** in `/admin` to review active orders and their items,
delivery details, and totals. Mark orders packed, shipped, and delivered in
sequence. Enter the courier tracking number when marking an order shipped.
Cancel an unshipped order from the same section to release its copies back to
available stock. Use **Mark refused** for a shipped parcel the buyer refuses,
then **Mark return received** when the parcel is back. Inspect the books and
use **Restock copies** for the resellable quantity on each order line. Use
**Find by order number** to reopen a returned or delivered order later. The
order commands remain available for terminal use.

```bash
npm run orders -- list
npm run orders -- show ORDER_ID
npm run orders -- packed ORDER_ID
npm run orders -- shipped ORDER_ID TRACKING_NUMBER
npm run orders -- delivered ORDER_ID
npm run orders -- cod-collected ORDER_ID COLLECTED_PKR
npm run orders -- cod-remitted ORDER_ID NET_PAYOUT_PKR STATEMENT_REFERENCE
```

Match the courier statement to the tracking number before recording a payout.
Use `cod-cancel ORDER_ID` before dispatch to restore stock. For a refused
shipment, use `cod-refused ORDER_ID`, then `cod-returned ORDER_ID` once the
parcel is back. Use the existing `return` command for each inspected,
resellable item. Stop the dev server before running CLI commands on PGlite.

The Stripe instructions below cover historical Stripe payments and outstanding
reservations from before the switch to cash on delivery.

## Uploaded book covers

Discord front-cover imports save the uploaded photo as the second image on
the book detail page after identification and any title confirmation. The
latest accepted cover upload replaces the previous second image. Barcode
scans keep their existing inventory behavior. Photos are resized to WebP,
stored in the database, and become public when the listing is published.
Existing edition matching and stock rules apply.

Run `npm run db:setup` against the database shared by the importer and
storefront before running this version. This adds `book_photos` through
`0011_book_photos.sql`. Deploy the updated storefront and restart the local
Discord/OCR app to activate photo display and capture.

## WhatsApp test setup

Use Meta’s test number and a recipient already verified in **Step 1. Try it
out**. Set `WHATSAPP_TEST_PHONE_NUMBER_ID`, `WHATSAPP_TEST_ACCESS_TOKEN`, and
`WHATSAPP_TEST_RECIPIENT` in local `.env.local` or as Cloudflare Worker secrets.
Use international format for the recipient. Sign in to admin and click **Send
test message** under **WhatsApp test**. The sender uses Meta’s sample template.

To test checkout, stay signed in to admin, add a book to your cart, and
enter the configured Pakistani test number in the COD form. Select **Send a
private WhatsApp test from checkout** and click **Send WhatsApp test**. The
test validates stock and the total, then sends Meta's sample directly to
the phone. The cart, stock, and order history stay unchanged. Identical
test carts can attempt one send per recipient every 15 minutes.

For callback testing, set `WHATSAPP_APP_SECRET` to the Meta App Secret and
`WHATSAPP_WEBHOOK_VERIFY_TOKEN` to a separately generated random value. After
deploying the route, enter the live site’s `/api/webhooks/whatsapp` URL and the
same verify token in Meta’s webhook configuration. Subscribe to `messages` and
send a dashboard test event. The Worker verifies the callback signature and
logs a generic receipt. Customer checkout still uses the manual WhatsApp link.

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
On the live site, unlock it with the admin access code set during deployment.
The page shows drafts,
published books, search by title/author/ISBN, and an editor for title, author,
description, PKR price, available copies, and publication status. No server
restart is needed when saving. New books received through Discord appear after
Refresh. Drafts stay hidden from shoppers.

Use **Edit**, review details and the PKR price, choose Published under Visibility,
and select **Save & publish**. Set Visibility back to Draft to unpublish.
Stock changes are audited; conflicting edits are rejected rather than overwriting
changes made by checkout or Discord. Slug and already-linked ISBN identity stay
read-only; cover-only work keys can be linked to a physically verified ISBN
through the separate evidence and collision safeguards described above.

Open an edition's editor and choose **Load history** under **Stock history**
to review the date, quantity before and after the change, and reason. Changing
**Available copies** in the editor requires an adjustment reason.

Admin API reads and writes require a signed, HttpOnly eight-hour session. Writes
also require a matching Origin. Five login attempts per IP per minute are allowed.
**Lock inventory** clears the current browser session. Production requires its
own `ADMIN_PIN` and `ADMIN_SESSION_SECRET`. Local development falls back to
`INVENTORY_DISCORD_PIN` and `INVENTORY_DISCORD_SECRET` when the corresponding
admin setting is missing. Changing the access code or session secret invalidates
existing sessions. Use HTTPS when hosting it.

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

Cover-only imports check Readings, Open Library edition records, and Google Books for visually matching artwork after identifying the title and author. These sources cover multiple publishers. Visible imprint clues (including Readings, Penguin, Puffin, Oxford, Wordsworth, Vintage, Scholastic, HarperCollins, Macmillan, and Liberty) narrow the candidates. A strong, unambiguous match supplies the first image; the uploaded photo remains second. Repeated evidence for the same catalog ISBN is grouped across sources. The draft description records the source and edition uncertainty. Visual matching never assigns an ISBN or translator, and unavailable or uncertain matches preserve the work-only draft. No paid search service is required. Google Books may throttle public requests; optionally set `GOOGLE_BOOKS_API_KEY` locally for your application's quota. A source outage does not stop the other catalogs. Arbitrary publisher websites and full title pages are not searched. Run `npx tsx scripts/test-publisher-cover.ts` for the artwork resolver regression checks.

## Staging and production setup

### Application backups and recovery

Run `npm run backup:create` from the repository root. It reads production in a
repeatable-read, read-only transaction, saves a gzip-compressed AES-256-GCM
archive under `.folio-backups`, and verifies the exact recovery SQL against a
new in-memory PGlite database. Every public application table, stored photo,
applied migration, and public sequence is included. Row checksums, column
layouts, and sequence state must match before a `.verified.json` report is
written. Pending, unapplied migration files are excluded, so this also works
before applying a new migration.

The first run creates `.folio-backup-key`; alternatively provide the same
32-byte base64 key through `FOLIO_BACKUP_KEY`. The key and backup directory are
ignored by Git. Keep the key private and make a separate, safe copy: losing it
makes the encrypted archives unrecoverable. A backup and key on the same PC
do not protect against losing that PC. Off-device storage is deferred. A Codex
reminder prompts for a manual backup daily at 9 PM America/Toronto; it does not
run the command. No automatic backup job has been installed. Also create a
backup before bulk imports or deployments.

Recheck an archive with:

```powershell
npm run backup:verify -- ".folio-backups\BACKUP_NAME.foliobackup"
```

For disaster recovery, use a **new empty Postgres database**. This command
explicitly creates a private, plaintext SQL recovery file next to the archive:

```powershell
npm run backup:recover-sql -- ".folio-backups\BACKUP_NAME.foliobackup" --allow-plaintext
```

Install the official PostgreSQL client tools, configure `PGHOST`, `PGDATABASE`,
`PGUSER`, and SSL/authentication for the new target privately, then run
`psql -X -v ON_ERROR_STOP=1 -f "PATH_TO_BACKUP.foliobackup.recovery.sql"`.
The SQL refuses a nonempty public schema, recreates the applied migrations,
restores data in foreign-key order without generating duplicate stock audit
rows, restores sequences (including gaps), and commits atomically. Verify the
new database and storefront before changing the live `DATABASE_URL`. Do not
apply it to production as an in-place migration rollback. After a bad
migration, preserve the affected database and recover the pre-migration backup
into a new target; reconcile any legitimate orders received since the backup
before cutting over. Remove plaintext recovery files after use.

This is a Folio application recovery bundle, not a full PostgreSQL cluster
dump. Roles, permissions, extensions outside the migration files, non-public
schemas, Neon account settings, and runtime secrets are not included. Source
data over 64 MiB is refused by this bounded in-memory exporter; use native
`pg_dump` for larger databases or independently managed schema objects. For
native exports, Neon recommends a direct/unpooled connection and the
`pg_dump`/`pg_restore` tools. See [Neon's backup guide](https://neon.com/docs/manage/backup-pg-dump)
and [history-window documentation](https://neon.com/docs/postgres/backup-restore/history-window).
The project's configured history window must be checked in its console; the
documented plan limit does not prove that this particular account has it enabled.

### Cloudflare Workers

Run `npm run build:cloudflare` from the repository root on Linux to create
the Worker bundle and Wrangler config. Once Wrangler is authenticated and the
Worker secrets are configured, run `npm run deploy:cloudflare` to build and
publish a new version from the same directory.
The Cloudflare build serves the storefront, checkout, and admin. Run the
Discord bot and its Folio photo API locally against the same PostgreSQL
database.

Set `DATABASE_URL` to the pooled Neon URL, and set `ADMIN_PIN`,
`ADMIN_SESSION_SECRET`, and `COD_WHATSAPP_NUMBER` as Worker secrets.
`deploy/cloudflare/wrangler.jsonc` sets the preview origin and trusted IP
header. Update the origin when switching to a
custom domain. Apply migrations with `npm run db:setup` separately from
the Worker deployment.

### Node server

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
Use `CANCEL` in place of the number to cancel. An ISBN or an unambiguous slug
runs directly. If a slug is also a shared title, use `slug:<slug>` to select it
explicitly, for example `<PIN> SOLD slug:dune 1`. Price, visibility, and title
commands also require a unique match.

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
