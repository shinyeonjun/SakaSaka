# Intent World Agent

Figma Product UI와 FigJam Master Architecture를 TypeScript로 구현한 실행 가능한 애플리케이션입니다. UI mock만이 아니라 Intent, World observation, source-linked Context, closed-loop runtime, Human boundary, evidence lineage, experience memory, evaluation, durable worker, security boundary, SSE control plane까지 하나의 typed contract로 연결합니다.

## Quick start

```bash
npm install
npm run dev
```

브라우저만 실행하면 localStorage 기반의 standalone UI가 열립니다. 실제 workspace 관찰·quality gate·영속 snapshot·SSE를 사용하려면 API와 worker를 함께 실행합니다.

API로 생성한 프로젝트는 `WORKSPACE_ROOT/.intent-world/workspaces/<projectId>`를 자동으로 확보하므로 기존 repository가 없어도 greenfield Intent를 시작할 수 있습니다. `modelProvider=auto`는 `MODEL_API_URL`과 `MODEL_API_KEY`가 모두 있으면 OpenAI-compatible gateway를 사용하고, 없으면 provider 종류가 명시된 deterministic baseline으로 동작합니다. deterministic baseline도 고정된 bounded capability를 실제로 실행하지만 model reasoning을 대체하지는 않습니다. 실제 AI 실행을 원하면 API/worker에 해당 환경 변수를 설정하세요.

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

브라우저 binary가 설치되어 있지 않은 환경에서는 Playwright가 설치된 뒤 다음을 한 번 실행합니다.

```bash
npm run browser:install
```

Playwright를 실행할 수 없을 때 HTTP 관찰 fallback은 `UNCERTAIN` evidence로만 기록됩니다. DOM/browser PASS로 위장하지 않습니다.

## Product routes

- `/projects/new` — Intent 입력, autonomy boundary, budget/max-hours 설정
- `/projects/:id` — Overview와 ACTIVE / WAITING / EQUILIBRIUM / STALLED 상태
- `/projects/:id/needs-you` — Questions / Ideas / Concerns / Approvals inbox
- `/projects/:id/human-items/:itemId` — rationale, 영향 범위, 답변/승인
- `/projects/:id/activity` — event timeline, version provenance, evidence chain
- `/projects/:id/world` — Repo / Runtime / Browser / DB / Logs / Human 현재 관찰
- `/projects/:id/artifacts` — build, report, screenshot, release, docs lineage
- `/projects/:id/experiments` — H1-H6, benchmark, ablation, policy candidate
- `/handoff/routes`, `/handoff/runtime` — Figma UI handoff contract

## Runtime and service contract

`src/runtime.ts`의 cycle은 다음 순서를 보존합니다.

`WAKE → OBSERVE → ASSEMBLE CONTEXT → DECIDE → VALIDATE/DISPATCH → VERIFY → COMMIT EXPERIENCE → GOVERN → NEXT`

Context에는 원문 Intent/constraints, fresh source-linked compact observation, open Human state, provenance 있는 experience, 실제 capability surface, budget/permission boundary가 들어갑니다. raw output은 모델 지시가 아니라 `rawRef`를 가진 untrusted evidence로만 보존합니다.

`server/index.ts`는 다음 control-plane API를 제공합니다.

- `GET /health`, `GET /state`, `GET /projects`
- `POST /projects`, `GET /projects/:id`
- `POST /projects/:id/wake`, `/run`, `/world/refresh`, `/stall`
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

기본 local mode는 개발 환경 호환성을 위한 process adapter입니다. 운영 격리가 필요하면 Docker sandbox와 실제 Secrets Broker, database transaction, distributed queue를 배치해야 합니다. API에는 인증이 포함되어 있지 않으므로 localhost 또는 별도 인증 reverse proxy 뒤에서 사용해야 합니다.

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
npm run build
npm run security:check
git diff --check
```

`acceptance:api`는 별도 API 프로세스와 worker를 실제로 띄워 project creation, duplicate/path/body validation, local quality cycle, evidence raw retrieval, cursor/SSE replay, worker convergence, pause/resume/kill까지 검증합니다. `acceptance:autonomous`는 빈 workspace와 실제 mock OpenAI-compatible HTTP server를 사용해 multi-cycle greenfield 파일 생성·build·test·managed process·Playwright 검증 및 maintenance patch를 실행합니다. `acceptance:experiments`는 동일 Intent·model·budget·starting digest를 유지한 격리 workspace A–E 실행을 수행하고 실제 run/evidence/evaluator 결과를 비교합니다. `acceptance:ui`는 실제 Chromium에서 모든 제품 route와 Human answer flow를 열고, Figma 기준 desktop 레이아웃과 390px responsive overflow를 검증합니다.

## Version control

원격 저장소: [shinyeonjun/SakaSaka](https://github.com/shinyeonjun/SakaSaka)

구현 변경은 `main` 브랜치에 커밋하고 원격 저장소에 push합니다.
