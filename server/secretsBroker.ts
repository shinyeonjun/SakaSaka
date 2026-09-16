import { makeId } from "../src/runtime";
import type { SecretsBroker } from "../src/ports";

interface SecretLease {
  leaseId: string;
  projectId: string;
  runId: string;
  names: string[];
  expiresAt: string;
}

/** Development broker: it proves scope/expiry behavior without exposing raw secret values. */
export class LocalSecretsBroker implements SecretsBroker {
  private readonly leases = new Map<string, SecretLease>();

  async issue(scope: { projectId: string; runId: string; names: string[]; ttlSeconds: number }): Promise<{ leaseId: string; expiresAt: string }> {
    const names = scope.names.filter((name) => /^[A-Z][A-Z0-9_]{1,127}$/.test(name));
    const expiresAt = new Date(Date.now() + Math.max(1, Math.min(scope.ttlSeconds, 900)) * 1000).toISOString();
    const lease = { leaseId: makeId("secret-lease"), projectId: scope.projectId, runId: scope.runId, names, expiresAt };
    this.leases.set(lease.leaseId, lease);
    return { leaseId: lease.leaseId, expiresAt };
  }

  async revoke(leaseId: string): Promise<void> {
    this.leases.delete(leaseId);
  }

  hasActiveLease(leaseId: string, projectId: string, runId: string): boolean {
    const lease = this.leases.get(leaseId);
    return Boolean(lease && lease.projectId === projectId && lease.runId === runId && Date.parse(lease.expiresAt) > Date.now());
  }
}
