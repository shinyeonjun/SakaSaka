# Native 실행기 검증 기록

검토한 원격 기준: PR #2가 squash merge된 `origin/main` `19d0487bcbbfc6bf6a6fa6dc8d7381d67351fd9b`. 이번 후속 수정은 PR #3의 기존 HEAD `9956280d057e235de192d195c0e576a37283b821`에 추가한다. 검증일 2026-09-17. 요구사항별 근거는 `figma-implementation-map.md`에 원본 FigJam/Figma 노드와 연결한다.

## 실제로 수행한 검사

| 검사 | 결과 / 범위 |
|---|---|
| `npm test -- --run` | 121개 테스트 / 25개 파일 통과. 기존 native 회귀와 checkpoint/reference, OS별 smoke preflight 회귀 포함 |
| `npm run build:api` | TypeScript API 검사 통과 |
| `npm run build` | TypeScript와 Vite 빌드 통과 |
| `npm run acceptance` | 실제 로컬 실행·계속 실행·질문 미루기/답변·경계 검사 통과 |
| `npm run acceptance:api` | 실제 API/worker 검사 통과. 실행기 선택/한도/잘못된 입력/마이그레이션 시 일시 정지 추가 확인 |
| `npm run acceptance:experiments` | 기존 A–E 인프라 검사 통과. native/Dream-RSI 효과나 가설 입증이 아님 |
| Windows 로컬 model-free preflight | PR #3 코드, Windows, Codex CLI 0.153.2. 전용 홈·App Server·`inherit=core`·Windows sandbox·Node·PowerShell·정확한 15바이트 파일 검사 통과 |
| Windows 로컬 실제 모델 smoke | PR #3 코드, Windows, Codex CLI 0.153.2. 실제 파일·checkpoint·artifact 참조까지 통과. 제품 전체 개발 능력 검증은 아님 |
| Windows 로컬 `npm run acceptance:native:core` | PR #3 코드, Windows, Codex CLI 0.153.2. **미해결 실패**: 첫 결과가 `EQUILIBRIUM`을 보고한 뒤 `logic.mjs`가 없어 `ENOENT`. 성공으로 승격하지 않음 |
| PR #3 원격 GitHub CI | 커밋 `9956280d…`, GitHub Actions `ubuntu-22.04`, pinned Codex 0.154.0, 전체 native/Chromium 경로. `security-and-gates`, `native-codex-integration`, `contracts-and-runtime` **3/3 성공** |

위 결과는 커밋·OS·Codex 버전이 다른 증거를 합치지 않도록 분리했다. 특히 Windows의 0.153.2 로컬 fixture 실패와 Ubuntu의 0.154.0 원격 CI 성공은 서로를 대체하지 않는다.

## 이번 checkpoint 계약 수정 검증

- 실제 실패 응답의 Windows 절대 경로를 fixture로 넣은 오프라인 회귀를 수정 전 먼저 재현했다. 기존 파서는 같은 입력을 3회 연속 거절했고, 수정 후에는 schema와 parser가 공백·한글·역슬래시 경로를 같은 문자열 제약으로 허용한다.
- `npm run smoke:native -- --keep`에서 모델을 호출하지 않고 Windows에서 `codex-cli 0.153.2`, 전용 홈, 실제 `shell_environment_policy.inherit=core`, `windowsSandbox/readiness=ready`, Node의 15바이트 파일 쓰기·읽기, PowerShell 기동을 각각 확인했다. 비Windows에서는 Windows readiness와 PowerShell을 `not-applicable`로 보고하고 Node 검사는 계속한다.
- 같은 사전 검사를 통과한 뒤 `--run`을 한 번 실행했다. 실제 임시 작업공간의 `native-smoke.txt`가 정확히 15바이트로 일치했고, 프로젝트/run은 `EQUILIBRIUM`, native 세션은 `resting`이었다. checkpoint는 정상 처리됐으며 모델의 `artifact:native-smoke.txt`는 `artifact / unverified`로 보존하고 관련 실제 evidence ID만 연결했다. 사용량은 total 34,823 / input 34,564 / cached input 17,024 / output 259였다.
- `SAKASAKA_CODEX_HOME`이 없을 때는 기본 사용자 `.codex`로 폴백하지 않고 모델을 호출하지 않는다. 외부 MCP/hook 설정이 있는 홈도 native 시작 전에 거절한다.
- 같은 Windows·0.153.2에서 `npm run acceptance:native:core`의 로컬 fixture는 `logic.mjs`를 만들기 전에 equilibrium을 반환해 파일 assertion에서 `ENOENT`로 실패했다. 이는 실제 모델 smoke 통과와 별개의 미해결 실패이며, Ubuntu·0.154.0 원격 CI의 3개 성공 체크를 0.153.2 성공으로 표시하지 않는다.
- PR #3의 원격 체크는 커밋 `9956280d…` 기준으로 실행됐다. 원격 `native-codex-integration`은 pinned Codex 0.154.0과 전체 `acceptance:native` 경로를 사용하고, 실제 Chromium 검사를 포함해 성공했다.

`acceptance:native:core`는 브라우저를 실행하지 않는 별도 범위다. 필수 CI `native-codex-integration`은 축소하지 않은 `acceptance:native`를 사용한다. 검사 순서의 모의 모델은 테스트 fixture일 뿐 production의 개발 workflow가 아니다.

## 신규 회귀 검사

- App Server 양방향 JSONL, UTF-8 분할, 잘못된 JSON, 출력 상한, 종료 시 대기 요청 정리.
- 단일 native turn 안의 여러 도구 호출과 오류 복구. 파일/명령 실패 하나를 프로젝트 중단으로 바꾸지 않음.
- 질문 등록 즉시 미응답(null) 반환, 독립 작업 계속, DEFERRED 이후 실제 답변을 같은 thread에 전달.
- 질문 대기 뒤 동일 thread 재개, 계속 실행 checkpoint, 새 신호의 유지보수.
- 미리보기 ID가 잘못됐을 때 도구 피드백으로 복구. native ID와 managed preview ID를 혼합하지 않음.
- 정확한 외부 패키지 승인 선소비 및 1회 실행. 일반 native 권한 확대는 거절한 뒤 가능한 작업 계속.
- 누적 토큰 중복 과금 방지/한도 중단, Pause/interrupt, 외부 MCP/hook 설정 차단.
- checkpoint schema/parser 동등 제약, 실제 Windows 경로, 한글·공백 경로, 작업공간 밖/경로 탈출/다른 프로젝트 Evidence ID/임의 URI의 분리. 산출물 경로는 Evidence ID로 승격하지 않으며, 파싱 불가능한 checkpoint는 원본 thread·작업 기록을 보존하고 자동 재실행하지 않는다.
- 실제 명령 상태가 누락된 raw 결과는 UNCERTAIN으로 보존. 결과·경험·검색 인덱스의 출처 연결 및 중복 방지.
- 숨겨진 reasoning/encrypted 내용을 도구 증거로 보존하지 않음.
- 원문 Intent는 변경하지 않고 모델에 전송하는 중복 Intent 필드에서도 비밀 패턴을 제거.

## 합격으로 해석하면 안 되는 것

모의 모델 검사가 통과했다고 모델의 주도성·디자인 품질·숨은 요구 발견·필수 작업 완결성을 입증한 것은 아니다. `equilibrium`은 에이전트의 현재 상태 보고이며 제품 전체의 독립 검증이 아니다. 실행 PASS는 해당 명령/파일/명시적인 브라우저 단언 범위만 의미한다.

## 사용 전 경계

기존 프로젝트는 자동으로 실행 권한을 바꾸지 않는다. 프로젝트 설정에서 `지속형 Codex App Server`와 `Codex CLI`를 명시적으로 선택하고 저장한 다음 재개한다. 원자적 engine은 이전 데이터/API 모델 호환용으로 남는다.

Native 파일/명령은 Codex의 OS workspace-write 제한과 네트워크 차단으로 실행한다. Docker/process 설정은 추가 환경 도구에만 적용된다. Docker 안에서 native 세션 전체가 실행된다고 표시하지 않는다. 완전한 읽기 격리·일반 호스트 비밀 보호·분산 exactly-once·외부 부작용 rollback은 보장하지 않는다. 중요한 비밀/운영 데이터가 없는 전용 계정 또는 VM에서 검증해야 한다.

외부 MCP, hooks, 자동 외부 실행이 있는 Codex 설정은 native 시작 전에 거절한다. 감사한 전용 설정은 `SAKASAKA_CODEX_HOME`으로 지정할 수 있다. 소스·대화·상태에 실제 API 키를 붙이지 않는다. 실패 원본은 로컬 rawRef로 남긴다.
