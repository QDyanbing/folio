import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_URL || 'https://gaoyanbing.com',
  output: 'static',
  devToolbar: { enabled: false },
});
