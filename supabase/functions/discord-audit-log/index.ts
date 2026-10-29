import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}
function clean(value: unknown, max = 900) {
  return String(value ?? "—").replace(/[\u0000-\u001f]/g, " ").slice(0, max) || "—";
}
async function sendWebhook(eventType: string, details: Record<string, unknown>) {
  const config: Record<string, { secret: string; title: string; color: number }> = {
    custody: { secret: "DISCORD_CUSTODY_WEBHOOK", title: "구금 기록", color: 0xC0392B },
    vehicle: { secret: "DISCORD_VEHICLE_WEBHOOK", title: "차량 스폰 로그", color: 0x2980B9 },
    personnel: { secret: "DISCORD_PERSONNEL_WEBHOOK", title: "인사 조치 로그", color: 0x8E44AD },
    personnel_report: { secret: "DISCORD_PERSONNEL_WEBHOOK", title: "인사보고 제출", color: 0x8E44AD },
  };
  const selected = config[eventType];
  if (!selected) throw new Error("Unsupported event type");
  const value = Deno.env.get(selected.secret) ?? "";
  if (!value) throw new Error(selected.secret + " secret is not configured");
  const url = new URL(value);
  if (url.hostname !== "discord.com" || !url.pathname.startsWith("/api/webhooks/")) {
    throw new Error(selected.secret + " must be a Discord webhook URL");
  }
  const labels: Record<string, string> = {
    action: "처리", subject: "대상자", minutes: "구금 시간", reason: "사유",
    officer: "담당자", source: "기록 경로", vehicleModel: "차량 모델",
    passengers: "탑승자", rank: "계급", department: "부서", position: "직책",
  };
  const fieldEntries = Object.entries(details).filter(([key, value]) =>
    value !== undefined && value !== null && String(value).trim() !== ""
  ).slice(0, 12).map(([name, value]) => ({
    name: clean(labels[name] ?? name, 256),
    value: clean(value, 1024),
    inline: ["action", "minutes", "rank", "department"].includes(name),
  }));
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: selected.title,
        color: selected.color,
        fields: fieldEntries.length ? fieldEntries : [{ name: "기록", value: "세부 정보 없음" }],
        footer: { text: "경찰 RP 인트라넷 · 감사 기록" },
        timestamp: new Date().toISOString(),
      }],
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.ok) throw new Error("Discord webhook returned " + response.status);
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: "Authentication required" }, 401);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Server configuration is incomplete" }, 500);
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { persistSession: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "Invalid session" }, 401);
  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data: profile, error: profileError } = await adminClient.from("profiles")
    .select("id,role,status,active,roblox_username,discord_username,permissions")
    .eq("id", authData.user.id).maybeSingle();
  if (profileError || !profile) return json({ error: "Profile not found" }, 403);
  if (profile.role !== "admin" && !(profile.status === "approved" && profile.active === true)) {
    return json({ error: "Approved account required" }, 403);
  }
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const eventType = String(body?.event_type ?? "");
  if (!["custody", "vehicle", "personnel", "personnel_report"].includes(eventType) || !body.details || typeof body.details !== "object" || Array.isArray(body.details)) {
    return json({ error: "Invalid event payload" }, 400);
  }
  if (eventType === "personnel" && profile.role !== "admin") return json({ error: "Admin role required for personnel logs" }, 403);
  if (profile.role !== "admin" && eventType !== "personnel_report") {
    const moduleName = eventType === "custody" ? "fines" : "assets";
    const { data: groupRecord, error: groupError } = await adminClient.from("shared_records")
      .select("payload").eq("module", "permissionSets").eq("record_id", "__list__").maybeSingle();
    if (groupError) return json({ error: "Could not verify permissions" }, 500);
    const groups = Array.isArray(groupRecord?.payload) ? groupRecord.payload : [];
    const groupIds = Array.isArray(profile.permissions) ? profile.permissions.map(String) : [];
    const allowed = groups.some((group: any) => group && groupIds.includes(String(group.id)) &&
      Array.isArray(group.permissions) && group.permissions.some((permission: unknown) =>
        permission === moduleName + ":create" || permission === moduleName + ":*" || permission === "*:*"
      ));
    if (!allowed) return json({ error: "Missing permission: " + moduleName + ":create" }, 403);
  }
  const details = { ...body.details };
  details.officer = details.officer || profile.roblox_username || profile.discord_username || authData.user.id;
  details.source = details.source || "인트라넷";
  try {
    await sendWebhook(eventType, details);
    return json({ ok: true });
  } catch (error) {
    console.error("Discord audit webhook failed", error);
    return json({ error: error instanceof Error ? error.message : "Webhook failed" }, 502);
  }
});
