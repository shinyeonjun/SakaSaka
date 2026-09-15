# Intent World Agent

Figma의 Intent World Agent 아키텍처와 Product UI를 TypeScript로 구현한 실행 가능한 애플리케이션입니다. Intent, World snapshot/observation, append-only event log, action selection, evidence, Human boundary, memory experience, policy experiment, resource ledger, runtime lifecycle을 하나의 typed state model로 묶었습니다.

## Run

```bash
npm install
npm run dev
```

브라우저만 사용하는 로컬 모드는 localStorage를 사용합니다. REST control plane과 영속 state, SSE live event stream까지 사용하려면 별도 터미널에서 API를 실행하고 Vite에 주소를 전달합니다.

```bash
npm run api
VITE_API_URL=http://localhost:8787 npm run dev
```

PowerShell에서는 다음처럼 실행할 수 있습니다.

```powershell
$env:VITE_API_URL = "http://localhost:8787"
npm run dev
```

검증 명령:

```bash
npm test -- --run
npm run build
npm run build:api
```

## Routes

- `/projects/new` — Intent 입력과 autonomy/budget boundary
- `/projects/:id` — Overview와 ACTIVE / WAITING / EQUILIBRIUM 상태
- `/projects/:id/needs-you` — Question / Idea / Concern / Approval inbox
- `/projects/:id/human-items/:itemId` — 영향 범위가 포함된 Human 응답
- `/projects/:id/activity` — event timeline과 evidence chain
- `/projects/:id/world` — Repo / Runtime / Browser / DB / Logs / Human 관찰 상태
- `/projects/:id/artifacts` — artifact 생성과 검증 결과
- `/projects/:id/experiments` — H1-H6와 ablation ladder
- `/handoff/routes`, `/handoff/runtime` — Figma handoff contract

## Runtime model

`src/runtime.ts`는 `WAKE → OBSERVE → ASSEMBLE CONTEXT → DECIDE → DISPATCH → VERIFY → COMMIT EXPERIENCE → GOVERN` 루프를 순수 함수로 구현합니다. 브라우저에서는 event-sourced `AppState`를 localStorage에 보존하며, 원본 Intent와 event history를 덮어쓰지 않습니다.

`server/index.ts`는 다음 control-plane contract를 제공합니다.

- project / intent / wake / run / pause / resume / kill
- Needs You answer / approve / reject / defer / acknowledge
- World refresh, event cursor 조회, project SSE stream
- artifact와 experiment 생성·실행

현재 실행은 결정론적 local Model/Tool/World adapter입니다. `src/ports.ts`의 Model Gateway, Tool Gateway, sandbox/world adapter, Event Store, Memory, Evaluator, Resource Ledger port에 실제 provider를 연결할 수 있으며, 외부 side effect는 project boundary 승인 설정을 통과하는 지점으로 분리되어 있습니다.

## Version control

원격 저장소:

`https://github.com/shinyeonjun/SakaSaka.git`

구현은 `main` 브랜치에 커밋하고 원격 저장소에 push합니다.
