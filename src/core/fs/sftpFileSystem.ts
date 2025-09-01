
import RemoteFileSystem from './remoteFileSystem';
import { SSHClient } from '../remote-client';

import { Readable } from 'stream';
import { FileType, FileEntry, FileStats, FileOption } from './fileSystem';

export default class SFTPFileSystem extends RemoteFileSystem {
  constructor(pathResolver, option) {
    super(pathResolver, option);
  }

  _createClient(option) {
    return new SSHClient(option);
  }

  // Chỉ mock, chưa hỗ trợ open/close/fstat/futimes
  async open(path: string, flags: string, mode?: number) { throw new Error('Not implemented'); }
  async close(fd: any) { throw new Error('Not implemented'); }
  async fstat(fd: any): Promise<FileStats> { throw new Error('Not implemented'); }
  async futimes(fd: any, atime: number, mtime: number): Promise<void> { throw new Error('Not implemented'); }

  async get(path: string, option?: FileOption): Promise<Readable> {
    // Download file về tạm, trả về stream đọc file local
    const tmp = `/tmp/sftp-get-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await (this.client as any).scpFrom(path, tmp);
    const fs = await import('fs');
    return fs.createReadStream(tmp);
  }

  async put(input: Readable, path: string, option?: FileOption): Promise<void> {
    // Ghi stream ra file tạm, upload bằng scp
    const tmp = `/tmp/sftp-put-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const fs = await import('fs');
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      input.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      input.on('error', reject);
    });
  await (this.client as any).scpTo(tmp, path);
    fs.unlink(tmp, () => {});
  }

  async mkdir(dir: string): Promise<void> {
  await (this.client as any).runSftpCommand([`mkdir "${dir}"`]);
  }

  async ensureDir(dir: string): Promise<void> {
    // Đơn giản: mkdir, nếu lỗi thì bỏ qua
    try { await this.mkdir(dir); } catch {}
  }

  async chmod(path: string, mode: number): Promise<void> {
  await (this.client as any).runSftpCommand([`chmod ${mode.toString(8)} "${path}"`]);
  }

  async list(dir: string, option?: any): Promise<FileEntry[]> {
    // Sử dụng sftp lệnh 'ls -l' để liệt kê file
  const out = await (this.client as any).runSftpCommand([`ls -l "${dir}"`]);
    // Parse output thành FileEntry[] (giản lược, chỉ lấy tên file)
    return out.split('\n').filter(Boolean).slice(1).map(line => {
      const parts = line.trim().split(/\s+/);
      const name = parts.slice(8).join(' ');
      return { fspath: `${dir}/${name}`, name, type: FileType.File, mode: 0, size: 0, mtime: 0, atime: 0 };
    });
  }

  async lstat(path: string): Promise<FileStats> {
    // Sử dụng sftp lệnh 'ls -l' để lấy thông tin file
  const out = await (this.client as any).runSftpCommand([`ls -l "${path}"`]);
    // Parse output thành FileStats (giản lược)
    const line = out.split('\n').filter(Boolean).pop() || '';
    const parts = line.trim().split(/\s+/);
    return { type: FileType.File, mode: 0, size: 0, mtime: 0, atime: 0 };
  }

  async readFile(path: string, option?: FileOption): Promise<string | Buffer> {
    const stream = await this.get(path, option);
    return new Promise((resolve, reject) => {
      const arr: Buffer[] = [];
    stream.on('data', chunk => arr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  stream.on('end', () => resolve(Buffer.concat(arr as Buffer[])));
    stream.on('error', reject);
    });
  }

  async readlink(path: string): Promise<string> {
  const out = await (this.client as any).runSftpCommand([`readlink "${path}"`]);
    return out.trim();
  }

  async symlink(targetPath: string, path: string): Promise<void> {
  await (this.client as any).runSftpCommand([`symlink "${targetPath}" "${path}"`]);
  }

  async unlink(path: string): Promise<void> {
  await (this.client as any).runSftpCommand([`rm "${path}"`]);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (!recursive) {
  await (this.client as any).runSftpCommand([`rmdir "${path}"`]);
      return;
    }
    // Nếu recursive: list và xóa từng file/folder
    const files = await this.list(path);
    for (const file of files) {
      await this.unlink(file.fspath);
    }
  await (this.client as any).runSftpCommand([`rmdir "${path}"`]);
  }

  async rename(srcPath: string, destPath: string): Promise<void> {
  await (this.client as any).runSftpCommand([`rename "${srcPath}" "${destPath}"`]);
  }

  async renameAtomic(srcPath: string, destPath: string): Promise<void> {
    await this.rename(srcPath, destPath);
  }
}
