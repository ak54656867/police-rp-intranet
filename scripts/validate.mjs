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
check('desktop runtime and security guards', () => {
  const app = read('desktop/renderer/app.js');
  if (!app.includes("/^[a-z0-9-]+\\.supabase\\.co$/i.test(u.hostname)")) throw new Error('Supabase URL validator is malformed');
  if (!app.includes("profile?.display_name||session.user?.email")) throw new Error('Missing-profile render path is unsafe');
  if (!app.includes('async function refreshSession()')) throw new Error('Desktop session refresh is missing');
  const html = read('desktop/renderer/index.html');
  if (!html.includes('Content-Security-Policy')) throw new Error('Desktop renderer CSP is missing');
});
check('shared-record role policies', () => {
  const sql = read('supabase/security_hardening.sql');
  for (const name of ['can_insert_shared_module', 'can_update_shared_module', 'can_delete_shared_module', 'can_access_intranet', 'can_read_shared_module']) {
    if (!sql.includes('function public.' + name)) throw new Error('Missing policy function: ' + name);
  }
  if (!sql.includes("payload->>'userId'=auth.uid()::text")) throw new Error('Audit actor binding missing');
  if (!sql.includes("module='attendance' and payload->>'userId'=auth.uid()::text and payload->>'out' is null")) throw new Error('Attendance ownership gate missing');
  if (!sql.includes("module='leave' and payload->>'userId'=auth.uid()::text and payload->>'status'='신청'")) throw new Error('Leave approval gate missing');
  for (const name of ['incident delete managers', 'wanted delete managers', 'dispatch delete managers']) {
    if (!sql.includes('create policy "' + name + '"')) throw new Error('Manager-only delete policy missing: ' + name);
  }
  if (!sql.includes("status='pending'")) throw new Error('Pending approval gate missing');
  for (const name of ['incident manage approved', 'wanted manage approved', 'dispatch manage approved']) {
    if (sql.includes('create policy "' + name + '"')) throw new Error('Permissive legacy policy remains: ' + name);
  }
  if (!sql.includes('function public.protect_self_profile_update()')) throw new Error('Self-profile privilege protection missing');
  if (!sql.includes('Make this migration safely re-runnable')) throw new Error('Policy cleanup/idempotency guard missing');
});
check('assigned permission group enforcement', () => {
  const html = read('site/index.html');
  const migration = read('supabase/fix_permission_groups.sql');
  const schema = read('supabase/schema.sql');
  const security = read('supabase/security_hardening.sql');
  if (!html.includes("function hasPermission(module,action)")) throw new Error('Frontend permission resolver missing');
  for (const code of ["has_org_module_permission(p_module, 'create')", "has_org_module_permission(p_module, 'update')", "has_org_module_permission(p_module, 'delete')"]) {
    if (!migration.includes(code)) throw new Error('Migration missing DB enforcement: ' + code);
    if (!schema.includes(code)) throw new Error('Schema missing DB enforcement: ' + code);
    if (!security.includes(code)) throw new Error('Security hardening SQL missing DB enforcement: ' + code);
  }
  if (!html.includes("사건 수정 권한이 없습니다.")) throw new Error('Incident edit permission guard missing');
  if (!html.includes("구금 기록 수정 권한이 없습니다.")) throw new Error('Custody edit permission guard missing');
  if (!html.includes("구금 기록 삭제 권한이 없습니다.")) throw new Error('Custody delete permission guard missing');
  for (const file of [migration, schema, security]) {
    if (!file.includes('function public.can_read_shared_module(p_module text)')) throw new Error('Module-level read authorization function missing');
    if (!file.includes('create policy "shared records read by module permission"')) throw new Error('Module-level read policy missing');
    if (!file.includes("granted.permission_code in (p_module || ':' || p_action, p_module || ':*', '*:*)")) throw new Error('Wildcard permission matching missing');
  }
  if ((security.match(/create or replace function public\.can_insert_shared_module/g) || []).length !== 1) throw new Error('Duplicate shared-module insert authorization function');
});
check('realtime synchronization regression guards', () => {
  const html = read('site/index.html');
  if (!html.includes('next!==lastSyncedSnapshot')) throw new Error('Cloud retry does not compare against last synced snapshot');
  if (!html.includes('lastSyncedSnapshot=JSON.stringify(synced)')) throw new Error('Realtime events do not update the remote snapshot safely');
  if (!html.includes('cloudLoadPromise')) throw new Error('Concurrent shared-data loads are not deduplicated');
  if (!html.includes('authSubscription.unsubscribe()')) throw new Error('Old auth listeners are not cleaned up');
  if (!html.includes("status==='CHANNEL_ERROR'||status==='TIMED_OUT'")) throw new Error('Realtime connection failures are not surfaced');
});

const failed = checks.filter((x) => !x.ok);
for (const item of checks) {
  process.stdout.write((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.error ? ': ' + item.error : '') + '\n');
}
if (failed.length) process.exitCode = 1;
