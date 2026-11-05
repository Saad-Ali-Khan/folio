import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  stripeSessionId: text("stripe_session_id").notNull().unique(),
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

export type Book = typeof books.$inferSelect;
export type Order = typeof orders.$inferSelect;
