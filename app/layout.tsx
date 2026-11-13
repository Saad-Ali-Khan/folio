import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { CartProvider } from "@/components/cart-provider";
import { Header } from "@/components/header";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Folio — Independent Bookstore",
    template: "%s — Folio",
  },
  description:
    "A small, carefully chosen shelf of books worth keeping. Classics, modern fiction, and a little nonfiction.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-cream text-ink">
        <CartProvider>
          <Header />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-ink/10">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-ink/60 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p className="font-display text-lg text-ink">Folio.</p>
              <p>Books worth keeping. Delivery within Pakistan.</p>
              <Link href="/admin" className="text-xs hover:text-accent">Manage inventory</Link>
            </div>
          </footer>
        </CartProvider>
      </body>
    </html>
  );
}
