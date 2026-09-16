import type { ActionEnvelope, ActionParamValue, ContextPacket, ToolCapability } from "./types";

/** Small, audited JSON Schema subset shared by model descriptions and validation. */
export interface InputSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, InputSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: InputSchema;
  anyOf?: InputSchema[];
  enum?: Array<string | number | boolean | null>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  minItems?: number;
}

const text = (description: string, maxLength = 2_000): InputSchema => ({ type: "string", description, maxLength });
const count = (description: string, minimum: number, maximum: number): InputSchema => ({ type: "integer", description, minimum, maximum });
const strings = (description: string, maxItems = 64): InputSchema => ({ type: "array", description, items: text("값"), maxItems });
const object = (properties: Record<string, InputSchema>, required: string[] = []): InputSchema => ({ type: "object", properties, required, additionalProperties: false });
const path = text("작업 폴더 내부의 상대 경로. 절대 경로와 상위 폴더(..)는 허용하지 않습니다.");
const argv = { ...strings("실행 파일과 인자 배열. 셸 명령 문자열이 아닙니다."), minItems: 1 };

/** These are capability contracts, not a prescribed order of development. */
export const toolInputSchemas: Readonly<Record<string, InputSchema>> = {
  "repo.read": object({ commandId: { type: "string", enum: ["repo-status", "repo-diff", "repo-diff-check"], description: "조회할 Git 명령 ID" } }, ["commandId"]),
  "workspace.list": object({ depth: count("하위 폴더 깊이", 0, 8), maxEntries: count("최대 항목 수", 1, 1_000) }),
  "workspace.read": object({ path, lineStart: count("시작 행(1부터)", 1, 1_000_000), lineEnd: count("마지막 행(포함)", 1, 1_000_000) }, ["path"]),
  "workspace.write": object({ path, content: text("저장할 전체 UTF-8 소스. 비밀 값은 넣지 않습니다.", 256_000), overwrite: { type: "boolean", description: "기존 파일을 덮어쓸 때만 true" } }, ["path", "content"]),
  "workspace.patch": object({ patch: text("--- a/path, +++ b/path, @@ 행 범위를 갖는 unified diff", 256_000) }, ["patch"]),
  "workspace.delete": object({ path, recursive: { type: "boolean", description: "디렉터리 재귀 삭제 여부. 별도 승인 대상입니다." } }, ["path"]),
  "dependency.install": object({ packages: { ...strings("설치할 npm 패키지 이름(선택적 @버전)", 64), minItems: 1 }, packageManager: { type: "string", enum: ["npm", "pnpm", "yarn"] } }, ["packages"]),
  "shell.sandbox": object({ commandId: { type: "string", enum: ["repo-status", "repo-diff", "repo-diff-check", "quality-test", "quality-build", "quality-build-api"] }, argv }, []),
  "browser.playwright": object({ url: text("허용된 HTTP(S) 미리보기 주소"), viewportWidth: count("뷰포트 너비", 320, 4_000), viewportHeight: count("뷰포트 높이", 240, 4_000), clickText: text("클릭할 버튼의 접근성 이름", 256), expectedText: text("클릭 이후 본문에 있어야 하는 문자열(실제 단언)", 2_000) }, ["url"]),
  "process.start": object({ argv, port: count("미리보기 포트(PORT 환경변수로 전달)", 1, 65_535) }, ["argv"]),
  "process.status": object({ processId: text("activeProcessViews에서 받은 실행 ID", 256) }, ["processId"]),
  "process.stop": object({ processId: text("activeProcessViews에서 받은 실행 ID", 256) }, ["processId"]),
  "database.read": object({ operation: { type: "string", enum: ["health"] } }),
};

export const humanInputSchema = object({
  scope: text("사람 판단이 필요한 범위", 256),
  blockingScope: strings("답변 전 변경해서는 안 되는 범위", 16),
  continuingScope: strings("현재 독립적으로 계속할 수 있는 범위. 없으면 빈 배열", 16),
  options: strings("사람에게 제공할 선택지. 없으면 자유 답변", 16),
  responseMode: { type: "string", enum: ["choice", "free-text", "choice-and-text"] },
});

export function withInputSchemas(capabilities: ToolCapability[]): ToolCapability[] {
  return capabilities.map((capability) => ({
    ...capability,
    inputSchema: toolInputSchemas[capability.name],
    // Never advertise an unimplemented executor (e.g. deploy.production).
    enabled: capability.enabled && Boolean(toolInputSchemas[capability.name]),
  }));
}

function validate(schema: InputSchema, value: unknown, where = "params"): string | undefined {
  if (schema.anyOf) return schema.anyOf.some((branch) => !validate(branch, value, where)) ? undefined : `${where}: 허용된 형식이 아닙니다.`;
  if (schema.enum && !schema.enum.includes(value as string)) return `${where}: ${schema.enum.join(", ")} 중 하나여야 합니다.`;
  if (schema.type === "null") return value === null ? undefined : `${where}: null이어야 합니다.`;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${where}: 객체여야 합니다.`;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) return `${where}.${key}: 필수 값이 없습니다.`;
    for (const [key, item] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) return `${where}.${key}: 알 수 없는 입력입니다.`;
      const error = validate(properties[key], item, `${where}.${key}`);
      if (error) return error;
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 128) || value.length < (schema.minItems ?? 0)) return `${where}: 배열 길이가 허용 범위를 벗어났습니다.`;
    for (let i = 0; i < value.length; i++) {
      const error = validate(schema.items!, value[i], `${where}[${i}]`);
      if (error) return error;
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length > (schema.maxLength ?? 256_000) || value.length < (schema.minLength ?? 0)) return `${where}: 문자열 길이 또는 형식이 올바르지 않습니다.`;
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return `${where}: 숫자가 허용 범위를 벗어났습니다.`;
  } else if (schema.type === "boolean" && typeof value !== "boolean") return `${where}: boolean이어야 합니다.`;
  return undefined;
}

export function validateActionInput(action: ActionEnvelope): string | undefined {
  if (action.type === "ACT") {
    const schema = action.tool ? toolInputSchemas[action.tool] : undefined;
    if (!schema) return `구현되지 않은 도구입니다: ${action.tool ?? "없음"}`;
    const error = validate(schema, action.params ?? {});
    if (error) return error;
    if (action.tool === "shell.sandbox" && Number(action.params?.commandId !== undefined) + Number(action.params?.argv !== undefined) !== 1) return "params: commandId 또는 argv 중 정확히 하나를 사용하십시오.";
    if (action.tool === "workspace.read" && typeof action.params?.lineStart === "number" && typeof action.params?.lineEnd === "number" && action.params.lineEnd < action.params.lineStart) return "params.lineEnd: 시작 행보다 작습니다.";
    return undefined;
  }
  return action.type === "WAIT" ? validate(object({}), action.params ?? {}) : validate(humanInputSchema, action.params ?? {});
}

/** Strict outputs require every object property, with null for optional values. */
export function strictInputSchema(schema: InputSchema): InputSchema {
  if (schema.type === "object") {
    const required = new Set(schema.required ?? []);
    const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key,
      required.has(key) ? strictInputSchema(child) : { anyOf: [strictInputSchema(child), { type: "null" as const }] },
    ]));
    return { ...schema, properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (schema.type === "array") return { ...schema, items: strictInputSchema(schema.items!) };
  if (schema.anyOf) return { ...schema, anyOf: schema.anyOf.map(strictInputSchema) };
  return { ...schema };
}

/** Root stays an object; the nested union binds the action type to tool+params. */
export function createDecisionSchema(context: ContextPacket): InputSchema {
  const common = {
    intentRef: { type: "string" as const, enum: [context.intentRef] },
    worldCursor: { type: "string" as const, enum: [context.worldCursor] },
    rationaleSummary: { ...text("현재 근거와 다음 행동의 짧은 이유", 4_000), minLength: 1 },
    expectedValue: { anyOf: [{ type: "number" as const, minimum: 0, maximum: 1 }, { type: "null" as const }] },
    riskClass: { anyOf: [{ type: "string" as const, enum: ["P0", "P1", "P2", "P3"] }, { type: "null" as const }] },
    evidencePlan: { anyOf: [strings("확인할 증거", 32), { type: "null" as const }] },
  };
  const branch = (type: ActionEnvelope["type"], tool: InputSchema, params: InputSchema) => {
    const properties = { type: { type: "string" as const, enum: [type] }, ...common, tool, params };
    return object(properties, Object.keys(properties));
  };
  const choices = context.toolSurface.filter((cap) => cap.enabled && toolInputSchemas[cap.name]).map((cap) =>
    branch("ACT", { type: "string", enum: [cap.name] }, strictInputSchema(toolInputSchemas[cap.name])),
  );
  for (const type of ["QUESTION", "IDEA", "CONCERN"] as const) choices.push(branch(type, { type: "null" }, strictInputSchema(humanInputSchema)));
  choices.push(branch("WAIT", { type: "null" }, { type: "null" }));
  return object({ action: { anyOf: choices } }, ["action"]);
}

/** Remove only schema-declared optional nulls; do not rewrite code/string data. */
export function unwrapDecision(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const envelope = "action" in root ? (Object.keys(root).length === 1 ? root.action : undefined) : root;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return envelope;
  const result = { ...envelope } as Record<string, unknown>;
  if (result.params && typeof result.params === "object" && !Array.isArray(result.params)) {
    const params = result.params as Record<string, unknown>;
    const schema = result.type === "ACT" ? toolInputSchemas[String(result.tool)] : humanInputSchema;
    const required = new Set(schema?.required ?? []);
    result.params = Object.fromEntries(Object.entries(params).filter(([key, val]) => val !== null || required.has(key) || !Object.prototype.hasOwnProperty.call(schema?.properties ?? {}, key))) as Record<string, ActionParamValue>;
  }
  return result;
}
