import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const outputDirectory = resolve(root, "dist-desktop");
const binariesDirectory = resolve(root, "src-tauri", "binaries");
const esbuild = resolve(root, "node_modules", "esbuild", "bin", "esbuild");
const pkg = resolve(root, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");

function targetForCurrentPlatform(): { pkg: string; tauri: string; binarySuffix: string } {
  const platform = process.env.TAURI_ENV_PLATFORM || process.platform;
  const arch = process.env.TAURI_ENV_ARCH || process.arch;
  if (platform === "windows" || platform === "win32") return arch.includes("arm") ? { pkg: "node22-win-arm64", tauri: "aarch64-pc-windows-msvc", binarySuffix: ".exe" } : { pkg: "node22-win-x64", tauri: "x86_64-pc-windows-msvc", binarySuffix: ".exe" };
  if (platform === "darwin" || platform === "macos") return arch.includes("arm") ? { pkg: "node22-macos-arm64", tauri: "aarch64-apple-darwin", binarySuffix: "" } : { pkg: "node22-macos-x64", tauri: "x86_64-apple-darwin", binarySuffix: "" };
  if (platform === "linux") return arch.includes("arm") ? { pkg: "node22-linux-arm64", tauri: "aarch64-unknown-linux-gnu", binarySuffix: "" } : { pkg: "node22-linux-x64", tauri: "x86_64-unknown-linux-gnu", binarySuffix: "" };
  throw new Error(`지원하지 않는 데스크톱 플랫폼입니다: ${platform}/${arch}`);
}

async function run(executable: string, args: string[]): Promise<void> {
  await execFileAsync(executable, args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
}

async function main(): Promise<void> {
  const target = targetForCurrentPlatform();
  mkdirSync(binariesDirectory, { recursive: true });
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  const entries = [
    { source: "server/index.ts", output: "sakasaka-api.cjs", sidecar: "sakasaka-api" },
    { source: "server/desktopWorker.ts", output: "sakasaka-worker.cjs", sidecar: "sakasaka-worker" },
  ];
  for (const entry of entries) {
    const bundled = resolve(outputDirectory, entry.output);
    await run(process.execPath, [esbuild, entry.source, "--bundle", "--platform=node", "--format=cjs", "--target=node22", "--external:playwright", `--outfile=${bundled}`]);
    const sidecar = resolve(binariesDirectory, `${entry.sidecar}-${target.tauri}${target.binarySuffix}`);
    rmSync(sidecar, { force: true });
    await run(process.execPath, [pkg, "--config", resolve(root, "desktop.pkg.json"), `--targets=${target.pkg}`, "--output", sidecar, bundled]);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
