import { resolve } from "node:path";
import { readJsonWithBackup, writeJsonAtomically } from "./atomicFile";
import { withFileLock } from "./fileLock";
import type { AutonomyDatabase, AutonomyProjectState } from "./autonomyDomain";

function emptyDatabase(): AutonomyDatabase {
  return { schemaVersion: 1, projects: {} };
}

function validDatabase(value: unknown): value is AutonomyDatabase {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AutonomyDatabase>;
  return record.schemaVersion === 1 && Boolean(record.projects) && typeof record.projects === "object" && !Array.isArray(record.projects);
}

export class FileAutonomyStore {
  readonly filePath: string;
  readonly lockPath: string;

  constructor(filePath = resolve(process.cwd(), process.env.INTENT_WORLD_AUTONOMY_FILE ?? ".data/autonomy.json")) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  readDatabase(): AutonomyDatabase {
    return readJsonWithBackup<AutonomyDatabase>(this.filePath, validDatabase) ?? emptyDatabase();
  }

  readProject(projectId: string): AutonomyProjectState | undefined {
    return this.readDatabase().projects[projectId];
  }

  async putProject(project: AutonomyProjectState): Promise<AutonomyProjectState> {
    return withFileLock(this.lockPath, () => {
      const database = this.readDatabase();
      const next: AutonomyDatabase = { ...database, projects: { ...database.projects, [project.projectId]: project } };
      writeJsonAtomically(this.filePath, next, validDatabase);
      return project;
    });
  }

  async transactProject(projectId: string, update: (current: AutonomyProjectState | undefined) => AutonomyProjectState | undefined): Promise<AutonomyProjectState | undefined> {
    return withFileLock(this.lockPath, () => {
      const database = this.readDatabase();
      const nextProject = update(database.projects[projectId]);
      if (nextProject === database.projects[projectId]) return nextProject;
      const projects = { ...database.projects };
      if (nextProject) projects[projectId] = nextProject;
      else delete projects[projectId];
      writeJsonAtomically(this.filePath, { ...database, projects }, validDatabase);
      return nextProject;
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.transactProject(projectId, () => undefined);
  }
}

export const autonomyStore = new FileAutonomyStore();
