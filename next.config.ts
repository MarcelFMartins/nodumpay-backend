import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Imagem Docker enxuta (Dokploy): .next/standalone traz só o necessário.
  output: "standalone",
};

export default nextConfig;
