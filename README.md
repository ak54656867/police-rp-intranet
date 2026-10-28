# 경찰청 통합 인트라넷 (RP)

경찰 역할극 커뮤니티를 위한 정적 웹 인트라넷입니다. 인사·조직, 출퇴근, 사건, 수배, 상황실·출동, 휴가, 차량·장비, 공지, 문서, 감사 로그를 제공합니다.

## 배포 사이트

https://ak54656867.github.io/police-rp-intranet/

## Supabase + Discord 최초 설정

프론트엔드 코드와 SQL 스키마는 저장소에 포함되어 있습니다. **실제 인증과 데이터베이스는 소유자의 Supabase/Discord 프로젝트에서 아래 설정을 한 뒤 활성화됩니다.** 저장소 코드만으로 외부 계정의 Client Secret을 만들거나 프로젝트 설정을 대신 변경할 수는 없습니다.

1. Supabase에서 프로젝트를 만들고 **SQL Editor**를 엽니다.
2. 새 프로젝트라면 저장소의 `supabase/schema.sql` 전체를 SQL Editor에서 실행합니다. 이미 운영 중인 프로젝트라면 전체 스키마를 재실행하지 말고 `supabase/security_hardening.sql`만 실행해 보안 정책과 누락된 프로필 필드를 적용합니다. 이 마이그레이션 이후 기존 비관리자 계정은 승인 대기 상태가 되므로, 최고 관리자 센터에서 신뢰할 수 있는 구성원만 다시 승인하세요.
3. Supabase의 **Authentication → Providers → Discord**에서 Discord provider를 활성화합니다.
4. Discord Developer Portal에서 OAuth2 애플리케이션을 만들고 Client ID와 Client Secret을 Supabase의 Discord provider 설정에 입력합니다. Secret은 웹사이트 코드나 GitHub 저장소에 넣지 마세요.
5. Supabase **Authentication → URL Configuration**에서 Site URL을 `https://ak54656867.github.io`로 설정하고 Redirect URLs에 `https://ak54656867.github.io/police-rp-intranet/`를 추가합니다. Discord Developer Portal의 OAuth2 Redirect URL에는 Supabase가 표시하는 callback URL을 입력합니다(일반적으로 `https://<project-ref>.supabase.co/auth/v1/callback`).
6. 웹사이트에서 **연동 설정**을 누르고 Project URL과 공개용 anon/publishable key를 저장합니다. `service_role` 키는 절대 입력하지 마세요.
7. **Discord 로그인**을 누릅니다. 인증에 성공하면 공유 기록을 불러오며, 기록 추가·변경·삭제는 Supabase에 저장되고 다른 로그인 이용자에게 Realtime으로 전달됩니다.

## 동작 방식 및 주의사항

- 로그인 전 데이터는 현재 브라우저의 `localStorage`에 저장됩니다.
- 최초로 연결한 로그인 브라우저에 로컬 기록이 있고 클라우드가 비어 있으면 해당 기록을 공유 공간에 초기 등록합니다. 이후에는 클라우드 데이터를 기준으로 표시합니다.
- 공유 데이터는 로그인한 이용자끼리 공유됩니다. 현재 기본 RLS 정책은 로그인한 RP 구성원에게 공통 기록의 읽기/쓰기 권한을 줍니다. 운영 서버에 적용하기 전에 역할별 쓰기 권한을 더 세분화해야 합니다.
- Supabase 프로젝트 URL/key와 Discord OAuth 설정이 없으면 이 대화만으로 외부 서비스 연결을 실제 검증할 수 없습니다.
- 가상 역할극 용도로만 사용하세요. 실제 개인정보, 실제 사건 정보, 민감한 경찰 정보를 입력하지 마세요.

## 배포

GitHub Actions가 `site/` 디렉터리를 GitHub Pages로 배포합니다. 저장소의 **Settings → Pages**에서 Source가 **GitHub Actions**로 설정되어 있어야 합니다.
