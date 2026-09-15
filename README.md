# Intent World Agent

Figma의 Intent World Agent 아키텍처와 Product UI를 TypeScript로 연결한 실행 가능한 제품 vertical slice입니다. UI 상태만 그린 것이 아니라 Intent, World snapshot, event log, action, evidence, Human boundary, memory experience, runtime lifecycle을 하나의 typed state model로 묶었습니다.

## Run

```bash
npm install
npm run dev
```

검증 명령:

```bash
npm test -- --run
npm run build
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

실제 배포 환경에서는 현재 typed domain contract에 맞춰 Model Gateway, Tool Gateway, sandbox/world adapter, Postgres event store, queue와 OpenTelemetry provider를 연결할 수 있습니다. 외부 side effect는 project boundary의 승인 설정을 통과하는 지점으로 분리되어 있습니다.

## Version control

원격 저장소:

`https://github.com/shinyeonjun/SakaSaka.git`

현재 구현은 `main` 브랜치에 로컬 커밋으로 보존되며, 원격 push는 별도 확인 후 진행합니다.
