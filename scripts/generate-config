import { writeFileSync } from 'node:fs';

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const forceLocal = /^(1|true|yes)$/i.test(process.env.VITE_FORCE_LOCAL || '');

const js = `window.APP_CONFIG = ${JSON.stringify({
  SUPABASE_URL: url,
  SUPABASE_ANON_KEY: key,
  FORCE_LOCAL: forceLocal
}, null, 2)};\n`;

writeFileSync('config.js', js, 'utf8');
console.log(url && key ? 'Supabase browser config generated.' : 'No Supabase variables found; build will use local/offline mode.');
