import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const url = new URL('/', site).href.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url}</loc></url></urlset>`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
