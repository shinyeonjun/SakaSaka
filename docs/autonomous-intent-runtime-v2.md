# SakaSaka Autonomous Intent Runtime v2

SakaSaka의 실행 단위는 사람이 쪼개서 입력하는 Task가 아니라 **Intent**입니다. 사람은 원하는 결과와 경계만 제공하고, 런타임은 부족한 문제 공간을 스스로 탐색하고 우선순위를 정하고 실행한 뒤 실제 증거로 검증합니다.

## 인지 계층

- **Deterministic code**: 권한, 예산, 경로, schema, idempotency, compiler/test 결과처럼 정확히 계산 가능한 것.
- **DecisionGateway / System 1**: 이미 주어진 후보에 대한 bounded semantic judgment. 현재 `codex-cli`, Jev 승인 후 `jev`, Jev 우선 + Codex fallback인 `hybrid`를 지원합니다.
- **Codex native / System 2**: 새로운 문제 후보 생성, 실제 저장소 조사, 설계, 코딩, 명령 실행, 실패 복구.
- **Independent coverage scouts**: 서로 다른 fresh context에서 제품/UX, 보안/인프라, 아키텍처/데이터/테스트 관점을 read-only workspace 위에서 조사합니다.
- **Human**: 가치·취향·사업 판단과 비가역/고위험 경계. 질문은 전체 조직이 아니라 실제 의존 범위만 막습니다.

핵심 흐름은 다음과 같습니다.

`Intent → World observation → Coverage discovery → Gap frontier → Mission selection → Codex native work → Evidence → Mission review → Re-discovery`

## 지금 바로 쓰기

Jev가 없어도 기본 DecisionGateway는 Codex CLI라서 기존 Codex 로그인만 있으면 동작합니다.

```bash
npm install
codex login
npm run decision:setup
npm run desktop:dev
```

`npm run decision:setup`에서 `codex-cli`, `jev`, `hybrid` 중 판단 계층을 선택합니다. Jev 승인을 받기 전에는 `codex-cli`를 고르면 됩니다.

새 프로젝트에서는 실제 workspace를 연결하고 모델 provider를 **Codex CLI**, 실행 방식을 **지속형 Codex App Server**로 선택한 뒤 Intent를 입력합니다.

## Jev 연결

Jev는 hard governor가 아니라 빠른 bounded semantic decision layer입니다. 파일 쓰기·네트워크·production·승인·예산 같은 실행 권한을 Jev가 허용할 수 없습니다.

Early access 승인을 받은 뒤:

```bash
npm run decision:setup
```

대화형 setup은 TypeSafe API key를 TTY에서 숨김 입력으로 받습니다. key는 AppState, event journal, model context, browser localStorage에 저장되지 않습니다. 기본적으로 `state.json`과 같은 디렉터리의 `runtime-config.json`에만 저장되고, POSIX에서는 `0600` 권한을 적용합니다.

`hybrid`는 bounded judgment에서 Jev를 우선 사용하고 Jev 호출이 실패하거나 사용할 수 없을 때 Codex structured decision으로 fallback합니다. hard policy와 실제 side effect는 어느 경우에도 fallback으로 우회되지 않습니다.

환경변수로 관리하고 싶으면 TypeSafe 공식 SDK와 같은 이름을 fallback으로 사용할 수 있습니다.

```bash
SAKASAKA_DECISION_PROVIDER=hybrid
TYPESAFE_API_KEY=...
TYPESAFE_BASE_URL=https://api.typesafe.ai
TYPESAFE_DEFAULT_MODEL=jev-latest
```

로컬 `runtime-config.json`의 provider/key/model 값이 해당 환경변수보다 우선합니다. 완전한 endpoint를 직접 지정해야 하는 실험 환경에서만 `TYPESAFE_API_URL`을 사용합니다.

## Coverage / Gap Graph

런타임은 Product, UX, Architecture, Application, Data, Security, Privacy, Infrastructure, Networking, Reliability, Observability, Performance, Testing, Deployment, Operations, Cost, Compliance surface를 기본 coverage map으로 갖습니다. 이 taxonomy는 체크리스트 답안이 아니라 **탐색하지 않은 영역을 잊지 않기 위한 안전망**입니다.

독립 Codex scout들은 서로 다른 fresh context lens로 잠재 gap을 생성합니다. 각 scout는 실제 workspace를 `read-only` sandbox에서 읽을 수 있지만 파일을 바꿀 수 없습니다. 후보는 정규화·중복 제거·risk/uncertainty/novelty/urgency 점수화되고, DecisionGateway가 현재 priority frontier를 판단합니다. 실제 write worker는 한 번에 가장 가치 있는 mission 하나만 지속형 Codex thread에서 수행합니다.

Intent 자체의 end-to-end delivery도 1급 gap으로 유지해서, 보안이나 인프라 같은 부수 위험만 쫓다가 사용자가 원한 제품 완성을 잊지 않도록 합니다.

## 반복과 비용 제어

Discovery는 매 worker tick마다 호출하지 않습니다. Intent가 바뀌었거나 첫 discovery가 아직 없거나 configured review interval이 지났을 때만 다시 수행합니다.

```bash
SAKASAKA_DISCOVERY_PARALLELISM=3
SAKASAKA_COVERAGE_REVIEW_MINUTES=60
```

동일 gap은 normalized key로 병합되고 하나의 mission만 `RUNNING` 상태가 됩니다. Codex checkpoint가 `equilibrium`을 선언해도 material unresolved gap이 남아 있으면 postlude가 다시 깨웁니다. 반대로 mission 완료는 checkpoint 문구만 믿지 않고 objective satisfied와 evidence sufficient 판단을 함께 요구합니다.

## Human asynchronous boundary

기존 `blockingScope` / `continuingScope` 계약을 그대로 사용합니다. 질문 답변이 오기 전에도 독립 작업은 계속합니다. 답변이 늦게 도착하면 새 authoritative event로 처리하며 현재 world를 다시 관찰합니다.

## 저장 파일

```text
.data/state.json           기존 source-linked runtime state
.data/state.json.events.jsonl
.data/state.json.queue.json
.data/autonomy.json        gap / mission / coverage / decision traces
.data/runtime-config.json  local decision provider + TypeSafe secret
.data/raw/                 Codex/Jev/tool 원본 provenance
```

`runtime-config.json`은 Git에 커밋하지 마십시오. 기본 `.gitignore`의 `.data` 경계 안에 두는 것을 권장합니다.

## Safety invariants

1. 모델이 policy, permission, secret, production boundary를 소유하지 않습니다.
2. 모델 output은 사실이 아니라 untrusted proposal/trace입니다.
3. 완료 주장은 test/browser/world/human evidence와 연결되어야 합니다.
4. bounded decision failure는 hard policy를 우회하지 않습니다.
5. persistent Codex thread가 죽어도 SakaSaka durable state가 진실 원장입니다.
6. 여러 worker가 같은 repo를 병렬 수정하는 기능은 worktree/merge arbitration 없이 활성화하지 않습니다. 현재 v2는 discovery만 병렬화하고 실제 write worker는 한 mission씩 실행합니다.
7. Jev의 schema-constrained 결과는 사실 정확성 보증이 아닙니다. 실제 World evidence가 우선합니다.

## 검증 기준

이 기능은 merge 전에 다음을 통과해야 합니다.

- client/server TypeScript typecheck
- gap merge / mission lifecycle / DecisionGateway / local secret config unit tests
- 기존 security gate와 workspace escape tests
- API / desktop / autonomous / UI acceptance
- Ubuntu 22.04 native Codex sandbox integration

이 테스트들이 discovery recall 자체를 완전히 증명하는 것은 아닙니다. `initiativeRecall`, `initiativePrecision`, evidence coverage, human intervention count, token/cost, false stop/wake를 계속 실험 지표로 봐야 합니다.
