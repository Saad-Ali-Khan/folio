import type { NextConfig } from "next";

const cloudflare = process.env.FOLIO_CLOUDFLARE === "1";

const nextConfig: NextConfig = {
  // Keep database work in the active request in both environments.
  cacheComponents: false,
  partialPrefetching: false,
  ...(cloudflare ? { experimental: { cpus: 2 } } : {
    serverExternalPackages: ["@electric-sql/pglite", "postgres", "@neondatabase/serverless", "ws", "undici", "twilio", "sharp", "tesseract.js", "@tesseract.js-data/eng"],
    outputFileTracingIncludes: {
      "/api/discord/inventory/photo": [
        "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
        "./node_modules/tesseract.js-core/*.wasm",
      ],
    },
  }),
  images: {
    unoptimized: cloudflare,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "books.google.com",
        pathname: "/books/content",
      },
      {
        protocol: "https",
        hostname: "d9z6htgewkjtb.cloudfront.net",
        pathname: "/**",
        search: "",
      },
      {
        protocol: "https",
        hostname: "covers.openlibrary.org",
        pathname: "/b/isbn/**",
      },
      {
        protocol: "https",
        hostname: "covers.openlibrary.org",
        pathname: "/b/id/**",
      },
    ],
  },
};

export default nextConfig;
