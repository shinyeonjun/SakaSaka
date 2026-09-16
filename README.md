# Intent World Agent

Figma Product UI와 FigJam Master Architecture를 TypeScript로 구현한 실행 가능한 애플리케이션입니다. UI mock만이 아니라 Intent, World observation, source-linked Context, closed-loop runtime, Human boundary, evidence lineage, experience memory, evaluation, durable worker, security boundary, SSE control plane까지 하나의 typed contract로 연결합니다.

## 현재 상태와 실사용 주의

**연구용 로컬 런타임입니다. 운영 격리와 실제 모델의 자율 개발 품질은 별도로 검증해야 합니다.**
최신 구조·변경 근거·보안 제한·재실험 절차는 [런타임 재검토 기록](docs/runtime-hardening.md)에 정리했습니다.
모의 모델 acceptance 통과는 실제 Codex 모델이 제품을 완성한다는 증명이 아닙니다.

## Quick start

```bash
npm install
npm run dev
```

브라우저만 실행하면 프로젝트가 없는 빈 localStorage 기반 UI가 열립니다. 실제 workspace 관찰·quality gate·영속 snapshot·SSE를 사용하려면 API와 worker를 함께 실행합니다.

### 데스크톱 앱으로 실행

Tauri 데스크톱 앱은 API와 worker를 앱 수명에 맞춰 자동으로 시작하고 종료합니다. 앱 안의 `폴더 선택`은 네이티브 디렉터리 선택기를 사용하며, 선택한 폴더가 실제 프로젝트 변경 경계가 됩니다. 상태·raw evidence·로그는 OS별 앱 데이터 폴더에 저장됩니다.

```bash
npm run desktop:dev
```

설치용 번들은 프런트엔드와 API/worker Node sidecar를 함께 생성합니다. 별도 `npm run api`나 `npm run worker`가 필요하지 않습니다.

```bash
npm run desktop:build
```

개발 모드에서는 저장소의 Node 실행 환경으로 sidecar를 띄우고, 배포 빌드에서는 `src-tauri/binaries`에 현재 플랫폼용 self-contained Node sidecar를 생성해 Tauri 번들에 포함합니다. Codex CLI는 모델 gateway로 계속 host의 `codex` 인증을 사용합니다.

프로젝트가 하나도 없어도 사이드바의 `환경 설정`에서 모델 provider와 Codex 기본 모델을 먼저 선택할 수 있습니다. 저장한 값은 브라우저의 다음 프로젝트 기본값으로 사용되고, 프로젝트 생성 후에는 프로젝트별 `설정`에서 덮어쓸 수 있습니다.

신규 프로젝트 화면의 `작업 폴더 선택`에서 경로를 지정하면 해당 프로젝트는 그 폴더 하나만 사용합니다. 경로는 서버가 접근할 수 있는 `WORKSPACE_ROOT` 내부여야 하며, 비워두면 서버가 `WORKSPACE_ROOT/.intent-world/workspaces/<projectId>`를 자동으로 만들어 바인딩합니다. 브라우저 전용 모드의 폴더 입력은 OS 경로를 가장하지 않도록 비활성화됩니다. 실제 폴더 연결과 쓰기 권한은 프로젝트의 `설정` 화면에서 확인합니다.

API로 생성한 프로젝트는 `WORKSPACE_ROOT/.intent-world/workspaces/<projectId>`를 자동으로 확보하므로 기존 repository가 없어도 그린필드 의도를 시작할 수 있습니다. `modelProvider=auto`는 `MODEL_API_URL`과 `MODEL_API_KEY`가 모두 있으면 OpenAI 호환 게이트웨이를 사용하고, 그렇지 않으면 `CODEX_CLI_ENABLED=true`일 때 Codex CLI 게이트웨이를 사용합니다. `CODEX_CLI_ENABLED`를 명시하지 않은 경우에만 `CODEX_CLI_BIN` 설정으로 Codex CLI 자동 선택을 켤 수 있습니다. 어느 실제 provider도 설정되지 않으면 가짜 행동을 생성하지 않고 `MODEL_FAILED`와 실제 원인을 기록합니다. `WAIT`는 모델이 실제로 내린 대기 판단에만 사용합니다. 결정론적 기준선은 명시적으로 `modelProvider=deterministic`을 선택한 연구·오프라인 모드에서만 사용합니다.

```bash
# terminal 1
npm run api

# terminal 2
npm run worker

# terminal 3
VITE_API_URL=http://localhost:8787 npm run dev
```

PowerShell:

```powershell
$env:VITE_API_URL = "http://localhost:8787"
npm run dev
```

### Codex CLI를 모델 게이트웨이로 연결

Codex CLI는 SakaSaka의 도구가 아니라 `ModelGateway`입니다. CLI는 현재 원문 의도·월드 관찰·경험·경계를 입력받아 `ActionEnvelope` 하나만 반환하고, 실제 파일 변경·명령·프로세스·브라우저 검증은 SakaSaka의 ToolGateway와 Governor가 수행합니다. CLI는 `codex exec`의 구조화 JSONL 출력과 읽기 전용 sandbox로 호출되어 프로젝트 workspace를 직접 수정하지 않습니다.

1. Codex CLI를 설치하고 한 번 로그인합니다. 저장된 Codex 인증을 사용할 수 있습니다.
2. API와 worker를 실행하기 전에 provider를 켭니다.

```powershell
codex login
$env:CODEX_CLI_ENABLED = "true"
$env:CODEX_CLI_BIN = "codex.exe" # PATH에 codex가 있으면 생략 가능
$env:CODEX_CLI_MODEL = ""         # 선택 사항 · 비워두면 Codex 기본 모델
$env:CODEX_CLI_MODELS = ""        # 선택 사항 · 비우면 기본 추천, 지정하면 서버 catalog를 대체
npm run api
```

프로젝트 전 `환경 설정`과 프로젝트별 `설정`의 모델 선택기는 기본 추천 목록을 먼저 보여주고, 서버가 `CODEX_CLI_MODELS`로 지정한 목록이 있으면 그 목록으로 대체합니다. 기본 목록은 계정 entitlement의 증명이 아니며 첫 실제 모델 호출이 지원 여부의 기준입니다. `CODEX_CLI_MODEL` 또는 Codex `config.toml`의 설정값은 기본 선택값으로 반영됩니다. 목록에 없는 유효한 모델 ID는 직접 입력할 수 있습니다. 모델 ID를 비워두면 Codex 기본 모델을 사용합니다. 선택한 값은 실제 `codex exec --model <선택값>`으로 전달됩니다. 응답이 잘못됐거나 CLI가 없거나 시간이 초과되면 `ModelGatewayError`/`MODEL_FAILED`와 원본 오류 참조를 남깁니다. 모델의 WAIT로 위장하지 않습니다. 실행 형식은 [Codex 비대화형 실행 문서](https://developers.openai.com/codex/noninteractive/)를 따릅니다.

실제 CLI 프로토콜은 다음 두 단계로 구분해서 확인합니다.

```bash
npm run smoke:codex
npm run smoke:codex -- --run
```

첫 명령은 설치·로그인만 확인합니다. 두 번째는 모델 사용량이 발생할 수 있는 실제 구조화 응답 검사이며, 반환된 SakaSaka 도구를 실행하지 않습니다. Codex CLI가 상속하는 MCP/hook 등은 전용 테스트 설정에서 먼저 확인하십시오. CLI의 읽기 전용 옵션만으로 외부 도구까지 완전히 격리되었다고 보장하지 않습니다.

브라우저 binary가 설치되어 있지 않은 환경에서는 Playwright가 설치된 뒤 다음을 한 번 실행합니다.

```bash
npm run browser:install
```

Playwright를 실행할 수 없을 때 HTTP 관찰 fallback은 `UNCERTAIN` evidence로만 기록됩니다. DOM/browser PASS로 위장하지 않습니다.

## Product routes

- `/projects/new` — 의도 입력, 자율성 경계, 예산/최대 실행 시간 설정
- `/projects/:id` — 개요와 ACTIVE / WAITING / EQUILIBRIUM / STALLED 상태
- `/projects/:id/needs-you` — 질문 / 아이디어 / 우려 / 승인 목록
- `/projects/:id/human-items/:itemId` — rationale, 영향 범위, 답변/승인
- `/projects/:id/activity` — 이벤트 타임라인, 버전 provenance, 증거 연결
- `/projects/:id/world` — 저장소 / 런타임 / 브라우저 / DB / 로그 / 사람의 현재 관찰
- `/projects/:id/artifacts` — 빌드, 리포트, 스크린샷, 릴리스, 문서 계보
- `/projects/:id/experiments` — H1-H6, 벤치마크, 구성요소 비교, 정책 후보
- `/projects/:id/settings` — 작업 폴더 바인딩, Codex/모델 provider 연결 상태, 샌드박스·네트워크 경계
- `/settings` — 프로젝트 생성 전 기본 provider·Codex 모델 선택과 연결 상태
- `/handoff/routes`, `/handoff/runtime` — Figma UI 인계 계약

## Runtime and service contract

`src/runtime.ts`의 cycle은 다음 순서를 보존합니다.

`WAKE → OBSERVE → ASSEMBLE CONTEXT → DECIDE → VALIDATE/DISPATCH → VERIFY → COMMIT EXPERIENCE → GOVERN → NEXT`

Context에는 원문 Intent/constraints, fresh source-linked compact observation, open Human state와 이미 받은 답변, provenance 있는 experience, 도구별 inputSchema, budget/permission boundary가 들어갑니다. raw output은 모델 지시가 아니라 `rawRef`를 가진 untrusted evidence로만 보존합니다.

`server/index.ts`는 다음 control-plane API를 제공합니다.

- `GET /health`, `GET /state`, `GET /projects`
- `POST /projects`, `GET /projects/:id`
- `POST /projects/:id/wake`, `/run` — 202 큐 등록; 실제 모델/도구는 worker에서 실행
- `POST /projects/:id/world/refresh`, `/stall`
- `GET /projects/:id/runtime-status` — 실제 선택 provider, Codex CLI 설치 확인, 작업 폴더 존재·쓰기 권한
- `GET /runtime/model-catalog` — Codex 기본 추천 모델 목록과 선택적 `CODEX_CLI_MODELS` 서버 목록
- `GET /runtime/model-status?provider=...&model=...` — 프로젝트 없이 실제 provider·CLI·인증 상태 확인
- `GET /runtime/workspace-root`, `POST /runtime/workspace-root` — 데스크톱에서 선택한 실제 작업 폴더 경계 확인/변경
- `POST /runs/:runId/pause|resume|kill`
- `POST /human-items/:itemId/answer|approve|reject|defer|acknowledge`
- `GET /projects/:id/events?after=...`, `/stream`, `/actions`, `/contexts`, `/relations`, `/retrieval-index`, `/evaluation`
- `GET /evidence/:id`, `/evidence/:id/raw`
- artifact와 experiment 생성/조회/실행 route

API snapshot은 `.data/state.json`, 직전 정상 snapshot 백업은 `.data/state.json.bak`, append-only event journal은 `.data/state.json.events.jsonl`, worker queue는 `.data/state.json.queue.json`, local observability는 `.data/observability.jsonl`에 기록됩니다. snapshot writer와 API/worker 사이에는 atomic replace + cross-process lock이 있고, primary snapshot이 손상되면 마지막 백업을 우선 복구합니다. 이 로컬 adapter의 현재 상태는 snapshot에 저장되고 event journal은 중복 방지된 변경 provenance/replay 보조 기록으로 유지됩니다. production에서는 `src/ports.ts`의 Event Store/Job Queue 경계를 PostgreSQL·pgvector와 Redis/BullMQ 같은 운영 adapter로 교체해야 합니다.

## Security boundary

- workspace는 `WORKSPACE_ROOT` 내부로 정규화하고 symlink escape를 거부합니다.
- shell은 process adapter에서 fixed command ID만 허용하며 `repo.read`는 status/diff/diff-check만 노출합니다. 임의의 개발 argv는 Docker sandbox에서만 allowlist를 통과합니다.
- browser/network는 deny-by-default allowlist, credential URL 거부, redirect 재검사, Playwright route 차단을 사용합니다. DB source도 credential을 출력하지 않는 TCP health observation으로 실제 endpoint 상태를 확인합니다.
- process 실행은 timeout/max-buffer와 환경 secret 제거를 적용합니다. `sandboxMode=docker`는 non-root, read-only, network none, CPU/memory/pid/tmpfs 제한을 추가합니다.
- 외부/파괴적 작업은 P3 hard block 또는 Human approval item으로 전환됩니다.
- tool/model output과 adapter error는 redaction 후 rawRef/evidence로 기록합니다.

**process adapter는 보안 격리가 아닙니다.** 생성된 JavaScript나 package script는 호스트 권한으로 실행됩니다. 비밀 정보가 없는 별도 테스트 환경에서만 사용하십시오. Docker의 dependency bridge 네트워크도 완전한 egress allowlist를 강제하지 않습니다. 운영 격리가 필요하면 Docker sandbox와 실제 Secrets Broker, database transaction, distributed queue를 배치해야 합니다. API는 기본 127.0.0.1에 바인딩하고 Origin/Host를 검사합니다. 외부 바인딩은 SAKASAKA_API_TOKEN을 요구하며 현재 UI는 로컬 실행을 전제로 합니다. 별도 다중 사용자 인증 시스템은 아닙니다.

## Verification gates

```bash
npm ci
npm run lint
npm run typecheck
npm run build:api
npm test -- --run
npm run acceptance
npm run acceptance:api
npm run acceptance:autonomous
npm run acceptance:experiments
npm run acceptance:ui
npm run acceptance:desktop
npm run build
npm run security:check
git diff --check
```

`acceptance:api`는 별도 API 프로세스와 worker를 실제로 띄워 project creation, duplicate/path/body validation, local quality cycle, evidence raw retrieval, cursor/SSE replay, worker convergence, pause/resume/kill까지 검증합니다. `acceptance:autonomous`는 빈 workspace와 실제 mock OpenAI-compatible HTTP server를 사용해 multi-cycle greenfield 파일 생성·build·test·managed process·Playwright 검증 및 maintenance patch를 실행합니다. `acceptance:experiments`는 동일 Intent·model·budget·starting digest를 유지한 격리 workspace A/B/C/D/E 실행과 provenance를 검사합니다. A는 1회 호출 대조군이며 각 variant는 ContextPacket의 서로 다른 정보 범위를 사용합니다. E의 policy candidate는 실제 평가로 발급된 후보만 노출하며 후보가 없으면 빈 배열로 유지합니다. 점수는 관측 proxy이며 H1–H6를 자동 통과시키지 않습니다. `acceptance:ui`는 실제 Chromium에서 모든 제품 route와 Human answer flow를 열고, Figma 기준 desktop 레이아웃과 390px responsive overflow를 검증합니다.

## Version control

원격 저장소: [shinyeonjun/SakaSaka](https://github.com/shinyeonjun/SakaSaka)

구현 변경은 작업 브랜치에서 검증한 뒤 PR로 검토합니다. main 직접 덮어쓰기나 자동 병합을 하지 않습니다.
