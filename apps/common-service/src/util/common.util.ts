import * as os from 'os';
import { Logger } from '@nestjs/common';

const logger = new Logger('CommonUtil');

export function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address; // 返回非 127.0.0.1 的 IP
      }
    }
  }
  return '127.0.0.1';
}

export function isSameService(urlA: string, urlB: string): boolean {
  try {
    const localIp = getLocalIp();

    const normalizeHost = (hostname: string) => {
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return localIp;
      }
      return hostname;
    };

    const uA = new URL(urlA);
    const uB = new URL(urlB);

    const hostA = normalizeHost(uA.hostname);
    const hostB = normalizeHost(uB.hostname);

    return (
      uA.protocol === uB.protocol &&
      (uA.port || getDefaultPort(uA.protocol)) === (uB.port || getDefaultPort(uB.protocol)) &&
      hostA === hostB
    );
  } catch (e) {
    logger.error(
      `Error in isSameService: ${e instanceof Error ? e.message : String(e)}`,
      e instanceof Error ? e.stack : undefined,
    );
    return false;
  }
}

function getDefaultPort(protocol: string): string {
  switch (protocol) {
    case 'http:':
      return '80';
    case 'https:':
      return '443';
    default:
      return '';
  }
}
