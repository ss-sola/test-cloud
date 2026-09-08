import { describe, expect, it } from 'vitest';
import { ReleaseAutomationJobService } from '../modules/release-automation/release-automation-job.service';
import type { ReleaseJobRecord } from '../modules/release-automation/release-automation.types';
import type { ReleaseQueueGateway } from '../modules/release-automation/release-automation-queue.service';

class FakeQueue implements ReleaseQueueGateway {
  readonly records = new Map<string, ReleaseJobRecord>();

  async add(record: ReleaseJobRecord): Promise<void> {
    this.records.set(record.jobId, record);
  }

  async get(jobId: string): Promise<ReleaseJobRecord | null> {
    return this.records.get(jobId) ?? null;
  }

  async getActiveCount(): Promise<number> {
    return 0;
  }
}

describe('release automation job idempotency', () => {
  it('returns the same job for the same key and rejects a different payload', async () => {
    const queue = new FakeQueue();
    const service = new ReleaseAutomationJobService(queue);
    const first = {
      idempotencyKey: 'release-test-001',
      plan: {
        repository: 'acme/project',
        targetBranch: 'custom/prod',
        candidateSha: 'a'.repeat(40),
        version: '1.9.0' as const,
        mode: 'dry-run' as const,
      },
    };

    const created = await service.create(first);
    const repeated = await service.create(first);
    expect(repeated).toMatchObject({ jobId: created.jobId, idempotent: true });
    expect(queue.records.size).toBe(1);

    await expect(
      service.create({
        ...first,
        plan: { ...first.plan, candidateSha: 'b'.repeat(40) },
      }),
    ).rejects.toThrow('payload 不一致');
  });
});
