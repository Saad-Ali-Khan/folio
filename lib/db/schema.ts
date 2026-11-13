import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const books = pgTable("books", {
  id: serial("id").primaryKey(),
  isbn: text("isbn").notNull().unique(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  author: text("author").notNull(),
  description: text("description").notNull().default(""),
  priceCents: integer("price_cents").notNull(),
  stock: integer("stock").notNull().default(0),
  coverUrl: text("cover_url"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  stripeSessionId: text("stripe_session_id").notNull().unique(),
  checkoutId: text("checkout_id").unique(),
  currency: text("currency").notNull().default("pkr"),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  shippingCents: integer("shipping_cents").notNull().default(0),
  shippingAddress: jsonb("shipping_address"),
  paymentIntentId: text("payment_intent_id").unique(),
  refundedCents: integer("refunded_cents").notNull().default(0),
  fulfillmentStatus: text("fulfillment_status").notNull().default("unfulfilled"),
  trackingNumber: text("tracking_number"),
  email: text("email"),
  totalCents: integer("total_cents").notNull(),
  status: text("status").notNull().default("paid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id),
  title: text("title").notNull(),
  priceCents: integer("price_cents").notNull(),
  qty: integer("qty").notNull(),
  returnedQty: integer("returned_qty").notNull().default(0),
});

export const smsCommands = pgTable("sms_commands", {
  id: serial("id").primaryKey(),
  messageSid: text("message_sid").notNull().unique(),
  fromNumber: text("from_number").notNull(),
  command: text("command").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const telegramUpdates = pgTable("telegram_updates", {
  id: serial("id").primaryKey(),
  updateId: text("update_id").notNull().unique(),
  chatId: text("chat_id").notNull(),
  command: text("command").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const discordCommands = pgTable("discord_commands", {
  id: serial("id").primaryKey(),
  messageId: text("message_id").notNull().unique(),
  channelId: text("channel_id").notNull(),
  command: text("command").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Book = typeof books.$inferSelect;
export type Order = typeof orders.$inferSelect;

export const stockMovements = pgTable("stock_movements", {
 id: serial("id").primaryKey(), bookId: integer("book_id").notNull(),
 delta: integer("delta").notNull(), before: integer("before_qty").notNull(),
 after: integer("after_qty").notNull(), reason: text("reason").notNull(),
 createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
});

export type CheckoutLine = {bookId:number; title:string; author:string; isbn:string; priceCents:number; qty:number};
export const checkouts = pgTable("checkouts", {
 id: text("id").primaryKey(),
 clientKey: text("client_key"),
 status: text("status").notNull().default("held"),
 stripeSessionId: text("stripe_session_id").unique(),
 lines: jsonb("lines").$type<CheckoutLine[]>().notNull(),
 params: jsonb("params").$type<import("stripe").default.Checkout.SessionCreateParams>().notNull(),
 createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
});

export const requestLimits = pgTable("request_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const discordStockChoices = pgTable("discord_stock_choices", {
  id: text("id").primaryKey(),
  sourceMessageId: text("source_message_id").notNull().unique(),
  userId: text("user_id").notNull(),
  channelId: text("channel_id").notNull(),
  bookIds: jsonb("book_ids").$type<number[]>().notNull(),
  verb: text("verb").$type<import("../inventory-command").InventoryVerb>().notNull(),
  qty: integer("qty"),
  resolved: integer("resolved").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const orderReturns = pgTable("order_returns", {
 reference: text("reference").primaryKey(),
 orderItemId: integer("order_item_id").notNull().references(()=>orderItems.id),
 qty: integer("qty").notNull(),
 createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
});

export const titleChoices = pgTable("title_choices", {
 id: text("id").primaryKey(),
 sourceMessageId:text("source_message_id").notNull().unique(),
 channelId:text("channel_id").notNull(),
 userId:text("user_id").notNull(),
 metadata:jsonb("metadata").$type<import("../import-metadata").ImportMetadata>().notNull(),
 qty:integer("qty").notNull(),
 bookId:integer("book_id"),
 state:text("state").notNull().default("pending"),
 expiresAt:timestamp("expires_at",{withTimezone:true}).notNull(),
});
