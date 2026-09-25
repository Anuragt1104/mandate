import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = (m) => path.join(here, "node_modules", m);

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The shared SDK and the program IDL live outside the app directory.
  experimental: { externalDir: true },
  outputFileTracingRoot: path.join(here, ".."),
  webpack(config) {
    // Resolve shared deps to the app's copies so the SDK and the app use the same classes.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@solana/web3.js": mod("@solana/web3.js"),
      "@solana/spl-token": mod("@solana/spl-token"),
      "@coral-xyz/anchor": mod("@coral-xyz/anchor"),
      "bn.js": mod("bn.js"),
      buffer: mod("buffer"),
    };
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, os: false, crypto: false };
    return config;
  },
};
