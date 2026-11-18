# Folio backlog

## Admin sign-in

- [x] On `/admin`, rename **Inventory PIN** to **Admin access code** and **Incorrect PIN** to **Incorrect admin access code**. Explain that the live site uses the code set during Cloudflare deployment. The Discord PIN is for Discord commands. Implemented locally and pending the next Cloudflare deployment.

## Business rules review for November 17, 2026

### Checkout and customer orders

- [x] **Private WhatsApp checkout test.** Meta accepted the message, and the test recipient confirmed delivery on November 18, 2026. The duplicate checkout submission was blocked, and the test created no COD request or stock change. Meta’s signed dashboard callback returned HTTP 200 on Cloudflare.

- [ ] **Site-initiated WhatsApp confirmations for live orders.** Public checkout uses the manual WhatsApp flow. Register the separate production number, get the COD utility template approved, and connect live checkout and customer replies. Draft template: `folio_cod_confirm`, Utility, English, with a **Confirm order** quick reply. Body: “Folio received cash-on-delivery request {{1}} for {{2}}. Tap Confirm order to confirm your request.” Sample values: `AB12CD34EF56` and `Rs 3,250`.

- [x] **Live COD smoke test.** On November 18, 2026, a controlled Quetta request for Rs 3,000 in books plus Rs 250 shipping was approved as order #3. A follow-up added a second title to the same order for Rs 4,050 with one shipping fee. The cart cleared after approval of each request, available stock reached zero for the tested editions, and cancelling the test order restored both copies. The test used matching synthetic buyer details. The free-shipping threshold and preservation of later-added cart copies are covered by automated tests.

- [x] **Cart retains purchased books.** The browser checks COD request status and removes only the approved copies. It keeps copies added later and preserves the cart if the WhatsApp handoff is abandoned or the request expires. Live cart cleanup verified.
- [x] **Repeat COD requests.** Verified live that follow-ups add books to the existing unshipped order for the same WhatsApp number, name, and address. Shipping is recalculated from the combined subtotal.
- [x] **Delivery area and COD cap.** Offer nationwide Pakistan delivery and remove the Rs 5,000 COD order cap. Checkout still uses PKR, manual WhatsApp confirmation, a Pakistani mobile number, and a required name, street address, and city or town. The apartment or landmark field is optional. Implemented locally and pending the next Cloudflare deployment.
- [ ] **Shipping rates.** Keep Rs 250 shipping below a Rs 5,000 book subtotal and free shipping at Rs 5,000 and above for nationwide delivery, as confirmed on November 17, 2026. Keep this item open for future review.
- [ ] **Cart limits and revalidation.** Keep the maximum of 10 copies per listing and 50 submitted lines, as confirmed on November 17, 2026. Duplicate listing quantities are combined. Folio checks current stock and prices when creating and approving requests. Keep this item open for future review.
- [x] **WhatsApp approval and request lifetime.** Keep the 24-hour expiry, as confirmed on November 17, 2026. The operator verifies the reference and sender number. Approval reserves stock once. The admin queue shows up to 100 pending requests by earliest expiry. Later checkouts clean up requests more than 24 hours past expiry, preserving approved follow-up references linked to an existing order.
- [x] **Rate limits.** Keep 5 checkout requests per phone number and 15 per IP address per 15 minutes, as confirmed on November 17, 2026.

### Fulfillment, returns, and cash

- [x] **Fulfillment and cancellation.** Manage packing, shipment, delivery, and cancellation in the admin COD fulfillment section. Shipping requires a tracking number. Cancelling before dispatch restores stock. Implemented locally and pending the next Cloudflare deployment.
- [x] **Refusals and returns.** In admin, mark the parcel refused, record receipt when it returns, and restock inspected, resellable copies separately. Find older orders by order number. The server prevents duplicate restocks and caps cumulative returns at the ordered quantity. Refusal history is visible in the CLI. Implemented locally and pending the next Cloudflare deployment.
- [ ] **Cash collection and remittance.** Keep using the order CLI for now. Admin controls were deferred on November 17, 2026. Collection after delivery must match the order total exactly. Record one courier remittance with a statement reference and a net payout between zero and the order total.

### Catalog and inventory

- [x] **Drafts and publishing.** Keep the current rules, as confirmed on November 17, 2026. New listings start as drafts and Discord imports start at zero price. Publishing requires a positive PKR price and a non-placeholder author. Published listings with zero stock stay visible as out of stock.
- [x] **Edition-level stock safeguard.** Each listing keeps its own stock and price. Discord asks for the edition when an inventory command matches multiple listings. ISBN and `slug:` identify the intended listing directly. Implemented locally.
- [x] **Stock history and adjustment reasons.** Show the existing before-and-after stock history per edition in admin and require a reason when the admin editor changes available copies. Implemented locally and pending the next Cloudflare deployment.
- [x] **Admin edit and deletion rules.** Keep the existing safeguards, as confirmed on November 17, 2026. Stale edits or deletes require refreshing. Order-linked listings and legacy reservations block deletion. Moving a book to Draft hides it. ISBN and slug are read-only in the GUI.
- [x] **Admin input limits.** Web admin and Discord `PRICE` share the Rs 1,000,000 per-listing price cap and accept up to two decimal places. The web admin accepts 0 to 1,000,000 whole copies. Implemented locally.

### Discord imports and admin access

- [ ] **Discord permissions and photo limits.** Deferred on November 17, 2026. Review configured channel and PIN requirements, owner or allowlist access for caption-free photos, one copy per matched caption-free image, the 12 MB photo limit, the 999-copy caption limit, and the ISBN barcode requirement for photo `SET` and `SOLD`.
- [ ] **ISBN and cover matching.** Known ISBNs update the matching edition. New ISBNs create drafts using Open Library, curated British Council matches, or HathiTrust. Failed lookups save ISBN-only drafts. Confident cover-only matches create or update unverified drafts, and uncertain matches ask for a better photo or barcode.
- [ ] **Title and edition confirmation.** Review the English versus original/catalog title prompt, preservation of the scanned edition's cover and ISBN, and the 15-minute title choice and 5-minute stock confirmation for the initiating user. Stock prompts cover exact titles shared by multiple listings as well as fuzzy matches.
- [ ] **Admin authentication.** Review the separate 16–128 character production access code, 8-hour session, 5 sign-in attempts per IP per minute, and same-origin checks for changes. See the admin sign-in wording item above.
- [ ] **Legacy features.** Confirm which Stripe, SMS, and Telegram workflows should remain available for local or historical use. Live Cloudflare checkout uses COD.
