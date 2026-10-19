import { parseEnv } from './env-diff.util';

type SysConfigType = 'number' | 'string' | 'json';

export function renderEnvConfigSql(beforeText: string, afterText: string): string {
  const before = parseEnv(beforeText);
  const after = parseEnv(afterText);

  return [...after.entries()]
    .filter(([key, value]) => {
      const previous = before.get(key);
      return (
        !previous ||
        previous.normalized !== value.normalized ||
        previous.description !== value.description
      );
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (key.length > 128) throw new Error('环境变量名称超过 sys_config.key 长度限制。');
      return renderConfigEntry(
        key,
        value.normalized,
        inferType(value.normalized),
        value.description ?? '',
      );
    })
    .join('\n');
}

function renderConfigEntry(
  key: string,
  value: string,
  type: SysConfigType,
  description: string,
): string {
  return [
    'INSERT INTO `sys_config` (`key`, `value`, `type`, `description`)',
    `VALUES (${quoteSqlString(key)}, ${quoteSqlString(value)}, ${quoteSqlString(type)}, ${quoteSqlString(description)})`,
    'ON DUPLICATE KEY UPDATE',
    '  `value` = VALUES(`value`),',
    '  `type` = VALUES(`type`),',
    '  `description` = VALUES(`description`);',
  ].join(' ');
}

function inferType(value: string): SysConfigType {
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return 'number';

  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object') return 'json';
  } catch {
    return 'string';
  }

  return 'string';
}

function quoteSqlString(value: string): string {
  let escaped = '';
  for (const character of value) {
    switch (character) {
      case '\\':
        escaped += '\\\\';
        break;
      case "'":
        escaped += "''";
        break;
      case '\0':
        escaped += '\\0';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\r':
        escaped += '\\r';
        break;
      case '\t':
        escaped += '\\t';
        break;
      case '\x1a':
        escaped += '\\Z';
        break;
      default:
        escaped += character;
    }
  }
  return `'${escaped}'`;
}
