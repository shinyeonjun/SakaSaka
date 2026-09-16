# 실사용 런타임 재검토 및 구현 기록

검토 기준: `79f45f25d4a06ea4178a9a322e00b936d3a3ce39` / 2026-09-17.

이 문서는 구현된 계약, 공식 문서로 확인한 외부 제약, 아직 검증하지 못한 가설을 구분한다. 스크린샷만으로 사용자의 실제 STALLED 원인을 하나로 확정하지 않는다. 원본 Codex 오류·실행 상태·사용자 환경은 제공되지 않았다.

## 1. 재현 가능한 결함과 변경

| 기존 경로에서 확인한 결함 | 변경 | 검사 |
|---|---|---|
| Codex 출력 `params`가 열린 객체여서 strict schema 계약과 충돌 | 현재 도구 목록으로부터 닫힌 중첩 스키마 생성 | 모든 객체 깊이의 `required`, `additionalProperties` 검사 |
| CLI 오류가 가짜 `WAIT`가 되고 런타임이 한국어 문장을 정규식으로 판정 | `ModelGatewayError`와 `MODEL_FAILED`를 별도 계약으로 사용 | 성공한 list 이후 schema 거절, 사용량·원인·마지막 성공 구분 |
| 도구 이름만 있고 정확한 입력 형식이 없음 | `ToolCapability.inputSchema`를 실제 입력 검증과 공유 | 잘못된 필드, 필수 누락, null, 도구별 분기 검사 |
| 모델을 기다리는 동안 전역 상태 잠금 보유 | 짧은 예약/검증/커밋과 실행 lease 분리 | 대기 중 Pause·사람 답변·다른 프로젝트 생성 |
| 사람이 질문에 답하면 모델이 답변 내용을 잃음 | `humanDecisionViews`에 해결된 질문의 실제 답변 보존 | 미루기 후 답변이 다음 컨텍스트에 존재 |
| 작업 중 사용자 변경을 이전 모델 결정이 덮어쓸 수 있음 | Intent·설정·World·Human 상태 fence와 취소 신호 | 이전 컨텍스트의 파일 쓰기 차단 |
| 승인 소비가 도구 실행 후 기록됨 | 정확한 Intent·도구·canonical params의 1회 승인 선소비 | 실제 파일 삭제, 소비 이벤트 한 번 |
| 같은 list/read가 계속 진전으로 계산됨 | 새 관찰 내용과 이전 내용의 차이를 비교 | 반복 관찰에서 no-progress 중단 |
| 초기 폴더가 Git 저장소가 아니면 Git 장애로 표시 | `.git` 없는 작업 폴더는 `absent`, 미설정 서비스는 `not-configured` | 기존 도구/프로비저닝 테스트 및 acceptance |
| STALLED UI가 마지막 정상 작업을 “지금 하는 일”로 표시 | 현재 오류·retry·rawRef와 마지막 정상 작업을 분리 | 진단 projection 테스트 |
| API 실패에도 프런트가 성공처럼 로컬 state 전이 | API 모드는 서버 응답 후 반영, 동기화 오류 노출 | 단조 revision·선택 프로젝트 유지 검사 |
| 루프 종료 후 오래된 응답이 최신 상태를 덮어씀 | `AppState.revision`과 hydrate 순서 검사 | 역순 응답 회귀 검사 |
| 임의 추천 모델 목록이 실제 지원처럼 보임 | 기본 목록은 entitlement가 아님을 표시하고, 서버 설정 목록은 명시적으로 override | API 모델 목록 fixture |
| 실험 C/E가 실행 전에 거절됨 | A–E를 실제 ContextPacket 정보 범위로 분리하고, policy candidate가 없으면 빈 후보로 보존 | 실험 acceptance |
| 관측 기반 점수를 가설 입증으로 표시 | instrumentation proxy로 명시, H1–H6 자동 PASS 금지 | evidence 없는/독립 검증 없는 가설은 미입증 |

`production` 실행기가 없는 상태에서 도구 이름만 공개하지 않는다. `deploy.production`은 비활성화되어 있다. 복잡한 시스템을 새로 꾸미기보다는 기존의 실제 실행 경로를 고쳤다.

## 2. 모델 프로토콜

도구와 개발 순서는 모델이 선택한다. 계약은 행동의 모양과 권한을 정의할 뿐 개발 workflow를 지정하지 않는다.

```text
Intent + 현재 관찰 + 관련 경험 + 사람 답변 + 도구 입력 스키마 + 경계
  → ModelGateway.decide(context, { signal })
      → 성공: ActionEnvelope
      → 실패: ModelGatewayError { code, retryable, rawRef, usage }
```

CLI 및 strict API의 전송 형식은 루트가 객체인 `{ "action": <ActionEnvelope> }`이다. `action` 내부는 ACT 도구별 분기와 QUESTION/IDEA/CONCERN/WAIT 분기로 나뉜다. 모든 객체는 닫혀 있고, 선택 필드는 전송 시 nullable이다. 수신 후 **스키마에서 선택으로 선언한 null만** 제거한다. 파일 내용이나 코드 문자열을 의미에 따라 고치지 않는다. 기존 직접 ActionEnvelope fixture도 수신 호환을 유지한다.

CLI는 `codex exec --json --ephemeral --sandbox read-only --output-schema ... -`로 임시 작업 디렉터리에서 호출한다. 단일 stdin은 입력 경로 단순화 및 긴 Windows 인자 방지를 위한 선택이다. **프롬프트 인자와 stdin의 병용 자체가 Codex에서 금지된 것은 아니다.**

읽기 전용·기능 옵션·프롬프트만으로 모든 사용자 설정의 외부 도구를 완전히 차단했다고 주장하지 않는다. 명령 실행·파일 수정·MCP·검색 이벤트가 출력되면 프로토콜 위반으로 거절하지만, 사후 감지는 이미 발생한 외부 효과를 취소하지 못한다. 기존 Codex 설정에 외부 MCP/hook 등이 있다면 별도로 감사한 전용 설정/실행 환경에서 시험해야 한다. 특히 `mcp_servers={}`가 모든 버전의 병합 설정을 삭제한다는 보장은 검증하지 않았다.

## 3. 지속 실행과 제어권

```text
짧은 트랜잭션: 프로젝트별 execution lease 확보
  → unlock
  → 현재 World 관찰 / 컨텍스트 / 모델 호출
  → 짧은 트랜잭션: 최신 상태 fence + 권한 + 실행 가능 예산 검사
  → 승인 필요 시 정확한 1회 grant를 먼저 소비
  → unlock
  → 실제 도구 실행
  → 짧은 트랜잭션: 결과·사용량 병합, 실행권 해제
```

모델 호출 동안 다른 프로젝트 변경과 사람 답변은 저장할 수 있다. 변경된 Intent·답변·일시 정지·종료는 진행 중 결정을 무효화한다. 협조 가능한 CLI/명령에는 AbortSignal과 프로세스 트리 종료를 전달한다. 이미 완료된 외부 작업은 “없었던 일”로 만들지 않고 증거로 보존한다. 오래된 결과는 최신 사용자 상태를 덮어쓰지 않는다.

단일 실행 lease가 만료되었고 외부 변경을 시작한 흔적이 있으면 결과 불명 상태로 중단한다. **동일 외부 효과를 자동 재실행하지 않는다.** 이 구현은 분산 트랜잭션이나 모든 외부 작업의 exactly-once를 보장하지 않는다.

정상 ACT 이후에는 ACTIVE를 유지한다. 모델이 실제 WAIT를 내린 경우에만 현재 대기/균형 상태를 판정한다. 연결 오류는 WAIT가 아니다. 복구 가능한 provider 오류는 backoff 후 재시도하며 schema/auth와 같은 비복구 오류는 조치가 필요한 중단으로 표시한다. 사람이 재개하면 실패 카운터·backoff를 초기화하되 이미 사용한 비용과 기록은 지우지 않는다.

`maxModelCalls` 기본 상한은 run당 200이다. CLI 비용 단가가 미설정이어도 호출 수와 최대 시간으로 제한한다. 이미 끝난 호출의 비용/사용량은 반영하며, 표시 금액은 설정한 단가와 도구 가중치 기반 **추정치**이지 청구서가 아니다. 호출 한 번의 사전 최악 비용 보장까지 구현한 것은 아니다.

`POST /projects/:id/run` 및 `/wake`는 202로 큐 등록을 반환한다. API 응답이 모델 완료를 기다리지 않는다. API와 worker를 모두 실행해야 실제 작업이 시작된다. Tauri는 두 sidecar를 실행한다.

## 4. 증거와 평가

`workspace.write PASS`는 파일 쓰기 성공이다. `browser PASS`는 실제 브라우저 관찰 또는 지정한 visible text 단언 성공이다. **제품 목표, UX 품질, 보안 또는 모델의 rationale 전체를 검증했다는 뜻이 아니다.** 브라우저 엔진 미설치는 HTTP fallback/UNCERTAIN으로, 실제 navigation/assertion 오류는 FAIL로 구분한다.

프로젝트의 기존 평가 지표는 관측된 이벤트·증거로 계산한 proxy다. 별도의 독립 제품 평가자를 대체하지 않는다. A는 1회 모델 호출 대조군이며 Codex/Cursor 전체 제품과의 공정 비교군이 아니다. C의 discovery 제어와 E의 evidence-gated policy-candidate context는 격리 실행할 수 있다. 다만 policy candidate가 실제 독립 평가로 발급되지 않은 상태에서는 E가 후보를 만들어 내지 않으며, `scoreExperiment`도 이를 가설 PASS로 승격하지 않는다. `Intent Energy`, `Closure`, `Discovery`는 연구 프레임이며 물리적인 에너지나 검증된 일반 지능 수식이 아니다. H1–H6와 Dream-RSI 효과는 미입증이다.

## 5. 보안 및 운영 제한

- `process` 모드는 **호스트 실행이며 보안 sandbox가 아니다.** `node file.js`, npm test/start 안의 코드는 호스트 사용자 권한으로 동작한다. argv 허용 목록은 이를 바꾸지 않는다. 비밀·운영 자격 증명·중요 파일이 없는 전용 계정/VM에서만 시험한다.
- Docker는 자원·프로세스·파일 시스템 위험을 줄이지만 완전한 보안 검증이 끝난 것은 아니다. 특히 dependency 설치의 bridge 네트워크는 host allowlist를 OS 수준으로 강제하지 않는다. 프록시/네트워크 격리를 추가하기 전에는 완전한 egress 차단이라고 표현하지 않는다.
- API 기본 바인딩은 `127.0.0.1`이다. Origin/Host를 검사하고 외부 바인딩은 `SAKASAKA_API_TOKEN`을 요구한다. 현재 UI는 외부 bearer 인증 클라이언트가 아니므로 기본은 로컬 전용이다. 다중 사용자·TLS·권한 관리 SaaS는 아니다.
- 같은 호스트의 임의 프로그램까지 신뢰 경계 밖으로 격리한 것은 아니다. raw 출력에는 redaction이 있지만 완전한 비밀 탐지 보장은 없다. 로그나 상태 파일을 공개 저장소에 올리지 않는다.
- JSON snapshot이 현재 상태의 기준이고 journal은 감사/재구성 보조 기록이다. 여러 파일의 완전한 원자적 커밋은 아니다. 운영 시스템은 DB 트랜잭션·outbox 등 별도 설계가 필요하다.
- 모든 Windows/macOS/Linux의 실제 설치형 sidecar/Codex 실행을 확인한 것은 아니다. npm Windows launcher와 프로세스 종료 코드를 보강했지만 OS별 실제 회귀 검증은 별도 필요하다.
- 메모리 검색은 lexical/metadata/hash vector와 선택적 외부 embedding이다. 외부 embedding 경로는 batch 상한 65개를 넘으면 fallback한다. 대규모 인덱스의 캐시·배치·compaction은 후속 작업이다.

## 6. 재실험 순서

1. 새 코드의 CI 상태를 확인하고 테스트용 작업 폴더를 준비한다. 기존 사용자 데이터는 삭제하지 않는다.
2. `npm run smoke:codex`로 실행 파일과 로그인 상태를 확인한다. 이 단계는 모델 응답 검증이 아니다.
3. `npm run smoke:codex -- --run`으로 한 번의 실제 CLI 구조화 응답을 검사한다. 모델 사용량이 발생할 수 있다. 반환된 결정은 검사만 하고 SakaSaka 도구로 실행하지 않는다.
4. 이것이 통과한 뒤 30분/모델 호출 30회 정도의 작은 새 Intent를 시험한다. 테스트 도중 개발 순서를 지시하지 않는다. 질문 탭의 답변·중단 버튼만 사용한다.
5. 실패하면 실행 ID, CLI 버전, 오류 code, 사용 모델 ID, 마지막 rawRef와 해당 컨텍스트를 비밀 제거 후 보존한다. 공급자 장애와 행동 선택 실패를 나누어 분석한다.

실제 CLI 인증/사용자의 실행 로그가 없는 환경에서 모의 게이트웨이 테스트를 실제 모델의 주도성 성공으로 세지 않는다.

## 7. 공식 문서 조사 근거

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs): 닫힌 중첩 객체, required/nullable, 루트 객체와 중첩 anyOf 제약.
- [Codex 비대화형 실행](https://developers.openai.com/codex/noninteractive/): exec/JSONL/output-schema/stdin/ephemeral의 실제 실행 계약.
- [Codex 설정](https://developers.openai.com/codex/config-reference/): 셸 기능, MCP 서버 및 웹 검색 설정. 설정 병합과 실제 권한은 로컬 설치에서 확인해야 한다.
- [Node child_process](https://nodejs.org/api/child_process.html): execFile/spawn/AbortSignal 및 Windows `.cmd` 실행 차이.

이 자료는 인터페이스 제약의 근거다. 소프트웨어 조직 전체 대체나 H1–H6의 입증 자료로 인용하지 않는다.
