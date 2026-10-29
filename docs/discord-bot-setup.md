# Discord 빠른 기록 명령 설정

이 연동은 인원 명부나 대시보드 데이터를 Discord에 복제하지 않습니다. Discord에서는 출퇴근, 차량 스폰·삭제, RP 구금 기록만 빠르게 입력하고 전체 조회와 수정은 기존 인트라넷에서 합니다.

## 포함 명령

- `/출근`, `/퇴근`: Discord 계정과 연결된 승인 경찰관 계정으로 기록합니다.
- `/차량스폰`: 차량명, 스폰 사유, 탑승자를 입력합니다.
- `/차량삭제`: 차량명과 삭제 사유를 기록합니다.
- `/구금`: 대상 Roblox 닉네임, 시간(분), 사유를 기록합니다.

기록은 기존 `shared_records`의 `attendance`, `assets`, `fines` 모듈에 저장되므로 인트라넷의 기존 기록과 함께 표시됩니다. 명령 응답은 실행자에게만 보이는 개인 응답입니다.

## 1. 데이터베이스 연결

Supabase SQL Editor에서 저장소의 `supabase/discord_bot_migration.sql`을 한 번 실행합니다. 이 SQL은 기존 Discord OAuth 계정의 ID를 `profiles.discord_id`에 채우고, Discord 로그인 계정과 프로필을 연결합니다.

실행 후 profiles에서 계정이 연동됐는지 확인할 수 있습니다.

```sql
select display_name, discord_username, discord_id, roblox_username, status, active
from public.profiles
order by created_at;
```

`discord_id`가 비어 있는 구성원은 Discord로 인트라넷에 다시 로그인한 뒤 확인하세요. 마이그레이션은 데이터 레코드를 삭제하지 않습니다.

## 2. Discord Developer Portal 설정

1. 기존 로그인용 Discord 애플리케이션을 엽니다.
2. **General Information**에서 **Public Key**를 복사합니다.
3. **Installation**에서 Guild Install을 허용하고 기본 scope에 `applications.commands`를 넣습니다. 이 기능은 봇이 서버 메시지를 읽거나 채널에 임의 메시지를 게시하지 않으므로, 명령 사용만을 위해 `bot` scope나 Administrator 권한은 필요하지 않습니다.
4. **Interactions Endpoint URL**에 아래 Edge Function URL을 넣습니다.

   `https://lnauhbnisreigaqoeabq.supabase.co/functions/v1/discord-interactions`

Discord 서버에 앱을 설치할 때는 Guild Install의 설치 링크를 사용합니다. 서버 ID는 Discord 개발자 모드에서 확인할 수 있습니다.

## 3. Edge Function 배포와 비밀 값

Supabase CLI를 설치한 작업 폴더에서 저장소 루트에 실행합니다.

```sh
supabase functions deploy discord-interactions --no-verify-jwt
```

함수 서명 검증과 DB 권한에는 아래 Edge Function secrets가 필요합니다.

```sh
supabase secrets set DISCORD_PUBLIC_KEY=개발자포털에서복사한PublicKey
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=Supabase서비스역할키
supabase secrets set DISCORD_GUILD_ID=디스코드서버ID
```

`SUPABASE_URL`은 Supabase Edge Functions에 기본 제공됩니다. **Service role key와 Discord bot token은 웹사이트 코드, Discord 채팅, GitHub에 올리지 마세요.** 이 기능은 Interaction Endpoint만 사용하므로 봇 토큰은 필요하지 않습니다.

## 4. 명령 등록

guild 명령 등록 스크립트를 실행할 때만 Discord Bot Token이 필요합니다. 토큰은 저장소에 넣지 말고 작업 PC의 환경 변수로 설정합니다.

PowerShell:

```powershell
$env:DISCORD_APPLICATION_ID="Developer Portal의 Application ID"
$env:DISCORD_BOT_TOKEN="Developer Portal에서 안전하게 발급한 Bot Token"
$env:DISCORD_GUILD_ID="RP Discord 서버 ID"
node scripts/register-discord-commands.mjs
```

명령은 지정한 서버에만 등록되어 테스트할 때 바로 표시됩니다. 토큰을 다시 발급해야 하는지 확인하고, 기존 토큰이 있다면 Reset Token을 누르지 마세요. 토큰을 잃어버렸거나 새 Bot Token을 만들어야 할 때에만 안전하게 발급하고 사용 후 환경 변수에서 지우세요.

## 5. 권한

각 명령은 인트라넷 프로필이 활성 상태이고 가입 승인됐는지 확인합니다. 권한은 인트라넷의 권한 그룹 설정을 그대로 사용합니다.

- 출근·퇴근: `attendance:create`
- 차량 스폰·삭제: `assets:create`
- 구금: `fines:create`

최고 관리자는 권한 그룹 설정과 무관하게 사용할 수 있습니다. 그 외에는 해당 명령의 `create` 권한을 받은 계정만 기록을 등록합니다. 사용자는 자신의 Discord 계정을 인트라넷에 연결하고 Roblox 닉네임을 등록해야 합니다.

## 체크리스트

- [ ] migration SQL 성공
- [ ] Discord ID가 profiles에 채워짐
- [ ] Edge Function secrets 설정 및 배포
- [ ] Interactions Endpoint URL 저장 성공 (Discord가 PING/PONG 검증)
- [ ] 명령 등록 스크립트 실행 성공
- [ ] 승인된 계정으로 출근 → 퇴근 시험
- [ ] 차량 및 구금 기록이 인트라넷에 나타나는지 확인
