import { BaseService } from '../../base/base.service';
import { BaseEntity } from '../../base/base.entity';
import { PageCommon } from '../../page/page.vo';
import { Repository } from 'typeorm';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('BaseService', () => {
  class TestEntity extends BaseEntity {}

  class TestService extends BaseService<TestEntity> {
    constructor(repo: Repository<TestEntity>) {
      super(repo);
    }
  }

  let service: TestService;
  let repo: Repository<TestEntity>;

  beforeEach(() => {
    repo = {
      findAndCount: vi.fn(),
    } as unknown as Repository<TestEntity>;
    service = new TestService(repo);
  });

  it('should return list field instead of items', async () => {
    const mockItems = [{ id: 1, name: 'test' }];
    (repo.findAndCount as ReturnType<typeof vi.fn>).mockResolvedValue([mockItems, 1]);

    const page: PageCommon = { pageNum: 1, pageSize: 10 };
    const result = await service.paginate(page);

    expect(result).toHaveProperty('list');
    expect(result).not.toHaveProperty('items');
    expect(result.list).toBe(mockItems);
    expect(result.total).toBe(1);
  });
});
