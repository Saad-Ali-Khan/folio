import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "twilio", "sharp", "tesseract.js", "@tesseract.js-data/eng"],
  outputFileTracingIncludes: {
    "/api/discord/inventory/photo": [
      "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
      "./node_modules/tesseract.js-core/*.wasm",
    ],
  },
  images: {
    remotePatterns: [
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
