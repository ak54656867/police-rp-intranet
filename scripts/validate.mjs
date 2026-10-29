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
  if (!sql.includes('hardening_policy_cleanup')) throw new Error('Unknown legacy RLS policies are not cleared');
  if (!sql.includes('create policy "profile update by administrator"')) throw new Error('Administrator profile-management policy missing');
});
check('assigned permission group enforcement', () => {
  const html = read('site/index.html');
  const migration = read('supabase/fix_permission_groups.sql');
  const schema = read('supabase/schema.sql');
  const security = read('supabase/security_hardening.sql');
  if (!html.includes("function hasPermission(module,action)")) throw new Error('Frontend permission resolver missing');
  if (/actions:\[[^\]]*'update'/.test(html)) throw new Error('Update permission must not appear in the permission matrix');
  if (!html.includes('function canEditRecord(record)')) throw new Error('Owner-only record edit helper missing');
  if (!html.includes('f.createdByUserId=authUser.id;f.userId=authUser.id;')) throw new Error('New records are missing owner identity');
  if (!security.includes("module in ('personnel','incidents','wanted','dispatch','assets','notices','documents','fines')") || !security.includes("payload->>'userId'=auth.uid()::text")) throw new Error('Owner-only row update gate missing');
  for (const code of ["has_org_module_permission(p_module, 'create')", "has_org_module_permission(p_module, 'update')", "has_org_module_permission(p_module, 'delete')"]) {
    if (!migration.includes(code)) throw new Error('Migration missing DB enforcement: ' + code);
    if (!schema.includes(code)) throw new Error('Schema missing DB enforcement: ' + code);
    if (!security.includes(code)) throw new Error('Security hardening SQL missing DB enforcement: ' + code);
  }
  if (!html.includes("본인이 작성한 사건만 수정할 수 있습니다.")) throw new Error('Incident owner-only edit guard missing');
  if (!html.includes("본인이 작성한 구금 기록만 수정할 수 있습니다.")) throw new Error('Custody owner-only edit guard missing');
  if (!html.includes("구금 기록 삭제 권한이 없습니다.")) throw new Error('Custody delete permission guard missing');
  for (const file of [migration, schema, security]) {
    if (!file.includes('function public.can_read_shared_module(p_module text)')) throw new Error('Module-level read authorization function missing');
    if (!file.includes('create policy "shared records read by module permission"')) throw new Error('Module-level read policy missing');
    if (!file.includes("granted.permission_code in (p_module || ':' || p_action, p_module || ':*', '*:*')")) throw new Error('Wildcard permission matching missing');
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

check('connected organization chart and security event logging', () => {
  const html = read('site/index.html');
  const hardening = read('supabase/security_hardening.sql');
  const schema = read('supabase/schema.sql');
  const edge = read('supabase/functions/security-event/index.ts');
  if (!html.includes('class="org-tree"') || !html.includes('border-left:2px solid #426ca8')) throw new Error('Connected org chart tree/connector styles missing');
  if (!html.includes("supabaseClient.functions.invoke('security-event'")) throw new Error('Security event function is not called from authenticated session flow');
  if (!html.includes("from('security_events').select")) throw new Error('Admin security event log query missing');
  for (const file of [hardening, schema]) {
    if (!file.includes('create table if not exists public.security_events')) throw new Error('Security event table missing from SQL source');
    if (!file.includes('security events read admin only')) throw new Error('Admin-only security event policy missing');
  }
  if (!edge.includes('authClient.auth.getUser()') || !edge.includes('SUPABASE_SERVICE_ROLE_KEY') || !edge.includes('ip_address: ip')) throw new Error('Edge logger must authenticate the session and store IP server-side');
});

check('continuous organization connectors and Discord audit webhooks', () => {
  const html = read('site/index.html');
  const bot = read('supabase/functions/discord-interactions/index.ts');
  const audit = read('supabase/functions/discord-audit-log/index.ts');
  if (!html.includes('function drawOrgConnectors()') || !html.includes('org-connectors')) throw new Error('SVG organization connector renderer missing');
  if (html.includes("positionNode('교통안전과장'") || html.includes("positionNode('생활안전과장'")) throw new Error('Unregistered department head positions must not be hardcoded');
  if (!html.includes("functions.invoke('discord-audit-log'")) throw new Error('Intranet audit webhook invocation missing');
  for (const secret of ['DISCORD_CUSTODY_WEBHOOK', 'DISCORD_VEHICLE_WEBHOOK', 'DISCORD_PERSONNEL_WEBHOOK']) {
    if (!audit.includes(secret) || !bot.includes(secret)) throw new Error('Discord webhook secret missing: ' + secret);
  }
  if (!bot.includes('postAuditWebhook("custody"') || !bot.includes('postAuditWebhook("vehicle"')) throw new Error('Discord bot custody/vehicle logging missing');
});
 
const failed = checks.filter((x) => !x.ok);
for (const item of checks) {
  process.stdout.write((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.error ? ': ' + item.error : '') + '\n');
}
if (failed.length) process.exitCode = 1;
