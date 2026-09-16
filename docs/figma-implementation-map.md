# FigJam/Figma 요구사항 → 실제 구현 추적

기준: Master Architecture & Implementation Spec v0.1과 Product UI Spec의 실제 텍스트/구조를 2026-09-17 다시 읽었다. 원문 설계를 코드에 맞춰 해석한 척하지 않는다. 원래 요구, 의도적으로 바꾼 설계 결정, 검증되지 않은 연구 가설을 구분한다.

## 1. 원문 근거와 대응

| 원본 섹션 / 실제 노드 | 원래 요구 | 이 변경의 실제 코드 / 검사 |
|---|---|---|
| [00 Thesis](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=1-6) | 인간은 의도·가치·경계, AI는 필요한 일을 스스로 발견. 고정 직무/워크플로우 금지 | `nativeRuntime.missionInstructions`, Codex native thread/turn. 고정 구현 순서 없음. 모의 응답은 tests/scripts fixture에만 존재 |
| [02 Closed loop](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=1-65) | 실제 World를 보고 행동하고 결과를 다시 관찰 | App Server native 도구 루프 + `recordNativeItem`, 원본 도구 출력 fallback + 구간 전후 실제 World adapter 관찰 |
| [03 World](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=2-58) | repo/app/browser/log/human. 요약은 원본 증거 참조를 가진 뷰 | `nativeEvidence`, `localAdapters`, `local-raw` JSONL. 실행 성공과 제품 검증은 별개 |
| [05 Human Boundary](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=2-139) | 질문은 비동기. 영향 범위만 보류. 나중에 언제든 답하고 독립 작업 계속 | `registerMissionHuman`, `missionInbox`, `humanSignals`, `turn/steer`, `thread/resume`. 미응답은 null. key는 Intent 범위에서 중복 방지. 실행 중 도구 RPC는 접수만 반환 |
| [06 Memory](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=3-113) | 상황→행동→결과→증거. 관련 경험 검색, 원본 보존 | 기존 memory retrieval을 native context에 연결. native 실행에 source-linked Evidence/Experience 생성. 대규모 통합/일반화는 아직 검증 안 됨 |
| [07 RSI](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=3-166) | 본체와 분리된 선택적 offline 개선층 | 이번 PR은 RSI를 구현했다거나 효과를 입증했다고 주장하지 않음 |
| [08 Governor](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=3-223) | 자원/권한/정지 경계이지 개발 순서 지시기 아님 | 토큰/시간/구간 상한, 실행 lease, Pause/Kill interrupt, 실제 checkpoint 후 신호 기반 wake. 오류 하나는 native tool 피드백으로 복구 |
| [11 Security](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=4-341) | sandbox, 네트워크, 비밀, 승인의 실제 강제 | native workspace-write, native network false, 권한 확대 거절. 외부 패키지 승인과 환경 도구는 별도. 완전한 VM/egress 격리라고 주장하지 않음 |
| [15 DoD](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=6-428) | 의도 하나 이후 실제 생성·실행·검증, 질문/답변 후 계속 | `acceptance:native`: 실제 Codex binary + 모의 모델 + 실제 파일/실패/복구/브라우저/동일 thread 유지보수. 실제 모델 제품 성공은 별도 |
| [16 Acceptance A–H](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=6-432) | greenfield, 숨은 일, 비동기 질문, wake, 유지보수, 경험, 경계, 모델 교체 | A/C/D/E/G의 실행 기반에 검사 추가. B(자발성), F(기억의 실효 향상), H(모델 교체 후 동등 능력), 실제 모델 제품 품질은 미입증 |
| [19–20 계약/검증](https://www.figma.com/board/smeJcbKNnEGF0vw9m3Tgpw?node-id=7-532) | API/SSE/버전/실행 검증과 연구 검증 구분 | 기존 API/worker/SSE 유지. `/projects/:id/execution`, native/atomic 명시 전환. 기존 CI와 새로운 실제 Codex integration을 함께 실행 |

## 2. 제품 UI 근거

[Product UI](https://www.figma.com/design/G0SUfgcTbQpOSUpj6AncUT?node-id=0-1)의 기존 React Card/Pill/Button, 라우트, 원문 Intent, Activity/World/Needs You 구조를 보존한다. 새 실행 방식·한도·실제 thread/checkpoint 정보는 기존 카드 스타일로 추가했다. 새 디자인 시스템을 만들거나 전체 화면을 교체하지 않았다.

- `3:29` Intent Start: 작업 목록보다 원하는 결과가 시작점. 실제 OS 작업 폴더와 실행 권한은 명시 선택한다.
- `3:183` Needs You / `5:29` Question Detail: 질문·아이디어·우려·승인 분리, 미루기 후 재답변. Native 질문도 동일 HumanItem/UI 경로를 사용한다.
- `5:104` Activity / World: 도구 ID와 출처는 디버깅 정보이지 사람이 맞춰야 할 개발 과제가 아니다.
- `5:188` Equilibrium: 대기 후 새 신호에서 지속 thread를 재개한다. “에이전트가 쉬기로 함”과 “제품이 독립 검증됨”을 구분한다.
- `7:41` Route & Component Contract: 서버 상태가 실제 실행 기준. 브라우저 전용 모드는 Codex나 OS 실행을 가장하지 않는다.

디자인의 여행 앱 이름, 질문 번호, 42/42 등의 문구는 화면 예시이다. production seed/점수/행동 순서로 사용하지 않는다.

## 3. 의도적으로 변경한 아키텍처 결정 (ADR)

원문 17/19의 `ModelGateway → ActionEnvelope 한 개 → SakaSaka ToolGateway`는 실제로 설계에 존재했다. 이번 PR은 그 내용을 없던 것으로 취급하지 않고 **Codex native 경로에 한해서 대체**한다. 기존 atomic 엔진은 이전 데이터와 API 제공자/연구 비교를 위해 유지한다.

이유: 매 파일/프로세스마다 추론과 실행을 나눠 재구현하면서, AI 내부에서 복구할 수 있는 오류가 사람의 작업으로 넘어갔다. 제품 목표는 원자적 JSON 명령 처리기가 아니라 프로젝트를 맡는 환경이다. Native 경로는 Codex의 도구 루프와 thread history를 사용하고 SakaSaka는 인간 통로·실제 증거·자원·제어를 유지한다.

새 단위는 `episode`(여러 native 행동을 포함하는 한 turn)이다. 최종 `checkpoint`는 제품 상태 보고이다. 실행 순서가 아니다. `continue → ACTIVE`, 실제 독립 작업이 없는 질문 대기 `→ WAITING`, 현재 남은 일이 없다고 보고 `→ EQUILIBRIUM`. 체크포인트만으로 UX/보안/요구사항 완성을 증명하지 않는다.

## 4. 외부 연구/문서와 우리의 가설을 분리

OpenAI 공식 [App Server](https://developers.openai.com/codex/app-server), [security](https://developers.openai.com/codex/security), [config reference](https://developers.openai.com/codex/config-reference)를 참고했다. 실제 실행 계약은 **공개 Codex CLI 0.154.0 바이너리의 `app-server generate-json-schema --experimental`**로 확인했다. `dynamicTools`는 실험적이다. 설치 버전이 다르면 `smoke:native`로 검증한다.

확인한 계약: `initialize`의 experimentalApi, function 타입 dynamicTools, thread/start/resume, turn/start/steer/interrupt, item/tool/call, 비동기 notification, 누적 tokenUsage, workspaceWrite sandboxPolicy. 실제 0.154.0은 일부 실패한 exec의 commandExecution notification을 생략하고 raw function_call_output만 전달하므로 해당 원문을 UNCERTAIN으로 보존한다. 없는 구조화 exitCode를 만들지 않는다. 숨겨진 reasoning/encrypted 내용은 기록하지 않는다.

이 기술이 “모든 직무 대체”, “Intent Energy 최적화가 일반 지능을 만듦”, “모델이 이미 모든 전문가보다 우수함”, “경험이 항상 성능을 높임”을 입증하지 않는다. 가설 H1–H6를 평가하려면 실제 모델·동등 조건 대조군·독립 제품 평가와 반복 실행이 별도로 필요하다.
