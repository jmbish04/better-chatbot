import { setupDevPlatform } from '@cloudflare/next-on-pages/next-dev';

// Initialize the Cloudflare execution environment for local development
if (process.env.NODE_ENV === 'development') {
  await setupDevPlatform();
}

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
