/** Small browser-safe boundary for capabilities supplied by the Tauri shell. */
export const isDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function pickDirectory(): Promise<string | null> {
  if (!isDesktopApp) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: "프로젝트 작업 폴더 선택" });
  return typeof selected === "string" ? selected : null;
}
