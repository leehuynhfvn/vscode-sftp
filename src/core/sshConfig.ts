import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../logger';
import { replaceHomePath } from '../helper';
import * as SSHConfig from 'ssh-config';

export interface ResolvedSSHConfigHost {
  host: string; // alias used
  hostname?: string; // real hostname
  user?: string;
  port?: number;
  identityFile?: string; // first identity file
  identityFiles?: string[]; // all identity files
  proxyCommand?: string;
  certificateFile?: string;
  userKnownHostsFile?: string;
  raw?: any; // raw section for debugging
}

// Simple cache keyed by absolute config path + mtime
const cache: Map<string, { mtimeMs: number; parsed: any }> = new Map();

function readConfigFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    logger.warn(e.message, `sshConfig read failed: ${file}`);
    return '';
  }
}

function expandInclude(globPath: string): string[] {
  // Very small implementation: support relative to original file dir and ~ expansion, no wildcards beyond * in filename.
  const dir = path.dirname(globPath);
  const base = path.basename(globPath);
  if (!base.includes('*')) {
    return fs.existsSync(globPath) ? [globPath] : [];
  }
  const prefix = base.split('*')[0];
  const suffix = base.split('*')[1] || '';
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith(suffix))
    .map(f => path.join(dir, f));
}

function loadAndParse(configPath: string): any {
  const abs = replaceHomePath(configPath.replace(/"/g, ''));
  let statMtime = 0;
  try {
    statMtime = fs.statSync(abs).mtimeMs;
  } catch {
    // ignore
  }
  const key = abs;
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === statMtime) {
    return cached.parsed;
  }

  let content = readConfigFile(abs);
  if (!content) {
    return null;
  }
  // Handle Include directives (single line) simply.
  const includeRegex = /^Include\s+(.+)$/gim;
  let match: RegExpExecArray | null;
  const extraParts: string[] = [];
  while ((match = includeRegex.exec(content))) {
    const includeTarget = replaceHomePath(match[1].trim());
    expandInclude(includeTarget).forEach(p => {
      extraParts.push(readConfigFile(p));
    });
  }
  if (extraParts.length) {
    content += '\n' + extraParts.join('\n');
  }

  let parsed: any = null;
  try {
    parsed = SSHConfig.parse(content);
  } catch (e) {
    logger.error(e.message, 'sshConfig parse failed');
    return null;
  }
  cache.set(key, { mtimeMs: statMtime, parsed });
  return parsed;
}

export function resolveHostFromSSHConfig(
  host: string,
  options: { configPath?: string } = {}
): ResolvedSSHConfigHost | null {
  const configPath = options.configPath || path.join(os.homedir(), '.ssh', 'config');
  const parsed = loadAndParse(configPath);
  if (!parsed) return null;

  // ssh-config lib has .find; if not found, attempt compute (which resolves wildcards)
  // Always attempt compute so wildcard / negation works
  try {
    const computed = parsed.compute(host);
    if (computed) {
      const identity = Array.isArray(computed.IdentityFile)
        ? computed.IdentityFile.map(replaceHomePath)
        : computed.IdentityFile
        ? [replaceHomePath(computed.IdentityFile)]
        : [];
      const res: ResolvedSSHConfigHost = {
        host,
        hostname: computed.HostName,
        user: computed.User,
        port: computed.Port ? parseInt(computed.Port, 10) : undefined,
        identityFile: identity[0],
        identityFiles: identity,
        proxyCommand: computed.ProxyCommand,
        certificateFile: computed.CertificateFile
          ? replaceHomePath(computed.CertificateFile)
          : undefined,
        userKnownHostsFile: computed.UserKnownHostsFile
          ? replaceHomePath(computed.UserKnownHostsFile)
          : undefined,
        raw: computed,
      };
      // Teleport specific: sometimes User not set but IdentityFile path ends with /<username>
      if (!res.user && res.identityFile) {
        const m = res.identityFile.match(/\/([^\/]+)$/);
        if (m) res.user = m[1];
      }
      return res;
    }
  } catch (e) {
    logger.warn((e as Error).message, 'sshConfig compute failed');
  }
  return null;
}
