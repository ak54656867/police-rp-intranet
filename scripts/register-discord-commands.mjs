// Register guild-scoped commands for fast RP record entry.
// Required environment variables: DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID
const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!applicationId || !botToken || !guildId) {
  throw new Error("Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and DISCORD_GUILD_ID.");
}

const commands = [
  { name: "출근", description: "인트라넷에 출근을 기록합니다." },
  { name: "퇴근", description: "인트라넷에 퇴근을 기록합니다." },
  { name: "차량스폰", description: "차량 스폰 기록을 작성합니다." },
  { name: "차량삭제", description: "차량 삭제 기록을 작성합니다." },
  { name: "구금", description: "RP 구금 기록을 작성합니다." },
  { name: "인트라넷", description: "경찰청 통합 인트라넷 링크를 안내합니다." },
  { name: "공지", description: "일반 또는 중요 위치를 선택해 공지를 등록합니다." },
];

const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  },
);
const result = await response.text();
if (!response.ok) throw new Error(`Discord command registration failed (${response.status}): ${result}`);
console.log("Registered guild commands:", result);
