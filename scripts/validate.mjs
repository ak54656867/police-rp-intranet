import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const checks = [];
function check(name, fn) {
  try { fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.message }); }
}

check('site inline JavaScript syntax', () => {
  const html = read('site/index.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!scripts.length) throw new Error('No inline script found');
  scripts.forEach((script) => new vm.Script(script, { filename: 'site/index.html:inline-script' }));
});
check('desktop JavaScript syntax', () => {
  for (const file of ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/renderer/app.js']) {
    new vm.Script(read(file), { filename: file });
  }
});
check('desktop package manifest', () => {
  const pkg = JSON.parse(read('desktop/package.json'));
  if (!pkg.devDependencies?.electron || !pkg.devDependencies?.['electron-builder']) {
    throw new Error('Missing Electron build dependencies');
  }
});
check('pinned Supabase client', () => {
  const html = read('site/index.html');
  if (!/supabase-js@\d+\.\d+\.\d+/.test(html)) throw new Error('Supabase CDN dependency is not pinned');
});
check('no metadata-based admin promotion', () => {
  const files = ['supabase/schema.sql', 'supabase/security_hardening.sql', 'supabase/onboarding_admin.sql'];
  for (const file of files) {
    const sql = read(file);
    if (/if\s+discord_id\s*=\s*'285388357272600578'|where\s+coalesce\(u\.raw_user_meta_data->>'provider_id'/i.test(sql)) {
      throw new Error(file + ' contains metadata-based admin promotion');
    }
  }
});
check('shared-record role policies', () => {
  const sql = read('supabase/security_hardening.sql');
  for (const name of ['can_insert_shared_module', 'can_update_shared_module', 'can_delete_shared_module', 'can_access_intranet']) {
    if (!sql.includes('function public.' + name)) throw new Error('Missing policy function: ' + name);
  }
  if (!sql.includes("payload->>'userId'=auth.uid()::text")) throw new Error('Audit actor binding missing');
  if (!sql.includes("status='pending'")) throw new Error('Pending approval gate missing');
});

const failed = checks.filter((x) => !x.ok);
for (const item of checks) {
  process.stdout.write((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.error ? ': ' + item.error : '') + '\n');
}
if (failed.length) process.exitCode = 1;
