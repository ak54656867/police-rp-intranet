# 경찰청 통합 인트라넷 (RP)

경찰 역할극 커뮤니티를 위한 정적 웹 인트라넷입니다. 인사·조직, 출퇴근, 사건, 수배, 상황실·출동, 휴가, 차량·장비, 공지, 문서, 감사 로그를 제공합니다.

## 배포 사이트

https://ak54656867.github.io/police-rp-intranet/

## Supabase + Discord 최초 설정

프론트엔드 코드와 SQL 스키마는 저장소에 포함되어 있습니다. **실제 인증과 데이터베이스는 소유자의 Supabase/Discord 프로젝트에서 아래 설정을 한 뒤 활성화됩니다.** 저장소 코드만으로 외부 계정의 Client Secret을 만들거나 프로젝트 설정을 대신 변경할 수는 없습니다.

1. Supabase에서 프로젝트를 만들고 **SQL Editor**를 엽니다.
2. 새 프로젝트라면 저장소의 `supabase/schema.sql` 전체를 SQL Editor에서 실행합니다. 이미 운영 중인 프로젝트라면 전체 스키마를 재실행하지 말고 `supabase/security_hardening.sql`과 `supabase/org_management_migration.sql`을 순서대로 실행합니다. 새 마이그레이션은 Discord 닉네임, 직책, 가입 승인자 기록 필드와 세부 권한 그룹의 RLS 검사를 추가합니다. 보안 강화 후 기존 비관리자 계정은 승인 대기 상태가 될 수 있으므로 최고 관리자 센터에서 신뢰할 수 있는 구성원만 승인하세요.
3. Supabase의 **Authentication → Providers → Discord**에서 Discord provider를 활성화합니다.
4. Discord Developer Portal에서 OAuth2 애플리케이션을 만들고 Client ID와 Client Secret을 Supabase의 Discord provider 설정에 입력합니다. Secret은 웹사이트 코드나 GitHub 저장소에 넣지 마세요.
5. Supabase **Authentication → URL Configuration**에서 Site URL을 `https://ak54656867.github.io`로 설정하고 Redirect URLs에 `https://ak54656867.github.io/police-rp-intranet/`를 추가합니다. Discord Developer Portal의 OAuth2 Redirect URL에는 Supabase가 표시하는 callback URL을 입력합니다(일반적으로 `https://<project-ref>.supabase.co/auth/v1/callback`).
6. 웹사이트에서 **연동 설정**을 누르고 Project URL과 공개용 anon/publishable key를 저장합니다. `service_role` 키는 절대 입력하지 마세요.
7. 먼저 신뢰할 수 있는 최고 관리자 계정을 준비하고 로그인합니다. 공유 데이터가 비어 있을 때는 최고 관리자만 초기 데이터를 등록할 수 있습니다. 이후 승인된 구성원이 Discord 로그인하면 공유 기록을 불러오며, 변경 사항은 권한 정책에 따라 Supabase에 저장되고 Realtime으로 전달됩니다.

## 최고 관리자 계정 초기 설정

가입 프로필의 raw_user_meta_data는 사용자 편집이 가능하므로, 이 값만 보고 최고 관리자 권한을 자동 부여하면 안 됩니다. 현재 SQL은 신규 계정을 기본 경찰관·승인 대기로 생성합니다.

1. Discord로 최고 관리자 계정에 로그인해 프로필을 생성합니다.
2. Supabase SQL Editor에서 다음 조회를 실행하고, auth.identities의 Discord 제공자 데이터에서 Discord ID를 직접 확인합니다.

```sql
select u.id as auth_user_uuid, i.provider, i.identity_data
from auth.users u
join auth.identities i on i.user_id = u.id
where i.provider = 'discord';
```

3. 확인된 UUID를 사용해 최고 관리자 프로필을 설정합니다.

```sql
update public.profiles
set display_name = '생활안전교통국장',
    role = 'admin',
    department = '생활안전교통국',
    rank = '생활안전교통국장',
    active = true,
    status = 'approved',
    application_submitted = true
where id = '<검증한 auth_user_uuid>';
```

기존 프로젝트에서 과거 onboarding_admin.sql을 실행했다면, 관리자 센터의 계정 목록에서 admin 권한 계정이 실제로 신뢰하는 Discord 계정인지 별도로 확인하세요. SQL 파일 수정은 이미 데이터베이스에 반영된 기존 권한을 자동으로 정리하지 않습니다.

## 동작 방식 및 주의사항

- 로그인 전 데이터는 현재 브라우저의 `localStorage`에 저장됩니다.
- 공유 데이터가 비어 있을 때 일반 계정의 브라우저 로컬 기록을 자동 업로드하지 않습니다. 최고 관리자가 최초 초기화를 수행해야 다른 구성원의 로컬 기록이 실수로 공유 데이터에 섞이지 않습니다.
- 가입 신청은 Roblox 닉네임, Discord 닉네임, 희망 배치 계급·부서를 저장합니다. 승인 처리자의 Discord 닉네임과 처리 시각은 계정 관리에 표시됩니다. 승인된 구성원은 인사 목록에 자동 등록됩니다.
- 부서·직책 설정과 세부 권한 그룹은 `shared_records`의 목록 레코드로 공유됩니다. 그룹별 조회·등록·수정·삭제·승인 항목은 계정에 부여할 수 있으며, 기존 프로젝트는 `supabase/org_management_migration.sql`을 적용해야 그룹 권한이 RLS에도 반영됩니다.
- 공유 데이터는 승인된 RP 구성원끼리 공유됩니다. `supabase/security_hardening.sql`은 승인 여부와 역할별 읽기·추가·수정·삭제 권한을 분리하며, 감사 로그와 조직 설정은 일반 계정이 수정·삭제하지 못하도록 제한합니다. 정책은 실제 Supabase 프로젝트에 마이그레이션을 실행해야 적용됩니다.
- Supabase 프로젝트 URL/key와 Discord OAuth 설정이 없으면 이 대화만으로 외부 서비스 연결을 실제 검증할 수 없습니다.
- 가상 역할극 용도로만 사용하세요. 실제 개인정보, 실제 사건 정보, 민감한 경찰 정보를 입력하지 마세요.

## 배포

GitHub Actions가 `site/` 디렉터리를 GitHub Pages로 배포합니다. 저장소의 **Settings → Pages**에서 Source가 **GitHub Actions**로 설정되어 있어야 합니다.
