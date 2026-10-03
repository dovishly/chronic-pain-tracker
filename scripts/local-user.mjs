// Adds a user to the local Supabase (the one from `npm run db:start`), so you can sign in to it.
// Usage: npm run db:user -- you@example.com
// The admin key is read from the running local Supabase, never stored in this repository.
import { execFileSync } from 'node:child_process';

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run db:user -- you@example.com');
  process.exit(1);
}

let local;
try {
  local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch {
  console.error('The local Supabase isn\'t running. Start it with: npm run db:start');
  process.exit(1);
}

const key = local.SECRET_KEY || local.SERVICE_ROLE_KEY;
const response = await fetch(`${local.API_URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, email_confirm: true }),
});
const result = await response.json();
if (response.ok) {
  console.log(`Added ${email}.`);
} else if (result.error_code === 'email_exists') {
  console.log(`${email} is already a user.`);
} else {
  console.error('Supabase said:', result.msg || result.message || response.status);
  process.exit(1);
}

console.log(`
In the app (npm run dev), Settings → Sync:
  Project URL                 ${local.API_URL}
  Anon / publishable key      ${local.PUBLISHABLE_KEY || local.ANON_KEY}
Sign-in codes arrive at       ${local.MAILPIT_URL || local.INBUCKET_URL}
Database dashboard (Studio)   ${local.STUDIO_URL}`);
