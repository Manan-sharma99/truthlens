import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse"],
  outputFileTracingIncludes: {
    "/api/**": ["./prompts/**/*", "./data/**/*", "./exports/**/*"],
  },
};

export default nextConfig;
