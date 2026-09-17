import { stdin, stdout } from "node:process";
import { configuredTypeSafeApiKey, runtimeDecisionPublicConfig, updateRuntimeDecisionConfig, type RuntimeDecisionProvider } from "../server/runtimeDecisionConfig";

const args = process.argv.slice(2);
const valueAfter = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(name);

function providerFrom(value: string | undefined): RuntimeDecisionProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "codex-cli" || normalized === "jev" || normalized === "hybrid" ? normalized : undefined;
}

async function promptLine(label: string, fallback?: string): Promise<string> {
  stdout.write(`${label}${fallback ? ` [${fallback}]` : ""}: `);
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.search(/[\r\n]/);
      if (newline < 0) return;
      stdin.off("data", onData);
      resolve(buffer.slice(0, newline).trim() || fallback || "");
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return promptLine(label);
  stdout.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let value = "";
    const restore = () => {
      stdin.off("data", onData);
      try { stdin.setRawMode(false); } catch { /* already restored */ }
      stdin.pause();
    };
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          restore();
          stdout.write("\n");
          reject(new Error("setup cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          restore();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const current = runtimeDecisionPublicConfig();
  const providerArg = valueAfter("--provider");
  if (providerArg && !providerFrom(providerArg)) throw new Error("--provider must be codex-cli, jev, or hybrid");
  const provider = providerFrom(providerArg) ?? providerFrom(await promptLine("Decision provider (codex-cli / jev / hybrid)", current.provider));
  if (!provider) throw new Error("decision provider is required");

  const modelArg = valueAfter("--model");
  const model = modelArg ?? (provider === "codex-cli" ? current.typesafeModel : await promptLine("TypeSafe model", current.typesafeModel));
  let apiKey: string | undefined;
  let clearApiKey = has("--clear-key");

  if (provider !== "codex-cli" && !clearApiKey && !configuredTypeSafeApiKey()) {
    apiKey = process.env.TYPESAFE_API_KEY?.trim() || await promptSecret("TypeSafe API key (input is hidden)");
    if (!apiKey) throw new Error("TypeSafe API key is required for Jev");
  } else if (provider !== "codex-cli" && has("--replace-key")) {
    apiKey = await promptSecret("New TypeSafe API key (input is hidden)");
    if (!apiKey) throw new Error("replacement key cannot be empty");
  }

  if (provider === "codex-cli" && has("--clear-key")) clearApiKey = true;
  const status = await updateRuntimeDecisionConfig({ provider, typesafeModel: model, apiKey, clearApiKey });
  stdout.write(`Saved local decision settings.\nProvider: ${status.provider}\nJev model: ${status.typesafeModel}\nAPI key: ${status.apiKeyConfigured ? `configured (${status.apiKeySource})` : "not configured"}\nConfig: ${status.configPath}\n`);
  if (status.apiKeySource === "environment") stdout.write("Note: TYPESAFE_API_KEY from the environment overrides the local stored key.\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
