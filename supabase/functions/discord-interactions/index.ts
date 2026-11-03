import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-signature-ed25519, x-signature-timestamp",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const COMMANDS = {
  attendanceIn: "출근",
  attendanceOut: "퇴근",
  vehicleSpawn: "차량스폰",
  vehicleDelete: "차량삭제",
  custody: "구금",
  intranet: "인트라넷",
  announcement: "공지",
  aiCommand: "명령하기",
};

const ANNOUNCEMENT_CHANNEL_IDS = new Set(["1563868823235469346", "1563868823235469347"]);

function isAnnouncementFlow(interaction: any) {
  const customId = String(interaction.data?.custom_id ?? "");
  return (interaction.type === 2 && interaction.data?.name === COMMANDS.announcement) ||
    (interaction.type === 3 && customId.startsWith("announcement_destination:")) ||
    (interaction.type === 5 && customId.startsWith("announcement_create:"));
}

function isAllowedInteractionChannel(interaction: any, commandChannel: string | undefined) {
  if (isAnnouncementFlow(interaction)) {
    return ANNOUNCEMENT_CHANNEL_IDS.has(String(interaction.channel_id ?? "")) ||
      Boolean(commandChannel && interaction.channel_id === commandChannel);
  }
  return Boolean(commandChannel && interaction.channel_id === commandChannel);
}

type Json = Record<string, unknown>;

function json(body: Json, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  return new Uint8Array(value.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
}

async function verifyDiscordRequest(request: Request, body: string): Promise<boolean> {
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  const publicKey = Deno.env.get("DISCORD_PUBLIC_KEY") ?? "";
  const sig = decodeHex(signature);
  const key = decodeHex(publicKey);
  if (!sig || !key || !timestamp || timestamp.length > 64) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", cryptoKey, sig, new TextEncoder().encode(timestamp + body));
  } catch (error) {
    console.error("Discord signature verification failed", error);
    return false;
  }
}

function interactionResponse(content: string) {
  return json({ type: 4, data: { content } });
}

// 최고 관리자 AI는 shared_records 전 모듈을 관리할 수 있다.
 // 인증·감사·동기화 시스템 레코드는 직접 변경하지 못하도록 보호한다.
const AI_PROTECTED_MODULES = new Set([
  "audit", "discord_announcement_sync", "auth", "oauth", "sessions",
]);

async function aiManageRecords(db: ReturnType<typeof createClient>, profile: any, operation: string, args: any) {
  const moduleName = String(args.module ?? "").trim();
  if (!moduleName || moduleName.length > 80 || AI_PROTECTED_MODULES.has(moduleName)) {
    throw new Error("모듈명이 비어 있거나 시스템 보호 모듈입니다.");
  }
  const recordId = String(args.record_id ?? "").trim();
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20) || 20));

  if (operation === "list_records") {
    const { data, error } = await db.from("shared_records")
      .select("record_id,payload,updated_at,updated_by")
      .eq("module", moduleName)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return { operation, module: moduleName, records: data ?? [] };
  }

  if (operation === "create_record") {
    const payload = args.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload 객체가 필요합니다.");
    const id = recordId || crypto.randomUUID();
    const { error } = await db.from("shared_records").insert({
      module: moduleName, record_id: id, payload: { ...payload, id: (payload as any).id ?? id },
      updated_by: profile.id,
    });
    if (error) throw error;
    await writeAiAudit(db, profile, "AI 레코드 생성", moduleName + "/" + id, args.reason);
    return { success: true, operation, module: moduleName, record_id: id };
  }

  if (!recordId) throw new Error("record_id가 필요합니다.");
  if (operation === "update_record") {
    const payload = args.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload 객체가 필요합니다.");
    const { data: existing, error: readError } = await db.from("shared_records")
      .select("payload").eq("module", moduleName).eq("record_id", recordId).maybeSingle();
    if (readError) throw readError;
    if (!existing) throw new Error("수정할 기록을 찾을 수 없습니다.");
    const { error } = await db.from("shared_records").update({
      payload: { ...(existing.payload ?? {}), ...payload }, updated_by: profile.id,
    }).eq("module", moduleName).eq("record_id", recordId);
    if (error) throw error;
    await writeAiAudit(db, profile, "AI 레코드 수정", moduleName + "/" + recordId, args.reason);
    return { success: true, operation, module: moduleName, record_id: recordId };
  }

  if (operation === "delete_record") {
    if (AI_PROTECTED_MODULES.has(moduleName)) throw new Error("시스템 보호 모듈은 삭제할 수 없습니다.");
    const { data: existing, error: readError } = await db.from("shared_records")
      .select("record_id").eq("module", moduleName).eq("record_id", recordId).maybeSingle();
    if (readError) throw readError;
    if (!existing) throw new Error("삭제할 기록을 찾을 수 없습니다.");
    const { error } = await db.from("shared_records").delete()
      .eq("module", moduleName).eq("record_id", recordId);
    if (error) throw error;
    await writeAiAudit(db, profile, "AI 레코드 삭제", moduleName + "/" + recordId, args.reason);
    return { success: true, operation, module: moduleName, record_id: recordId };
  }
  throw new Error("지원하지 않는 AI 작업입니다.");
}

async function aiManageProfile(db: ReturnType<typeof createClient>, profile: any, operation: string, args: any) {
  const target = String(args.discord_id ?? "").trim();
  if (!target) throw new Error("대상 Discord ID가 필요합니다.");
  const { data: targetProfile, error } = await db.from("profiles")
    .select("id,discord_id,display_name,roblox_username,rank,position,department,role,status,active,permissions")
    .eq("discord_id", target).maybeSingle();
  if (error) throw error;
  if (!targetProfile) throw new Error("대상 인트라넷 계정을 찾을 수 없습니다.");
  if (operation === "get_profile") return { profile: targetProfile };
  if (operation !== "update_profile") throw new Error("지원하지 않는 프로필 작업입니다.");

  const input = args.changes;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("변경할 프로필 정보가 필요합니다.");
  const allowed = new Set(["display_name","roblox_username","rank","position","department","role","status","active","permissions"]);
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Error("수정할 수 없는 프로필 필드: " + key);
    changes[key] = value;
  }
  // 최고 관리자 본인의 소유권과 Discord 연결은 AI 요청으로 변경할 수 없다.
  if (target === "285388357272600578") {
    delete changes.role; delete changes.active; delete changes.status; delete changes.permissions;
  }
  if (!Object.keys(changes).length) throw new Error("적용 가능한 변경사항이 없습니다.");
  const { error: updateError } = await db.from("profiles").update(changes).eq("id", targetProfile.id);
  if (updateError) throw updateError;
  await writeAiAudit(db, profile, "AI 인사 프로필 수정", targetProfile.roblox_username || target, args.reason);
  return { success: true, discord_id: target, changed_fields: Object.keys(changes) };
}

async function writeAiAudit(db: ReturnType<typeof createClient>, profile: any, action: string, detail: string, reason: unknown) {
  const id = crypto.randomUUID();
  const { error } = await db.from("shared_records").insert({
    module: "audit", record_id: id,
    payload: {
      id, action, detail, actor: profile.roblox_username || profile.display_name || "최고 관리자",
      userId: profile.id, source: "Discord AI", reason: String(reason ?? "").slice(0, 500),
      date: new Date().toISOString(),
    },
    updated_by: profile.id,
  });
  if (error) console.error("AI audit log write failed", error);
}


const AI_GITHUB_REPO = "ak54656867/police-rp-intranet";
const AI_GITHUB_PROTECTED_PATHS = [
  /^supabase\/config\.toml$/,
  /^supabase\/functions\/discord-interactions\/index\.ts$/,
  /^src\/.*auth/i,
  /^src\/.*login/i,
  /^src\/.*oauth/i,
  /^\.github\/workflows\/.*$/,
];

function assertAiGithubPath(path: string) {
  const normalized = path.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!normalized || normalized.split("/").some((part) => part === "..") ||
      AI_GITHUB_PROTECTED_PATHS.some((pattern) => pattern.test(normalized))) {
    throw new Error("인증·로그인·OAuth·배포 핵심 파일은 AI가 직접 변경할 수 없습니다.");
  }
  return normalized;
}

async function aiGithubRequest(path: string, init: RequestInit = {}) {
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) throw new Error("GITHUB_TOKEN 서버 Secret이 설정되지 않았습니다.");
  const response = await fetch("https://api.github.com" + path, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  let data: any = {};
  try { data = body ? JSON.parse(body) : {}; } catch { data = { message: body.slice(0, 500) }; }
  if (!response.ok) {
    console.error("AI GitHub API failed", response.status, JSON.stringify(data).slice(0, 1000));
    throw new Error("GitHub API 오류 (" + response.status + "): " + String(data.message ?? "요청 실패").slice(0, 250));
  }
  return data;
}

async function aiGithubAction(operation: string, args: any) {
  if (operation === "github_get_file") {
    const path = assertAiGithubPath(String(args.path ?? ""));
    const ref = String(args.ref ?? "main");
    const data = await aiGithubRequest("/repos/" + AI_GITHUB_REPO + "/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(ref));
    if (Array.isArray(data) || data.type !== "file") throw new Error("일반 파일만 조회할 수 있습니다.");
    const content = atob(String(data.content ?? "").replace(/\\s/g, ""));
    const bytes = Uint8Array.from(content, (c) => c.charCodeAt(0));
    return { path, sha: data.sha, content: new TextDecoder().decode(bytes).slice(0, 16000), truncated: bytes.length > 16000 };
  }
  if (operation === "github_update_file") {
    const path = assertAiGithubPath(String(args.path ?? ""));
    const content = String(args.content ?? "");
    const message = String(args.message ?? "").slice(0, 120);
    if (!message || content.length > 90000) throw new Error("커밋 메시지가 없거나 파일이 너무 큽니다.");
    const ref = String(args.ref ?? "main");
    const current = await aiGithubRequest("/repos/" + AI_GITHUB_REPO + "/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(ref));
    if (Array.isArray(current) || current.type !== "file") throw new Error("기존 파일만 수정할 수 있습니다.");
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
    const result = await aiGithubRequest("/repos/" + AI_GITHUB_REPO + "/contents/" + path.split("/").map(encodeURIComponent).join("/"), {
      method: "PUT",
      body: JSON.stringify({ message, content: encoded, sha: current.sha, branch: ref }),
    });
    return { success: true, path, commit_sha: result.commit?.sha, html_url: result.content?.html_url };
  }
  if (operation === "github_create_file" || operation === "github_delete_file") {
    const path = assertAiGithubPath(String(args.path ?? ""));
    const message = String(args.message ?? "").slice(0, 120);
    const ref = String(args.ref ?? "main");
    if (!message) throw new Error("커밋 메시지가 필요합니다.");
    const url = "/repos/" + AI_GITHUB_REPO + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    if (operation === "github_create_file") {
      const content = String(args.content ?? "");
      if (content.length > 90000) throw new Error("파일이 너무 큽니다.");
      const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
      const result = await aiGithubRequest(url, { method: "PUT", body: JSON.stringify({ message, content: encoded, branch: ref }) });
      return { success: true, path, commit_sha: result.commit?.sha, html_url: result.content?.html_url };
    }
    const current = await aiGithubRequest(url + "?ref=" + encodeURIComponent(ref));
    if (Array.isArray(current) || current.type !== "file") throw new Error("일반 파일만 삭제할 수 있습니다.");
    const result = await aiGithubRequest(url, { method: "DELETE", body: JSON.stringify({ message, sha: current.sha, branch: ref }) });
    return { success: true, path, commit_sha: result.commit?.sha };
  }
  if (operation === "github_dispatch_workflow") {
    const workflow = String(args.workflow ?? "");
    if (!/^[a-zA-Z0-9._-]+\\.ya?ml$/.test(workflow) || workflow.includes("..")) throw new Error("허용되지 않는 워크플로 파일명입니다.");
    const ref = String(args.ref ?? "main");
    if (ref !== "main") throw new Error("현재 AI 배포 실행은 main 브랜치만 허용합니다.");
    const inputs = args.inputs && typeof args.inputs === "object" && !Array.isArray(args.inputs) ? args.inputs : {};
    await aiGithubRequest("/repos/" + AI_GITHUB_REPO + "/actions/workflows/" + encodeURIComponent(workflow) + "/dispatches", {
      method: "POST", body: JSON.stringify({ ref, inputs }),
    });
    return { success: true, workflow, ref, message: "GitHub Actions 실행 요청을 전송했습니다. 완료 여부는 Actions에서 별도 확인해야 합니다." };
  }
  throw new Error("지원하지 않는 GitHub 작업입니다.");
}


const AI_SUPABASE_PROJECT_REF = "lnauhbnisreigaqoeabq";

async function aiSupabaseManagementRequest(path: string, init: RequestInit = {}) {
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN");
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN Secret이 설정되지 않았습니다.");
  const response = await fetch("https://api.supabase.com" + path, {
    ...init,
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  let data: any = {};
  try { data = body ? JSON.parse(body) : {}; } catch { data = { message: body.slice(0, 500) }; }
  if (!response.ok) {
    console.error("Supabase Management API failed", response.status, JSON.stringify(data).slice(0, 1000));
    throw new Error("Supabase 관리 API 오류 (" + response.status + "): " + String(data.message ?? "요청 실패").slice(0, 250));
  }
  return data;
}

async function aiSupabaseAction(operation: string, args: any) {
  if (operation === "supabase_read_sql") {
    const query = String(args.query ?? "").trim();
    if (!query || query.length > 12000 || !/^(select|with|explain)\\b/i.test(query) ||
        /;\\s*(select|insert|update|delete|alter|drop|create|grant|revoke|truncate)\\b/i.test(query) ||
        /\\b(insert|update|delete|alter|drop|create|grant|revoke|truncate|copy|call|do)\\b/i.test(query)) {
      throw new Error("읽기 전용 SELECT/CTE/EXPLAIN 쿼리만 허용됩니다.");
    }
    return await aiSupabaseManagementRequest("/v1/projects/" + AI_SUPABASE_PROJECT_REF + "/database/query", {
      method: "POST", body: JSON.stringify({ query }),
    });
  }
  if (operation === "supabase_apply_sql") {
    const query = String(args.query ?? "").trim();
    const reason = String(args.reason ?? "").trim();
    if (!query || query.length > 40000 || !reason) throw new Error("SQL 또는 변경 사유가 비어 있거나 너무 깁니다.");
    if (/\\b(copy|\bprogram\b|\\.\\.)\\b/i.test(query)) throw new Error("허용되지 않는 SQL 구문입니다.");
    const result = await aiSupabaseManagementRequest("/v1/projects/" + AI_SUPABASE_PROJECT_REF + "/database/query", {
      method: "POST", body: JSON.stringify({ query }),
    });
    return { success: true, result, warning: "DB 변경 요청을 실행했습니다. 실제 영향은 후속 검증이 필요합니다." };
  }
  if (operation === "supabase_list_functions") {
    return await aiSupabaseManagementRequest("/v1/projects/" + AI_SUPABASE_PROJECT_REF + "/functions");
  }
  if (operation === "supabase_delete_function") {
    const slug = String(args.slug ?? "");
    if (!/^[a-z0-9-]{1,60}$/.test(slug) || slug === "discord-interactions") {
      throw new Error("유효하지 않거나 보호된 Edge Function입니다.");
    }
    await aiSupabaseManagementRequest("/v1/projects/" + AI_SUPABASE_PROJECT_REF + "/functions/" + encodeURIComponent(slug), { method: "DELETE" });
    return { success: true, deleted: slug };
  }
  throw new Error("지원하지 않는 Supabase 작업입니다.");
}

async function aiAssistantAction(db: ReturnType<typeof createClient>, interaction: any) {
  const user = discordUser(interaction);
  if (!user?.id) throw new Error("Discord 사용자 정보를 확인할 수 없습니다.");
  const aiOwnerDiscordId = "285388357272600578";
  if (String(user.id) !== aiOwnerDiscordId) throw new Error("이 AI 명령은 최고 관리자 전용입니다.");

  const { data: profile, error } = await db.from("profiles")
    .select("id,roblox_username,display_name,role,status,active,department,rank,position")
    .eq("discord_id", user.id).maybeSingle();
  if (error) throw error;
  if (!profile || !profile.active || (profile.status !== "approved" && profile.role !== "admin")) {
    throw new Error("활성화된 최고 관리자 인트라넷 계정이 필요합니다.");
  }

  const prompt = String(interaction.data?.options?.find((option: any) => option.name === "prompt")?.value ?? "").trim();
  if (!prompt) throw new Error("명령 내용을 입력해 주세요.");
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("GROQ_API_KEY 서버 Secret이 설정되지 않았습니다.");

  const tools = [
    { type: "function", function: { name: "list_records", description: "지정한 인트라넷 모듈의 최신 기록을 조회한다.", parameters: { type: "object", properties: { module: { type: "string", minLength: 1, maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["module"], additionalProperties: false } } },
    { type: "function", function: { name: "create_record", description: "인트라넷 모듈에 새 기록을 생성한다. 사용자가 명시적으로 생성 요청한 경우에만 호출한다.", parameters: { type: "object", properties: { module: { type: "string", minLength: 1, maxLength: 80 }, record_id: { type: "string" }, payload: { type: "object" }, reason: { type: "string" } }, required: ["module", "payload", "reason"], additionalProperties: false } } },
    { type: "function", function: { name: "update_record", description: "기존 인트라넷 기록의 필드를 수정한다. payload는 변경할 필드만 전달한다.", parameters: { type: "object", properties: { module: { type: "string", minLength: 1, maxLength: 80 }, record_id: { type: "string" }, payload: { type: "object" }, reason: { type: "string" } }, required: ["module", "record_id", "payload", "reason"], additionalProperties: false } } },
    { type: "function", function: { name: "delete_record", description: "기존 인트라넷 기록을 영구 삭제한다. 사용자가 삭제를 명시적으로 요청한 경우에만 호출한다.", parameters: { type: "object", properties: { module: { type: "string", minLength: 1, maxLength: 80 }, record_id: { type: "string" }, reason: { type: "string" } }, required: ["module", "record_id", "reason"], additionalProperties: false } } },
    { type: "function", function: { name: "get_profile", description: "Discord ID로 인트라넷 계정을 조회한다.", parameters: { type: "object", properties: { discord_id: { type: "string" } }, required: ["discord_id"], additionalProperties: false } } },
    { type: "function", function: { name: "update_profile", description: "Discord ID로 인트라넷 계정의 인사정보와 권한을 수정한다. 사용자가 명시적으로 요청한 경우에만 호출한다.", parameters: { type: "object", properties: { discord_id: { type: "string" }, changes: { type: "object" }, reason: { type: "string" } }, required: ["discord_id", "changes", "reason"], additionalProperties: false } } },
    { type: "function", function: { name: "github_get_file", description: "경찰 RP 인트라넷 저장소의 비보호 파일을 조회한다.", parameters: { type: "object", properties: { path: { type: "string" }, ref: { type: "string" } }, required: ["path"], additionalProperties: false } } },
    { type: "function", function: { name: "github_update_file", description: "경찰 RP 인트라넷 저장소의 비보호 파일을 커밋으로 수정한다. 사용자가 명시적으로 수정 요청한 경우에만 호출한다.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, message: { type: "string" }, ref: { type: "string" } }, required: ["path", "content", "message"], additionalProperties: false } } },
    { type: "function", function: { name: "github_create_file", description: "비보호 저장소 파일을 생성한다.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, message: { type: "string" }, ref: { type: "string" } }, required: ["path", "content", "message"], additionalProperties: false } } },
    { type: "function", function: { name: "github_delete_file", description: "비보호 저장소 파일을 삭제한다.", parameters: { type: "object", properties: { path: { type: "string" }, message: { type: "string" }, ref: { type: "string" } }, required: ["path", "message"], additionalProperties: false } } },
    { type: "function", function: { name: "github_dispatch_workflow", description: "허용된 GitHub Actions 워크플로를 main 브랜치에서 실행한다.", parameters: { type: "object", properties: { workflow: { type: "string" }, ref: { type: "string" }, inputs: { type: "object" } }, required: ["workflow"], additionalProperties: false } } },
    { type: "function", function: { name: "supabase_read_sql", description: "Supabase DB에 읽기 전용 SQL SELECT/CTE/EXPLAIN 쿼리를 실행한다.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
    { type: "function", function: { name: "supabase_apply_sql", description: "Supabase DB에 SQL 스키마 또는 데이터 변경을 실행한다. 명시적 요청과 변경 사유가 필요하며 삭제·파괴적 작업은 사전 확인을 요청한다.", parameters: { type: "object", properties: { query: { type: "string" }, reason: { type: "string" } }, required: ["query", "reason"], additionalProperties: false } } },
    { type: "function", function: { name: "supabase_list_functions", description: "Supabase 프로젝트의 Edge Functions 목록을 조회한다.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "supabase_delete_function", description: "Supabase Edge Function을 삭제한다. discord-interactions는 보호된다.", parameters: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false } } },
  ];
  const messages: any[] = [
    { role: "system", content: "너는 경찰 RP 인트라넷 최고 관리자 전용 운영 AI다. 사용자의 자연어 요청을 분석해 필요한 경우 제공된 도구를 실제 호출한다. 조회 요청은 조회 도구를 사용한다. 생성·수정·삭제는 사용자가 해당 변경을 분명히 요청했을 때만 실행하며, 정보가 부족하면 먼저 질문한다. 삭제는 정확한 대상과 record_id가 확인되지 않으면 실행하지 않는다. 실행 전 조회로 대상을 특정하고, 성공 결과가 반환된 뒤에만 완료라고 말한다. 로그인, Discord OAuth, 인증·보안 설정, Edge Function 핵심 코드, GitHub Actions 워크플로, 임의 코드 실행은 도구로 변경할 수 없다. Supabase 읽기 전용 SQL과 명시적 요청에 따른 SQL 스키마 변경은 관리 API로 실행한다. GitHub의 비보호 일반 파일 조회·수정 및 허용된 main 배포 워크플로 실행은 가능하다. 업무 모듈 전체를 관리할 수 있다. 시스템 보호 모듈은 수정할 수 없다. 관리자 표시정보: " + JSON.stringify({ name: profile.roblox_username || profile.display_name, rank: profile.rank, position: profile.position, department: profile.department }) },
    { role: "user", content: prompt.slice(0, 1500) },
  ];

  for (let round = 0; round < 5; round++) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-oss-120b", messages, tools, tool_choice: "auto", max_tokens: 900, temperature: 0.2 }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Groq API request failed", response.status, JSON.stringify(result).slice(0, 1000));
      if (response.status === 401) throw new Error("Groq API 키가 유효하지 않습니다.");
      if (response.status === 429) throw new Error("Groq API 사용량 제한을 확인해 주세요.");
      throw new Error("AI 작업 요청에 실패했습니다.");
    }
    const message = result.choices?.[0]?.message;
    if (!message) throw new Error("AI 응답이 비어 있습니다.");
    messages.push(message);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      const answer = String(message.content ?? "").trim();
      if (!answer) throw new Error("AI가 빈 응답을 반환했습니다.");
      return answer.slice(0, 1900);
    }
    for (const call of calls) {
      const name = String(call.function?.name ?? "");
      let args: any;
      try { args = JSON.parse(String(call.function?.arguments ?? "{}")); }
      catch { throw new Error("AI 작업 인수를 해석하지 못했습니다."); }
      let output: unknown;
      try {
        if (name === "get_profile" || name === "update_profile") output = await aiManageProfile(db, profile, name, args);
        else if (name.startsWith("github_")) output = await aiGithubAction(name, args);
        else if (name.startsWith("supabase_")) output = await aiSupabaseAction(name, args);
        else output = await aiManageRecords(db, profile, name, args);
      }
      catch (error) { output = { success: false, error: error instanceof Error ? error.message : "작업 실패" }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output).slice(0, 6000) });
    }
  }
  throw new Error("AI 작업 단계가 너무 많아 중단했습니다. 요청을 나누어 주세요.");
}
function announcementDestinationPicker() {
  return json({
    type: 4,
    data: {
      content: "공지 게시 위치를 선택해 주세요.",
      flags: 64,
      components: [{
        type: 1,
        components: [
          { type: 2, style: 1, label: "일반 공지", custom_id: "announcement_destination:general" },
          { type: 2, style: 4, label: "중요 공지 · 전체 멘션", custom_id: "announcement_destination:important" },
        ],
      }],
    },
  });
}

function announcementPostedResponse(destination: string) {
  const label = destination === "important" ? "중요 공지" : "일반 공지";
  return json({ type: 4, data: { content: "✅ " + label + " 채널에 공지를 게시했습니다.", flags: 64 } });
}

async function postAnnouncementWebhook(destination: string, title: string, body: string, author: string, timestamp: string) {
  const important = destination === "important";
  const secretName = important ? "DISCORD_NOTICE_WEBHOOK_IMPORTANT" : "DISCORD_NOTICE_WEBHOOK_GENERAL";
  const webhookValue = Deno.env.get(secretName) ?? "";
  if (!webhookValue) throw new Error(secretName + " secret is not configured");
  let webhookUrl: URL;
  try {
    webhookUrl = new URL(webhookValue);
  } catch {
    throw new Error("공지 채널 웹훅 주소가 올바르지 않습니다.");
  }
  if (webhookUrl.hostname !== "discord.com" || !webhookUrl.pathname.startsWith("/api/webhooks/")) {
    throw new Error("공지 채널 웹훅 주소가 올바르지 않습니다.");
  }
  webhookUrl.searchParams.set("wait", "true");
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: important ? "@everyone" : "@here",
      embeds: [{
        title: "📢 " + title,
        url: "https://police-rp-intranet.aclclouds.online/",
        description: body,
        color: important ? 0xED4245 : 0x5865F2,
        author: { name: author },
        footer: { text: "경찰 RP 인트라넷" },
        timestamp,
      }],
      allowed_mentions: { parse: ["everyone"] },
    }),
  });
  if (!response.ok) {
    console.error("Discord announcement webhook failed", response.status, await response.text());
    throw new Error("Discord 공지 채널에 게시하지 못했습니다. 웹훅 연결을 확인해 주세요.");
  }
  return await response.json();
}
async function postAuditWebhook(eventType: "custody" | "vehicle" | "personnel", title: string, fields: Array<{ name: string; value: unknown }>) {
  const secrets = { custody: "DISCORD_CUSTODY_WEBHOOK", vehicle: "DISCORD_VEHICLE_WEBHOOK", personnel: "DISCORD_PERSONNEL_WEBHOOK" };
  const secret = secrets[eventType];
  const value = Deno.env.get(secret) ?? "";
  if (!value) { console.warn(secret + " secret is not configured; skipping Discord audit webhook"); return; }
  try {
    const url = new URL(value);
    if (url.hostname !== "discord.com" || !url.pathname.startsWith("/api/webhooks/")) throw new Error("Invalid Discord webhook URL");
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title,
          color: eventType === "custody" ? 0xC0392B : eventType === "vehicle" ? 0x2980B9 : 0x8E44AD,
          fields: fields.slice(0, 10).map(field => ({ name: field.name.slice(0, 256), value: String(field.value ?? "—").slice(0, 1024) || "—", inline: false })),
          footer: { text: "경찰 RP 인트라넷 · Discord 기록" },
          timestamp: new Date().toISOString(),
        }],
        allowed_mentions: { parse: [] },
      }),
    });
    if (!response.ok) console.error("Discord audit webhook failed", eventType, response.status, await response.text());
  } catch (error) {
    console.error("Discord audit webhook failed", eventType, error);
  }
}
function modalResponse(customId: string, title: string, fields: Array<{ id: string; label: string; style?: number; required?: boolean; max?: number; placeholder?: string }>) {
  return json({
    type: 9,
    data: {
      custom_id: customId,
      title,
      components: fields.map((field) => ({
        type: 1,
        components: [{
          type: 4,
          custom_id: field.id,
          label: field.label,
          style: field.style ?? 1,
          required: field.required ?? true,
          max_length: field.max ?? 100,
          placeholder: field.placeholder,
        }],
      })),
    },
  });
}

function modalValues(components: Array<{ components?: Array<{ custom_id?: string; value?: string }> }> = []) {
  const values: Record<string, string> = {};
  for (const row of components) {
    for (const field of row.components ?? []) {
      if (field.custom_id) values[field.custom_id] = String(field.value ?? "").trim();
    }
  }
  return values;
}

function discordUser(interaction: any) {
  return interaction.member?.user ?? interaction.user ?? null;
}

function discordLabel(user: any) {
  return String(user?.global_name || user?.username || "Discord 사용자").trim();
}

function permissionAllowed(profile: any, groups: any[], moduleName: string, action: string) {
  if (profile.role === "admin") return true;
  const groupIds = Array.isArray(profile.permissions) ? profile.permissions.map(String) : [];
  return groups.some((group) =>
    group && groupIds.includes(String(group.id)) &&
    Array.isArray(group.permissions) &&
    group.permissions.some((permission: unknown) =>
      permission === moduleName + ":" + action ||
      permission === moduleName + ":*" ||
      permission === "*:*"
    )
  );
}

async function getAuthorizedProfile(db: ReturnType<typeof createClient>, discordId: string, moduleName: string) {
  const { data: profile, error } = await db.from("profiles")
    .select("id,display_name,discord_username,discord_id,roblox_username,rank,position,department,role,status,active,permissions")
    .eq("discord_id", discordId)
    .maybeSingle();
  if (error) throw error;
  if (!profile || !profile.active || (profile.status !== "approved" && profile.role !== "admin")) {
    throw new Error("연동된 승인 경찰관 계정을 찾을 수 없습니다. 인트라넷에서 Discord 로그인과 가입 승인을 먼저 완료해 주세요.");
  }

  const { data: groupRecord, error: groupError } = await db.from("shared_records")
    .select("payload")
    .eq("module", "permissionSets")
    .eq("record_id", "__list__")
    .maybeSingle();
  if (groupError) throw groupError;
  const groups = Array.isArray(groupRecord?.payload) ? groupRecord.payload : [];
  if (!permissionAllowed(profile, groups, moduleName, "create")) {
    throw new Error("인트라넷 권한 설정에서 이 Discord 계정에 " + moduleName + ":create 권한을 부여해야 합니다.");
  }
  if (!String(profile.roblox_username ?? "").trim()) {
    throw new Error("인트라넷 프로필에 Roblox 닉네임을 먼저 등록해 주세요.");
  }
  return profile;
}

async function writeRecord(db: ReturnType<typeof createClient>, moduleName: string, profileId: string, payload: Json, action: string) {
  const id = crypto.randomUUID();
  const { error } = await db.from("shared_records").insert({
    module: moduleName,
    record_id: id,
    payload: { id, ...payload },
    updated_by: profileId,
  });
  if (error) throw error;

  const auditId = crypto.randomUUID();
  const { error: auditError } = await db.from("shared_records").insert({
    module: "audit",
    record_id: auditId,
    payload: {
      id: auditId,
      action,
      detail: String(payload.name ?? payload.vehicleModel ?? ""),
      actor: String(payload.officer ?? payload.spawnedBy ?? payload.roblox_username ?? ""),
      userId: profileId,
      source: "Discord",
      date: new Date().toISOString(),
    },
    updated_by: profileId,
  });
  if (auditError) console.error("Audit log write failed", auditError);
  return id;
}

async function attendanceAction(db: ReturnType<typeof createClient>, profile: any, user: any, isCheckIn: boolean) {
  const { data: rows, error } = await db.from("shared_records")
    .select("record_id,payload,updated_at")
    .eq("module", "attendance")
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  const own = (rows ?? []).find((row: any) => String(row.payload?.userId ?? "") === String(profile.id) && !row.payload?.out);

  if (isCheckIn && own) throw new Error("이미 출근 상태입니다. 먼저 /퇴근을 처리해 주세요.");
  if (!isCheckIn && !own) throw new Error("열려 있는 출근 기록이 없습니다. 먼저 /출근을 해 주세요.");

  if (isCheckIn) {
    const now = new Date().toISOString();
    const payload = {
      userId: profile.id,
      name: profile.roblox_username,
      roblox_username: profile.roblox_username,
      discord_username: discordLabel(user),
      discord_id: user.id,
      rank: profile.rank || "순경",
      position: profile.position || "직책 미지정",
      dept: profile.department || "미배정",
      department: profile.department || "미배정",
      in: now,
      out: null,
      source: "Discord",
    };
    await writeRecord(db, "attendance", profile.id, payload, "Discord 출근 처리");
    return "출근 처리했습니다: " + profile.roblox_username + " · " + (profile.department || "미배정") + " · " + (profile.rank || "순경");
  }

  const now = new Date().toISOString();
  const payload = { ...own.payload, out: now, source: "Discord" };
  const { error: updateError } = await db.from("shared_records")
    .update({ payload, updated_by: profile.id })
    .eq("module", "attendance")
    .eq("record_id", own.record_id);
  if (updateError) throw updateError;
  return "퇴근 처리했습니다: " + profile.roblox_username;
}

async function handleModal(db: ReturnType<typeof createClient>, interaction: any) {
  const user = discordUser(interaction);
  if (!user?.id) return interactionResponse("Discord 사용자 정보를 확인할 수 없습니다.");
  const customId = String(interaction.data?.custom_id ?? "");
  const values = modalValues(interaction.data?.components);

  if (customId.startsWith("announcement_create:")) {
    const profile = await getAuthorizedProfile(db, user.id, "notices");
    const destination = customId.endsWith(":important") ? "important" : "general";
    const title = values.title ?? "";
    const body = values.body ?? "";
    if (!title || title.length > 100 || !body || body.length > 1400) {
      return interactionResponse("제목과 내용을 확인해 주세요.");
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const category = destination === "important" ? "긴급" : "공지";
    const author = profile.roblox_username || profile.display_name || discordLabel(user);
    const notice = {
      id, title, category, destination, body,
      author,
      date: createdAt, source: "Discord",
      discord_id: user.id, discord_username: discordLabel(user),
    };
    const posted = await postAnnouncementWebhook(destination, title, body, author, createdAt);
    const { error } = await db.from("shared_records").insert({ module: "notices", record_id: id, payload: notice, updated_by: profile.id });
    if (error) throw error;
    const { error: markerError } = await db.from("shared_records").insert({
      module: "discord_announcement_sync",
      record_id: id,
      payload: { noticeId: id, discordMessageId: posted.id ?? null, destination, postedAt: createdAt, source: "Discord" },
      updated_by: profile.id,
    });
    if (markerError) console.error("Announcement sync marker write failed", markerError);
    return announcementPostedResponse(destination);
  }
  if (customId === "vehicle_spawn") {
    const profile = await getAuthorizedProfile(db, user.id, "assets");
    const vehicleModel = values.vehicle_model ?? "";
    const reason = values.reason ?? "";
    const passengers = values.passengers ?? "";
    if (!vehicleModel || !reason) return interactionResponse("차량명과 스폰 사유를 모두 입력해 주세요.");
    await writeRecord(db, "assets", profile.id, {
      type: "차량 스폰",
      name: vehicleModel,
      vehicleModel,
      reason,
      passengers,
      spawnedBy: profile.roblox_username,
      discord_username: discordLabel(user),
      discord_id: user.id,
      createdAt: new Date().toISOString(),
      source: "Discord",
    }, "Discord 차량 스폰 등록");
    await postAuditWebhook("vehicle", "차량 스폰 로그", [
      { name: "처리", value: "차량 스폰" }, { name: "차량 모델", value: vehicleModel },
      { name: "스폰 사유", value: reason }, { name: "탑승자", value: passengers || "—" },
      { name: "담당자", value: profile.roblox_username }, { name: "Discord", value: discordLabel(user) },
      { name: "기록 경로", value: "Discord 봇" },
    ]);
    return interactionResponse("차량 스폰 기록을 등록했습니다: " + vehicleModel);
  }

  if (customId === "vehicle_delete") {
    const profile = await getAuthorizedProfile(db, user.id, "assets");
    const vehicleModel = values.vehicle_model ?? "";
    const reason = values.reason ?? "";
    if (!vehicleModel || !reason) return interactionResponse("차량명과 삭제 사유를 모두 입력해 주세요.");
    await writeRecord(db, "assets", profile.id, {
      type: "차량 삭제",
      name: vehicleModel,
      vehicleModel,
      reason,
      spawnedBy: profile.roblox_username,
      discord_username: discordLabel(user),
      discord_id: user.id,
      createdAt: new Date().toISOString(),
      source: "Discord",
    }, "Discord 차량 삭제 기록");
    await postAuditWebhook("vehicle", "차량 스폰 로그", [
      { name: "처리", value: "차량 삭제 기록" }, { name: "차량 모델", value: vehicleModel },
      { name: "삭제 사유", value: reason }, { name: "담당자", value: profile.roblox_username },
      { name: "Discord", value: discordLabel(user) }, { name: "기록 경로", value: "Discord 봇" },
    ]);
    return interactionResponse("차량 삭제 기록을 남겼습니다: " + vehicleModel);
  }

  if (customId === "custody") {
    const profile = await getAuthorizedProfile(db, user.id, "fines");
    const name = values.target ?? "";
    const reason = values.reason ?? "";
    const custodyMinutes = Number(values.minutes);
    if (!name || !reason || !Number.isInteger(custodyMinutes) || custodyMinutes < 0 || custodyMinutes > 10080) {
      return interactionResponse("대상자, 사유와 0~10080분 사이의 정수 구금 시간을 확인해 주세요.");
    }
    await writeRecord(db, "fines", profile.id, {
      name,
      custodyMinutes,
      reason,
      officer: profile.roblox_username,
      discord_username: discordLabel(user),
      discord_id: user.id,
      createdAt: new Date().toISOString(),
      status: "확인",
      source: "Discord",
    }, "Discord 구금 기록 등록");
    await postAuditWebhook("custody", "구금 기록", [
      { name: "처리", value: "구금 등록" }, { name: "대상자", value: name },
      { name: "구금 시간", value: custodyMinutes + "분" }, { name: "구금 사유", value: reason },
      { name: "담당자", value: profile.roblox_username }, { name: "Discord", value: discordLabel(user) },
      { name: "기록 경로", value: "Discord 봇" },
    ]);
    return interactionResponse("구금 기록을 등록했습니다: " + name + " · " + custodyMinutes + "분");
  }

  return interactionResponse("알 수 없는 입력입니다. 명령을 다시 실행해 주세요.");
}

async function processAction(db: ReturnType<typeof createClient>, interaction: any) {
  try {
    const requiredGuild = Deno.env.get("DISCORD_GUILD_ID");
    const requiredChannel = Deno.env.get("DISCORD_CHANNEL_ID");
    if (!requiredGuild || interaction.guild_id !== requiredGuild) {
      return interactionResponse("이 명령은 인트라넷에 등록된 RP 서버에서만 사용할 수 있습니다.");
    }
    if (!isAllowedInteractionChannel(interaction, requiredChannel)) {
      return interactionResponse("이 명령은 지정된 명령 또는 공지 채널에서만 사용할 수 있습니다.");
    }
    if (interaction.type === 2) {
      const command = String(interaction.data?.name ?? "");
      if (command === COMMANDS.aiCommand) return interactionResponse(await aiAssistantAction(db, interaction));
      const user = discordUser(interaction);
      if (!user?.id) return interactionResponse("Discord 서버에서 실행해 주세요.");

      if (command === COMMANDS.attendanceIn || command === COMMANDS.attendanceOut) {
        const profile = await getAuthorizedProfile(db, user.id, "attendance");
        return interactionResponse(await attendanceAction(db, profile, user, command === COMMANDS.attendanceIn));
      }
    } else if (interaction.type === 5) {
      return await handleModal(db, interaction);
    }
    return interactionResponse("지원하지 않는 Discord 입력 형식입니다.");
  } catch (error) {
    console.error("Discord interaction failed", error);
    const message = error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
    return interactionResponse(message.slice(0, 1800));
  }
}

async function sendDeferredResult(interaction: any, db: ReturnType<typeof createClient>) {
  const result = await processAction(db, interaction);
  const resultBody = await result.json();
  const resultData = resultBody?.data ?? {};
  const followup: Record<string, unknown> = {};
  if (typeof resultData.content === "string") followup.content = resultData.content;
  if (Array.isArray(resultData.embeds)) followup.embeds = resultData.embeds;
  if (Array.isArray(resultData.components)) followup.components = resultData.components;
  if (resultData.allowed_mentions) followup.allowed_mentions = resultData.allowed_mentions;
  if (typeof resultData.flags === "number") followup.flags = resultData.flags;
  const applicationId = String(interaction.application_id ?? "");
  const token = String(interaction.token ?? "");
  if (!applicationId || !token) return;

  const response = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(followup),
  });
  if (!response.ok) console.error("Discord follow-up failed", response.status, await response.text());
}

async function publishSiteAnnouncement(request: Request, body: string) {
  let input: any;
  try {
    input = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (input?.kind !== "announcement-publish" || typeof input.noticeId !== "string") {
    return json({ error: "Unsupported request" }, 400);
  }

  const accessToken = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return json({ error: "Authentication required" }, 401);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server configuration missing" }, 500);

  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await db.auth.getUser(accessToken);
  if (authError || !authData?.user) return json({ error: "Invalid session" }, 401);
  const userId = authData.user.id;

  const { data: profile, error: profileError } = await db.from("profiles")
    .select("id,display_name,roblox_username,role,status,active,permissions")
    .eq("id", userId)
    .maybeSingle();
  if (profileError) return json({ error: "Profile lookup failed" }, 500);
  if (!profile || !profile.active || (profile.status !== "approved" && profile.role !== "admin")) {
    return json({ error: "An approved active intranet profile is required" }, 403);
  }
  const { data: groupRecord, error: groupError } = await db.from("shared_records")
    .select("payload")
    .eq("module", "permissionSets")
    .eq("record_id", "__list__")
    .maybeSingle();
  if (groupError) return json({ error: "Permission lookup failed" }, 500);
  const groups = Array.isArray(groupRecord?.payload) ? groupRecord.payload : [];
  if (!permissionAllowed(profile, groups, "notices", "create")) return json({ error: "notices:create permission is required" }, 403);

  const noticeId = input.noticeId.slice(0, 100);
  const { data: noticeRow, error: noticeError } = await db.from("shared_records")
    .select("record_id,payload,updated_by")
    .eq("module", "notices")
    .eq("record_id", noticeId)
    .maybeSingle();
  if (noticeError) return json({ error: "Notice lookup failed" }, 500);
  if (!noticeRow || noticeRow.updated_by !== userId) return json({ error: "Notice not found for this account" }, 404);
  const notice = noticeRow.payload ?? {};
  const title = String(notice.title ?? "").trim().slice(0, 100);
  const category = String(notice.category ?? "공지").trim();
  const contentBody = String(notice.body ?? "").trim().slice(0, 1400);
  if (!title || !contentBody) return json({ error: "Notice title and body are required" }, 400);

  const markerModule = "discord_announcement_sync";
  const { data: existingMarker, error: markerLookupError } = await db.from("shared_records")
    .select("record_id")
    .eq("module", markerModule)
    .eq("record_id", noticeId)
    .maybeSingle();
  if (markerLookupError) return json({ error: "Sync status lookup failed" }, 500);
  if (existingMarker) return json({ ok: true, alreadyPublished: true });

  const destination = category === "긴급" || notice.destination === "important" ? "important" : "general";
  const secretName = destination === "important" ? "DISCORD_NOTICE_WEBHOOK_IMPORTANT" : "DISCORD_NOTICE_WEBHOOK_GENERAL";
  const author = String(notice.author ?? profile.roblox_username ?? profile.display_name ?? "인트라넷").slice(0, 80);
  try {
    const posted = await postAnnouncementWebhook(destination, title, contentBody, author, String(notice.date ?? new Date().toISOString()));
    const { error: markerError } = await db.from("shared_records").insert({
      module: markerModule,
      record_id: noticeId,
      payload: { noticeId, discordMessageId: posted.id ?? null, category, webhook: secretName, postedAt: new Date().toISOString() },
      updated_by: userId,
    });
    if (markerError) console.error("Announcement sync marker write failed", markerError);
    return json({ ok: true, discordMessageId: posted.id ?? null });
  } catch (error) {
    console.error("Discord announcement publish failed", error);
    return json({ error: error instanceof Error ? error.message : "Unable to reach Discord webhook" }, 502);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.text();
  if (!request.headers.get("x-signature-ed25519")) return await publishSiteAnnouncement(request, body);
  if (!(await verifyDiscordRequest(request, body))) return json({ error: "Invalid Discord request signature" }, 401);

  let interaction: any;
  try {
    interaction = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (interaction.type === 1) return json({ type: 1 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return interactionResponse("서버 설정이 완료되지 않았습니다. 관리자에게 문의해 주세요.");

  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  if (interaction.type === 2) {
    const command = String(interaction.data?.name ?? "");
    const user = discordUser(interaction);
    if (!user?.id) return interactionResponse("Discord 서버에서 실행해 주세요.");

    const requiredGuild = Deno.env.get("DISCORD_GUILD_ID");
    const requiredChannel = Deno.env.get("DISCORD_CHANNEL_ID");
    if (!requiredGuild || interaction.guild_id !== requiredGuild) return interactionResponse("등록된 RP 서버에서만 사용할 수 있습니다.");
    if (!isAllowedInteractionChannel(interaction, requiredChannel)) return interactionResponse("이 명령은 지정된 명령 또는 공지 채널에서만 사용할 수 있습니다.");

    if (command === COMMANDS.intranet) {
      return interactionResponse("경찰청 통합 인트라넷: https://police-rp-intranet.aclclouds.online/");
    }


    if (command === COMMANDS.announcement) {
      return announcementDestinationPicker();
    }

    if (command === COMMANDS.vehicleSpawn) {
      return modalResponse("vehicle_spawn", "차량 스폰 기록", [
        { id: "vehicle_model", label: "차량 모델", max: 80, placeholder: "스폰한 차량 이름" },
        { id: "reason", label: "스폰 사유", style: 2, max: 500, placeholder: "순찰, 출동 등" },
        { id: "passengers", label: "탑승자 (선택)", required: false, max: 200, placeholder: "Roblox 닉네임" },
      ]);
    }

    if (command === COMMANDS.vehicleDelete) {
      return modalResponse("vehicle_delete", "차량 삭제 기록", [
        { id: "vehicle_model", label: "차량 모델", max: 80, placeholder: "삭제한 차량 이름" },
        { id: "reason", label: "삭제 사유", style: 2, max: 500, placeholder: "차량 삭제 사유" },
      ]);
    }

    if (command === COMMANDS.custody) {
      return modalResponse("custody", "구금 기록", [
        { id: "target", label: "대상자 Roblox 닉네임", max: 40 },
        { id: "minutes", label: "구금 시간 (분)", max: 5, placeholder: "예: 10" },
        { id: "reason", label: "구금 사유", style: 2, max: 500 },
      ]);
    }

    if (command !== COMMANDS.attendanceIn && command !== COMMANDS.attendanceOut && command !== COMMANDS.aiCommand) {
      return interactionResponse("지원하지 않는 명령입니다.");
    }
  } else if (interaction.type === 3) {
    const customId = String(interaction.data?.custom_id ?? "");
    const destination = customId === "announcement_destination:important" ? "important" :
      customId === "announcement_destination:general" ? "general" : "";
    if (!destination) return interactionResponse("공지 위치 선택을 다시 실행해 주세요.");
    return modalResponse("announcement_create:" + destination, "공지 작성", [
      { id: "title", label: "제목", max: 100, placeholder: "공지 제목" },
      { id: "body", label: "내용", style: 2, max: 1400, placeholder: "공지 내용을 입력하세요" },
    ]);
  } else if (interaction.type !== 5) {
    return interactionResponse("지원하지 않는 Discord 입력 형식입니다.");
  }

  const task = sendDeferredResult(interaction, db).catch((error) => {
    console.error("Deferred Discord action failed", error);
  });
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(task);
    return json({ type: 5, data: isAnnouncementFlow(interaction) ? { flags: 64 } : undefined });
  }

  await task;
  return interactionResponse("요청 처리를 완료했습니다.");
});
