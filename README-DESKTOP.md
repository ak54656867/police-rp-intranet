# 경찰 RP 인트라넷 데스크톱 앱

Windows용 Electron 설치 프로그램을 GitHub Actions에서 빌드합니다.

## 기능
- 이메일/비밀번호 로그인 (Supabase Auth)
- 중앙 PostgreSQL 데이터베이스 연결
- 인사·조직, 근무·출퇴근, 사건, 수배, 출동, 휴가, 차량·장비, 공지, 감사 로그
- 계급/직책별 데이터베이스 RLS 권한 정책 초안
- Windows 설치 프로그램(.exe) 빌드 자동화

## 실행 준비
1. Supabase 프로젝트를 만들고 SQL Editor에서 `supabase/schema.sql`을 실행합니다.
2. Supabase Authentication > Users에서 첫 사용자를 생성합니다.
3. 그 사용자의 UUID를 확인하고 SQL Editor에서 아래와 같이 관리자 프로필을 등록합니다.
   ```sql
   insert into public.profiles(id, display_name, role, department, rank)
   values ('사용자-UUID', '시스템 관리자', 'admin', '경찰청', '치안총감');
   ```
4. GitHub Actions의 **Build Windows Desktop App** 실행이 완료되면 실행 기록의 Artifacts에서 설치 파일을 받습니다.
5. 앱의 연결 설정에 Supabase Project URL 및 anon/publishable key를 입력합니다.

## 보안 안내
- `service_role` 키를 앱에 넣지 마세요. 공개 anon/publishable 키만 사용하고, RLS를 통해 권한을 제한합니다.
- 조직의 실제 계정/개인정보가 아닌 가상 RP 데이터로 테스트하세요.
- 이 저장소의 스키마와 앱은 운영 전 검토가 필요한 초기 버전입니다. 관리자 권한 부여는 Supabase 대시보드에서 통제하세요.
- 데이터 삭제, 민감한 기록, 실사용 배포 전에 백업·보존·감사 정책을 검토하세요.
