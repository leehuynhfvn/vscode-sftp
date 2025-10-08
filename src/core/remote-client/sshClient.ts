
import { spawn } from 'child_process';
import RemoteClient, { ConnectOption, Config } from './remoteClient';
import logger from '../../logger';

function normalizeProxyCommand(raw: string): string {
  if (!raw) return raw;
  const original = raw;
  let pc = raw.trim();
  if ((pc.startsWith('"') && pc.endsWith('"')) || (pc.startsWith("'") && pc.endsWith("'"))) {
    pc = pc.slice(1, -1);
  }
  pc = pc.replace(/\\ /g, ' ');
  pc = pc.replace(/^"([\/][^" ]+)"(\s|$)/, (m, p1, ws) => `${p1}${ws}`);
  pc = pc.replace(/^'([\/][^' ]+)'(\s|$)/, (m, p1, ws) => `${p1}${ws}`);
  pc = pc.replace(/[\t ]{2,}/g, ' ').trim();
  if (process.env.SFTP_DEBUG === '1' && original !== pc) {
    logger.debug(`Normalized ProxyCommand: '${original}' -> '${pc}'`);
  }
  return pc;
}

export default class SSHClient extends RemoteClient {
  constructor(option: ConnectOption) { super(option); }

  onDisconnected(cb: (reason: string) => void) { /* no-op */ }

  async _doConnect(connectOption: ConnectOption, config: Config): Promise<void> {
    if (!connectOption.username) {
      connectOption.username = process.env.USER || process.env.LOGNAME || 'root';
    }
    return new Promise((resolve, reject) => {
      const args: string[] = ['-o', 'BatchMode=yes', '-p', String(connectOption.port || 22)];
      if ((connectOption as any).userKnownHostsFile) args.push('-o', `UserKnownHostsFile=${(connectOption as any).userKnownHostsFile}`);
      if ((connectOption as any).certificateFile) args.push('-o', `CertificateFile=${(connectOption as any).certificateFile}`);
      if ((connectOption as any).proxyCommand) {
        args.push('-o', `ProxyCommand=${normalizeProxyCommand((connectOption as any).proxyCommand as string)}`);
      }
      if (connectOption.strictHostKeyChecking === false) args.push('-o', 'StrictHostKeyChecking=no');
      if (process.env.SFTP_DEBUG === '1') args.push('-v');
      args.push('-T'); // no tty
      args.push(`${connectOption.username}@${connectOption.host}`);
      const PROBE_TOKEN = '__SFTP_PROBE_OK__';
      args.push('echo', PROBE_TOKEN);
      if (connectOption.privateKeyPath) args.unshift('-i', connectOption.privateKeyPath);
      if (process.env.SFTP_DEBUG === '1') logger.debug('SSH probe args:', JSON.stringify(args));
      const proc = spawn('ssh', args, { stdio: ['ignore','pipe','pipe'] });
      let stderr = ''; let stdout = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', reject);
      let killedByTimeout = false; let timeout: any = null;
      if (connectOption.connectTimeout) {
        timeout = setTimeout(() => { killedByTimeout = true; try { proc.kill('SIGKILL'); } catch(_) {} }, connectOption.connectTimeout);
      }
      proc.on('exit', code => {
        if (timeout) clearTimeout(timeout);
        if (code === 0) return resolve();
        if (killedByTimeout) return reject(new Error(`SSH connection timeout after ${connectOption.connectTimeout} ms. Command: ssh ${args.join(' ')}`));
        let extra = '';
        if (/Permission denied \(publickey\)/i.test(stderr)) extra += '\nHint: Teleport cert có thể thiếu/hết hạn. Chạy: tsh status && nếu cần: tsh login --proxy=teleport.huynh.io.vn:443 --user=' + (connectOption.username || '') + '';
        if (/tsh login/i.test(stderr) || /certificate has expired/i.test(stderr)) extra += '\nHint: Teleport session hết hạn, chạy lại tsh login.';
        const err = new Error(`SSH connection failed (code ${code}). Command: ssh ${args.join(' ')}\nSTDERR: ${stderr.trim()}\nSTDOUT: ${stdout.trim()}${extra}`);
        return reject(err);
      });
    });
  }

  _hasProvideAuth(connectOption: ConnectOption): boolean {
    if (connectOption.privateKeyPath) return true;
    return !!(connectOption.username && connectOption.password);
  }

  _initClient() { return null; }

  runSftpCommand(commands: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-o', 'BatchMode=yes', '-P', String(this._option.port || 22)];
      if ((this._option as any).userKnownHostsFile) args.push('-o', `UserKnownHostsFile=${(this._option as any).userKnownHostsFile}`);
      if ((this._option as any).certificateFile) args.push('-o', `CertificateFile=${(this._option as any).certificateFile}`);
      if ((this._option as any).proxyCommand) args.push('-o', `ProxyCommand=${normalizeProxyCommand((this._option as any).proxyCommand as string)}`);
      if ((this._option as any).strictHostKeyChecking === false) args.push('-o', 'StrictHostKeyChecking=no');
      if (!this._option.username) this._option.username = process.env.USER || process.env.LOGNAME || 'root';
      if (this._option.privateKeyPath) args.unshift('-i', this._option.privateKeyPath);
      if (this._option.SFTPserver) args.push('-s', this._option.SFTPserver);
      args.push(`${this._option.username}@${this._option.host}`);
      if (process.env.SFTP_DEBUG === '1') args.push('-v');
      if (process.env.SFTP_DEBUG === '1') logger.debug('SFTP spawn args:', JSON.stringify(args));
      const proc = spawn('sftp', args, { stdio: ['pipe','pipe','pipe'] });
      let output = ''; let error = '';
      proc.stdout.on('data', d => output += d.toString());
      proc.stderr.on('data', d => error += d.toString());
      proc.on('error', reject);
      proc.on('exit', code => {
        logger.debug(`SFTP command result: code=${code}, commands=${JSON.stringify(commands)}, output=${output.trim()}, error=${error.trim()}`);
        if (code === 0) return resolve(output);
        reject(new Error(`${error || 'SFTP command failed'}\nCommand: sftp ${args.join(' ')}\nCommands: ${commands.join('; ')}\nOUTPUT: ${output.trim()}`));
      });
      proc.stdin.write(commands.join('\n') + '\nexit\n');
      proc.stdin.end();
    });
  }

  scpTo(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-P', String(this._option.port || 22), localPath, `${this._option.username}@${this._option.host}:${remotePath}`];
      if (this._option.privateKeyPath) args.unshift('-i', this._option.privateKeyPath);
      const proc = spawn('scp', args, { stdio: 'ignore' });
      proc.on('error', reject);
      proc.on('exit', code => code === 0 ? resolve() : reject(new Error('SCP upload failed')));
    });
  }

  scpFrom(remotePath: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-P', String(this._option.port || 22), `${this._option.username}@${this._option.host}:${remotePath}`, localPath];
      if (this._option.privateKeyPath) args.unshift('-i', this._option.privateKeyPath);
      const proc = spawn('scp', args, { stdio: 'ignore' });
      proc.on('error', reject);
      proc.on('exit', code => code === 0 ? resolve() : reject(new Error('SCP download failed')));
    });
  }

  end() {}
  getFsClient() { return this; }
}
