import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent webpack from bundling pdf-parse — it uses __dirname-relative paths
  // internally that break when bundled. This tells Next.js to require() it
  // natively from node_modules at runtime.
  serverExternalPackages: ["pdf-parse"],

  experimental: {
    serverActions: {
      // Increase body size limit for PDF uploads (default is 4MB)
      bodySizeLimit: "20mb",
    },
  },
};

export default nextConfig;
