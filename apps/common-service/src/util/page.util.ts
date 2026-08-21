export interface PaginatedResult<T> {
  list: T[];
  count: number;
  currentPage: number;
  pageNum: number;
}

type ExtractTopKeys<U extends Record<string, string>> = {
  [K in keyof U]: U[K] extends `${infer Top}.${string}` ? Top : never;
}[keyof U];

// 类型：路径解析
type GetValueByPath<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? GetValueByPath<T[K], Rest>
    : unknown
  : P extends keyof T
    ? T[P]
    : unknown;

// 类型：构造扁平化类型
type Flattened<T extends Record<string, any>, U extends Record<string, string>> = Omit<
  T,
  ExtractTopKeys<U> & keyof T
> & {
  [K in keyof U]: GetValueByPath<T, U[K]>;
};

/**
 * 通用扁平化（带字段映射），映射的顶层对象属性会被删除，但是语法提示不知为何被保留
 * @param item 原数据
 * @param mapping 映射表 { 新字段名: 原路径 }
 * @returns
 */
export function flatten<T extends Record<string, any>, U extends Record<string, string>>(
  item: T,
  mapping: U,
): Flattened<T, U> {
  const flatItem = { ...item } as Flattened<T, U>;

  for (const newKey in mapping) {
    const path = mapping[newKey];
    const keys = path.split('.');

    let value: unknown = item;
    for (const key of keys) {
      if (value === null || value === undefined) break;

      // 安全访问对象属性
      if (typeof value === 'object' && key in value) {
        value = (value as Record<string, unknown>)[key];
      } else {
        value = undefined;
        break;
      }
    }

    flatItem[newKey] = value as Flattened<T, U>[Extract<keyof U, string>];
  }

  const topLevelFields = new Set(Object.values(mapping).map((path) => path.split('.')[0]));
  for (const field of topLevelFields) {
    delete flatItem[field];
  }

  return flatItem;
}

/**
 * 通用扁平化（带字段映射，TS版）
 * @param list 原数据数组
 * @param mapping 映射表 { 新字段名: 原路径 }
 */
export function flattenList<T extends Record<string, any>, U extends Record<string, string>>(
  list: T[],
  mapping: U,
): Array<Flattened<T, U>> {
  return list.map((item) => {
    return flatten(item, mapping);
  });
}

export function overwritePageList<T, R>(page: PaginatedResult<T>, list: R[]) {
  return {
    ...page,
    list,
  };
}
