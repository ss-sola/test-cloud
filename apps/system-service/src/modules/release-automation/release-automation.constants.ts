export const RELEASE_AUTOMATION_VERSION = '1.9.0' as const;
export const RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH = 'dev/master' as const;
export const RELEASE_AUTOMATION_QUEUE_NAME = 'release-automation';
export const RELEASE_AUTOMATION_QUEUE_PREFIX = 'release-automation';
export const RELEASE_AUTOMATION_QUEUE_JOB_NAME = 'release-plan';
export const RELEASE_AUTOMATION_JOB_TTL_MS = 60 * 60 * 1000;
export const RELEASE_AUTOMATION_MAX_ACTIVE_JOBS = 2;
export const RELEASE_AUTOMATION_DEFAULT_TIMEOUT_MS = 15_000;
export const RELEASE_AUTOMATION_DEFAULT_MAX_RETRIES = 2;
export const RELEASE_AUTOMATION_DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const RELEASE_AUTOMATION_DEFAULT_POLL_INTERVAL_MS = 1_000;
export const RELEASE_AUTOMATION_DEFAULT_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;
export const RELEASE_AUTOMATION_DEFAULT_BUILD_TIMEOUT_MS = 60 * 60 * 1000;
export const RELEASE_AUTOMATION_DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
export const RELEASE_AUTOMATION_DEFAULT_MAX_LOG_LINES = 20_000;
export const RELEASE_AUTOMATION_DEFAULT_ARCHIVE_DIR = 'var/release-automation/archive';
export const RELEASE_AUTOMATION_GENERATOR_VERSION = '1.0.0';
export const RELEASE_AUTOMATION_REDACTED_VALUE = '[REDACTED]';
export const RELEASE_AUTOMATION_IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const RELEASE_AUTOMATION_TAG_PATTERN =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const RELEASE_AUTOMATION_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
export const RELEASE_AUTOMATION_BRANCH_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
export const RELEASE_AUTOMATION_QUEUE_ID_PATTERN = /^\d+$/;
export const RELEASE_AUTOMATION_PATH_TEMPLATE_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/{}-]+$/;
export const RELEASE_AUTOMATION_SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session)/i;

export const RELEASE_AUTOMATION_TERMINAL_JOB_STAGES = [
  'completed',
  'partial-success',
  'manual_intervention',
  'failed',
] as const;
