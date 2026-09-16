# Native 실행기 검증 기록

검토한 원격 기준: PR #2 `d9672642b23c68b340668450a30e39da1fb48373` (main 기반 `5ead4100af9fb3a1ac2499ae1e6a59f6f99bef9c`). 검증일 2026-09-17. 요구사항별 근거는 `figma-implementation-map.md`에 원본 FigJam/Figma 노드와 연결한다.

## 실제로 수행한 검사

| 검사 | 결과 / 범위 |
|---|---|
| `npm test -- --run` | 105개 테스트 / 24개 파일 통과. 기존 88개 검사 보존 + 신규 17개 |
| `npm run build:api` | TypeScript API 검사 통과 |
| `npm run build` | TypeScript와 Vite 빌드 통과 |
| `npm run acceptance` | 실제 로컬 실행·계속 실행·질문 미루기/답변·경계 검사 통과 |
| `npm run acceptance:api` | 실제 API/worker 검사 통과. 실행기 선택/한도/잘못된 입력/마이그레이션 시 일시 정지 추가 확인 |
| `npm run acceptance:experiments` | 기존 A–E 인프라 검사 통과. native/Dream-RSI 효과나 가설 입증이 아님 |
| `npm run acceptance:native:core` | 실제 공개 Codex 0.154.0 App Server + 로컬 모의 Responses 서버로 검사. 실제 파일 쓰기/실패한 테스트/수정/같은 thread의 질문 답변/세션 재개/유지보수/작업 폴더 밖 쓰기 거절/재개 후 사용량 증가 확인 |
| 전체 Native + Chromium | 아직 미통과. 실행 환경의 브라우저 탐색이 관리자 정책으로 차단됨. HTTP fallback을 브라우저 PASS로 처리하지 않음 |
| 원격 GitHub CI | 이 변경의 원격 실행 결과가 아직 없음. 기존 PR의 초록색 CI는 이 새 코드의 검증으로 사용하지 않음 |
| 실제 로그인한 Codex + 실제 모델 제품 개발 | 미실행. 사용자의 실제 CLI 인증은 이 환경에 없음 |

`acceptance:native:core`는 브라우저를 실행하지 않는 별도 범위다. 필수 CI `native-codex-integration`은 축소하지 않은 `acceptance:native`를 사용한다. 검사 순서의 모의 모델은 테스트 fixture일 뿐 production의 개발 workflow가 아니다.

## 신규 회귀 검사

- App Server 양방향 JSONL, UTF-8 분할, 잘못된 JSON, 출력 상한, 종료 시 대기 요청 정리.
- 단일 native turn 안의 여러 도구 호출과 오류 복구. 파일/명령 실패 하나를 프로젝트 중단으로 바꾸지 않음.
- 질문 등록 즉시 미응답(null) 반환, 독립 작업 계속, DEFERRED 이후 실제 답변을 같은 thread에 전달.
- 질문 대기 뒤 동일 thread 재개, 계속 실행 checkpoint, 새 신호의 유지보수.
- 미리보기 ID가 잘못됐을 때 도구 피드백으로 복구. native ID와 managed preview ID를 혼합하지 않음.
- 정확한 외부 패키지 승인 선소비 및 1회 실행. 일반 native 권한 확대는 거절한 뒤 가능한 작업 계속.
- 누적 토큰 중복 과금 방지/한도 중단, Pause/interrupt, 외부 MCP/hook 설정 차단.
- 실제 명령 상태가 누락된 raw 결과는 UNCERTAIN으로 보존. 결과·경험·검색 인덱스의 출처 연결 및 중복 방지.
- 숨겨진 reasoning/encrypted 내용을 도구 증거로 보존하지 않음.
- 원문 Intent는 변경하지 않고 모델에 전송하는 중복 Intent 필드에서도 비밀 패턴을 제거.

## 합격으로 해석하면 안 되는 것

모의 모델 검사가 통과했다고 모델의 주도성·디자인 품질·숨은 요구 발견·필수 작업 완결성을 입증한 것은 아니다. `equilibrium`은 에이전트의 현재 상태 보고이며 제품 전체의 독립 검증이 아니다. 실행 PASS는 해당 명령/파일/명시적인 브라우저 단언 범위만 의미한다.

## 사용 전 경계

기존 프로젝트는 자동으로 실행 권한을 바꾸지 않는다. 프로젝트 설정에서 `지속형 Codex App Server`와 `Codex CLI`를 명시적으로 선택하고 저장한 다음 재개한다. 원자적 engine은 이전 데이터/API 모델 호환용으로 남는다.

Native 파일/명령은 Codex의 OS workspace-write 제한과 네트워크 차단으로 실행한다. Docker/process 설정은 추가 환경 도구에만 적용된다. Docker 안에서 native 세션 전체가 실행된다고 표시하지 않는다. 완전한 읽기 격리·일반 호스트 비밀 보호·분산 exactly-once·외부 부작용 rollback은 보장하지 않는다. 중요한 비밀/운영 데이터가 없는 전용 계정 또는 VM에서 검증해야 한다.

외부 MCP, hooks, 자동 외부 실행이 있는 Codex 설정은 native 시작 전에 거절한다. 감사한 전용 설정은 `SAKASAKA_CODEX_HOME`으로 지정할 수 있다. 소스·대화·상태에 실제 API 키를 붙이지 않는다. 실패 원본은 로컬 rawRef로 남긴다.
