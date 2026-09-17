import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServer, nativeCliEnvironment, nativeCodexHome } from "./codexAppServer";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function client(extra = "", maxLineBytes?: number) {
  const cwd = mkdtempSync(join(tmpdir(), "saka-rpc-")); roots.push(cwd);
  const script = join(cwd, "server.mjs");
  writeFileSync(script, `import readline from 'node:readline';
const send = v => process.stdout.write(JSON.stringify(v)+'\\n');
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='ping'){const data=Buffer.from(JSON.stringify({id:m.id,result:'한글 응답 🐈'})+'\\n');for(const byte of data)process.stdout.write(Buffer.from([byte]));}
 else if(m.method==='duplex'){send({id:'server-call',method:'human/request',params:{}});send({id:m.id,result:'duplex-ok'});}
 else if(m.method==='nested')send({id:m.id,result:'nested-ok'});
 ${extra}
});`);
  return new CodexAppServer({ binary: process.execPath, prefix: [script], cwd, requestTimeoutMs: 1000, maxLineBytes });
}
describe("Codex App Server stdio", () => {
  it("uses a SakaSaka-owned Codex home instead of silently inheriting the global home", () => {
    expect(nativeCodexHome({ SAKASAKA_CODEX_HOME: String.raw`C:\SakaSaka\codex-native` }, "win32", String.raw`C:\Users\tester`)).toBe(String.raw`C:\SakaSaka\codex-native`);
    const environment = nativeCliEnvironment();
    expect(environment.SAKASAKA_CODEX_HOME).toBe(environment.CODEX_HOME);
    expect(environment.CODEX_HOME).toContain("codex-native");
  });

  it("분할된 UTF-8 JSONL과 양방향 요청을 교착 없이 처리한다", async () => {
    const c = client(); let nested = "";
    c.onRequest(async () => { nested = String(await c.request("nested", {})); return {}; });
    try {
      await c.start(); expect(await c.request("ping", {})).toBe("한글 응답 🐈");
      expect(await c.request("duplex", {})).toBe("duplex-ok");
      const deadline = Date.now() + 1000; while (!nested && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(nested).toBe("nested-ok");
    } finally { await c.close(); }
  });
  it("잘못된 JSON을 성공 응답으로 만들지 않는다", async () => {
    const c = client(`else if(m.method==='bad')process.stdout.write('not-json\\n');`);
    await c.start(); await expect(c.request("bad", {})).rejects.toThrow("JSON-RPC"); await c.close();
  });
  it("출력 상한과 연결 종료가 대기 요청을 실제로 거절한다", async () => {
    const c = client(`else if(m.method==='large')send({id:m.id,result:'x'.repeat(10000)});`, 1000);
    await c.start(); await expect(c.request("large", {})).rejects.toThrow("크기"); await c.close();
    const d = client(); await d.start(); const pending = d.request("never", {}).catch((e: Error) => e.message);
    await d.close(); expect(await pending).toMatch(/종료|닫/);
  });
});
