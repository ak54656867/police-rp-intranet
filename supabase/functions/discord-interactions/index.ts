import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-signature-ed25519, x-signature-timestamp",
};

const COMMANDS = {
  attendanceIn: "출근",
  attendanceOut: "퇴근",
  vehicleSpawn: "차량스폰",
  vehicleDelete: "차량삭제",
  custody: "구금",
  intranet: "인트라넷",
};

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
    if (!requiredChannel || interaction.channel_id !== requiredChannel) {
      return interactionResponse("이 명령은 지정된 Discord 채널에서만 사용할 수 있습니다.");
    }
    if (interaction.type === 2) {
      const command = String(interaction.data?.name ?? "");
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
  const content = String(resultBody?.data?.content ?? "요청을 처리했습니다.");
  const applicationId = String(interaction.application_id ?? "");
  const token = String(interaction.token ?? "");
  if (!applicationId || !token) return;

  const response = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) console.error("Discord follow-up failed", response.status, await response.text());
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.text();
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
    if (!requiredChannel || interaction.channel_id !== requiredChannel) return interactionResponse("지정된 Discord 채널에서만 사용할 수 있습니다.");

    if (command === COMMANDS.intranet) {
      return interactionResponse("경찰청 통합 인트라넷: https://police-rp-intranet.aclclouds.online/");
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

    if (command !== COMMANDS.attendanceIn && command !== COMMANDS.attendanceOut) {
      return interactionResponse("지원하지 않는 명령입니다.");
    }
  } else if (interaction.type !== 5) {
    return interactionResponse("지원하지 않는 Discord 입력 형식입니다.");
  }

  const task = sendDeferredResult(interaction, db).catch((error) => {
    console.error("Deferred Discord action failed", error);
  });
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(task);
    return json({ type: 5 });
  }

  await task;
  return interactionResponse("요청 처리를 완료했습니다.");
});
