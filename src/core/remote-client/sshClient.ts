
import { spawn } from 'child_process';
import RemoteClient, { ConnectOption, Config } from './remoteClient';

export default class SSHClient extends RemoteClient {
  constructor(option: ConnectOption) {
    super(option);
  }

  // Override to prevent error: no persistent client to listen on
  onDisconnected(cb: (reason: string) => void) {
    // No-op for command-line SSH client
  }

  async _doConnect(connectOption: ConnectOption, config: Config): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-o', 'BatchMode=yes',
        '-p', String(connectOption.port || 22),
        `${connectOption.username}@${connectOption.host}`
      ];
      if (connectOption.privateKeyPath) {
        args.unshift('-i', connectOption.privateKeyPath);
      }
      const proc = spawn('ssh', args, { stdio: 'ignore' });
      proc.on('error', reject);
      proc.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error('SSH connection failed'));
      });
    });
  }

  _hasProvideAuth(connectOption: ConnectOption): boolean {
    return !!(connectOption.username && (connectOption.privateKeyPath || connectOption.password));
  }

  _initClient() {
    return null;
  }

  runSftpCommand(commands: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let args = [
        '-o', 'BatchMode=yes',
        '-P', String(this._option.port || 22)
      ];
      if (this._option.privateKeyPath) {
        args.unshift('-i', this._option.privateKeyPath);
      }
      // Nếu có SFTPserver, thêm -s 'sudo ...' vào đúng vị trí trước user@host
      if (this._option.SFTPserver) {
        args.push('-s', this._option.SFTPserver);
      }
      args.push(`${this._option.username}@${this._option.host}`);
      const proc = spawn('sftp', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let error = '';
      proc.stdout.on('data', d => output += d.toString());
      proc.stderr.on('data', d => error += d.toString());
      proc.on('error', reject);
      proc.on('exit', code => {
        if (code === 0) resolve(output);
        else reject(new Error(error || 'SFTP command failed'));
      });
      proc.stdin.write(commands.join('\n') + '\nexit\n');
      proc.stdin.end();
    });
  }

  scpTo(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-P', String(this._option.port || 22),
        localPath,
        `${this._option.username}@${this._option.host}:${remotePath}`
      ];
      if (this._option.privateKeyPath) {
        args.unshift('-i', this._option.privateKeyPath);
      }
      const proc = spawn('scp', args, { stdio: 'ignore' });
      proc.on('error', reject);
      proc.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error('SCP upload failed'));
      });
    });
  }

  scpFrom(remotePath: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-P', String(this._option.port || 22),
        `${this._option.username}@${this._option.host}:${remotePath}`,
        localPath
      ];
      if (this._option.privateKeyPath) {
        args.unshift('-i', this._option.privateKeyPath);
      }
      const proc = spawn('scp', args, { stdio: 'ignore' });
      proc.on('error', reject);
      proc.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error('SCP download failed'));
      });
    });
  }

  end() {}
  getFsClient() { return this; }
}
