# SakaSaka Autonomous Intent Runtime v2

SakaSaka의 실행 단위는 사람이 쪼개서 입력하는 Task가 아니라 **Intent**입니다. 사람은 원하는 결과와 경계를 제공하고, 런타임은 부족한 문제 공간을 스스로 탐색하고 우선순위를 정하고 실행한 뒤 실제 증거로 검증합니다.

## 인지 계층

- **Deterministic code**: 권한, 예산, 경로, schema, idempotency, 테스트 결과처럼 정확히 계산 가능한 것.
- **DecisionGateway**: 이미 주어진 후보에 대한 bounded semantic judgment. 현재 `codex-cli`, Jev 승인 후 `jev`, 운영 중 fallback을 허용하는 `hybrid`를 지원합니다.
- **Codex System-2**: 새로운 문제 후보 생성, 조사, 설계, 코딩, 실패 복구, 독립 critic/scout.
- **Human**: 가치·취향·사업 판단과 비가역/고위험 경계. 질문은 전체 조직이 아니라 실제 의존 범위만 막습니다.

## 지금 바로 쓰기

기본 DecisionGateway는 Codex CLI입니다. 기존 Codex 로그인만 있으면 Jev 없이 동작합니다.

```bash
codex login
npm install
npm run desktop:dev
```

환경 변수로 판단 계층을 바꿀 수 있습니다.

```bash
# 현재 기본값
SAKASAKA_DECISION_PROVIDER=codex-cli

# Jev early access 승인 후
SAKASAKA_DECISION_PROVIDER=jev
TYPESAFE_API_KEY=...
TYPESAFE_JEV_MODEL=jev-latest

# Jev 우선 + 실패/미설정 시 Codex 판단 fallback
SAKASAKA_DECISION_PROVIDER=hybrid
TYPESAFE_API_KEY=...
```

Jev key는 모델 context, 이벤트, raw trace에 기록하지 않습니다. Jev는 semantic judgment만 수행하고 실제 파일/네트워크/배포 권한은 기존 deterministic boundary가 계속 소유합니다.

## Coverage / Gap Graph

런타임은 Product, UX, Architecture, Application, Data, Security, Privacy, Infrastructure, Networking, Reliability, Observability, Performance, Testing, Deployment, Operations, Cost, Compliance surface를 기본 coverage map으로 갖습니다. 이 taxonomy는 체크리스트 답안이 아니라 **탐색하지 않은 영역을 잊지 않기 위한 안전망**입니다.

독립 Codex scout들은 서로 다른 fresh context lens로 잠재 gap을 생성합니다. 후보는 정규화·중복 제거·risk/uncertainty/novelty/urgency 점수화되고, DecisionGateway가 현재 priority frontier를 판단합니다. 실제 worker는 가장 가치가 높은 mission을 지속형 Codex thread에서 수행합니다.

## Human asynchronous boundary

기존 `blockingScope` / `continuingScope` 계약을 그대로 사용합니다. 질문 답변이 오기 전에도 독립 작업은 계속합니다. 답변이 늦게 도착하면 새 authoritative event로 처리하며 현재 world를 다시 관찰합니다.

## Safety invariants

1. 모델이 policy, permission, secret, production boundary를 소유하지 않습니다.
2. 모델 output은 사실이 아니라 untrusted proposal/trace입니다.
3. 완료 주장은 test/browser/world/human evidence와 연결되어야 합니다.
4. bounded decision failure는 hard policy를 우회하지 않습니다.
5. persistent Codex thread가 죽어도 SakaSaka durable state가 진실 원장입니다.
6. 여러 worker가 같은 repo를 병렬 수정하는 기능은 worktree/merge arbitration 없이 활성화하지 않습니다. 현재 v2는 discovery를 병렬화하고 실제 write worker는 한 mission씩 실행합니다.
