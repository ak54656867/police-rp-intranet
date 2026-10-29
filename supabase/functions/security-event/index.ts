import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Server configuration missing" }), { status: 500, headers: corsHeaders });
  }

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: corsHeaders });
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser();
  if (authError || !authData.user) {
    return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: corsHeaders });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const forwarded = req.headers.get("x-forwarded-for") || "";
  const ip = (forwarded.split(",")[0] || req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || "").trim().slice(0, 100) || null;
  const userAgent = (req.headers.get("user-agent") || "").slice(0, 1000) || null;
  const eventType = typeof body.event_type === "string" && /^[a-z0-9_-]{1,50}$/i.test(body.event_type)
    ? body.event_type
    : "session_start";
  const path = typeof body.path === "string" ? body.path.slice(0, 300) : null;

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: insertError } = await adminClient.from("security_events").insert({
    actor_id: authData.user.id,
    event_type: eventType,
    ip_address: ip,
    user_agent: userAgent,
    path,
  });
  if (insertError) {
    console.error("security_events insert failed", insertError.message);
    return new Response(JSON.stringify({ error: "Could not record security event" }), { status: 500, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
});
