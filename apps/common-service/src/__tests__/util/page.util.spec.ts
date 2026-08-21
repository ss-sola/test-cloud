import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  flatten,
  flattenList,
  overwritePageList,
  type PaginatedResult,
} from '../../util/page.util';

describe('page.util', () => {
  it('should flatten nested fields and drop mapped top-level sources', () => {
    const result = flatten(
      {
        id: 1,
        profile: { name: 'Aurora' },
        meta: { code: 'A01' },
      },
      {
        profileName: 'profile.name',
        metaCode: 'meta.code',
      },
    );

    expect(result).toEqual({
      id: 1,
      profileName: 'Aurora',
      metaCode: 'A01',
    });
  });

  it('should flatten list items consistently', () => {
    expect(
      flattenList(
        [
          { id: 1, profile: { name: 'A' } },
          { id: 2, profile: { name: 'B' } },
        ],
        { profileName: 'profile.name' },
      ),
    ).toEqual([
      { id: 1, profileName: 'A' },
      { id: 2, profileName: 'B' },
    ]);
  });

  it('should overwrite paginated list while keeping meta fields', () => {
    const page: PaginatedResult<number> = {
      list: [1, 2],
      count: 2,
      currentPage: 1,
      pageNum: 10,
    };

    expect(overwritePageList(page, ['x'])).toEqual({
      list: ['x'],
      count: 2,
      currentPage: 1,
      pageNum: 10,
    });
  });
});
