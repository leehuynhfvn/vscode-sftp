
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

  // Mock các hàm open/close/fstat/futimes để extension không lỗi khi upload
  async open(path: string, flags: string, mode?: number) {
    // Check if path is a directory first
    const stats = await this.lstat(path);
    if (stats.type === FileType.Directory) {
      throw new Error(`EISDIR: illegal operation on a directory, open '${path}'`);
    }
    // Trả về một fake file descriptor (có thể là path)
    return path;
  }
  async close(fd: any) {
    // Không cần làm gì
    return;
  }
  async fstat(fd: any): Promise<FileStats> {
    // Trả về thông tin file giả lập
    return { type: FileType.File, mode: 0, size: 0, mtime: 0, atime: 0 };
  }
  async futimes(fd: any, atime: number, mtime: number): Promise<void> {
    // Không cần làm gì
    return;
  }

  async get(path: string, option?: FileOption): Promise<Readable> {
  const logger = await import('../../logger');
  
  // First check if path is a directory - SFTP get only works with files
  try {
    const stat = await this.lstat(path);
    if (stat.type === FileType.Directory) {
      logger.default.error(`SFTPFileSystem.get() - Cannot download directory as file: "${path}"`);
      throw new Error(`Cannot download directory "${path}" as file - use directory transfer instead`);
    }
  } catch (lstatError) {
    logger.default.warn(`SFTPFileSystem.get() - Could not stat "${path}": ${lstatError.message}`);
  }
  
  // Download file về tạm bằng sftp (get), trả về stream đọc file local
  const tmp = `/tmp/sftp-get-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  
  try {
    logger.default.info(`SFTPFileSystem.get() - Downloading file "${path}" to temp file "${tmp}"`);
    await (this.client as any).runSftpCommand([`get "${path}" "${tmp}"`]);
    
    // Check if temp file exists
    const fs = await import('fs');
    
    try {
      const stat = fs.statSync(tmp);
      logger.default.info(`SFTPFileSystem.get() - Temp file created successfully, size: ${stat.size} bytes`);
    } catch (statError) {
      logger.default.error(`SFTPFileSystem.get() - Temp file not found after download: ${statError.message}`);
      throw new Error(`SFTP get failed: temp file "${tmp}" was not created`);
    }
    
    return fs.createReadStream(tmp);
  } catch (error) {
    logger.default.error(`SFTPFileSystem.get() - Error downloading "${path}": ${error.message}`);
    throw error;
  }
  }

  async put(input: Readable, path: string, option?: FileOption): Promise<void> {
    // Ghi stream ra file tạm, upload bằng sftp (put)
    const tmp = `/tmp/sftp-put-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const fs = await import('fs');
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      input.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      input.on('error', reject);
    });
    // Upload file tạm lên remote bằng sftp put
    await (this.client as any).runSftpCommand([`put "${tmp}" "${path}"`]);
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
    // Sử dụng sftp lệnh 'ls -la' để liệt kê file bao gồm hidden files
    const out = await (this.client as any).runSftpCommand([`ls -la "${dir}"`]);
    const logger = await import('../../logger');
    
    // Filter out sftp prompt lines and only process actual file entries
    const entries = out.split('\n')
      .filter(line => line.trim() && !line.startsWith('sftp>') && line.match(/^[drwx-]/))
      .map(line => {
        const parts = line.trim().split(/\s+/);
        const name = parts.slice(8).join(' ');
        // Xác định loại file: thư mục nếu bắt đầu bằng 'd', còn lại là file
        const type = line[0] === 'd' ? FileType.Directory : FileType.File;
        const entry = { fspath: `${dir}/${name}`, name, type, mode: 0, size: 0, mtime: 0, atime: 0 };
        
        logger.default.info(`SFTPFileSystem.list() - Entry: "${name}", First char: "${line[0]}", Type: ${type} (1=Directory, 2=File)`);
        
        return entry;
      })
      .filter(entry => entry.name !== '.' && entry.name !== '..'); // Filter out current and parent directory entries
    
    return entries;
  }

  async lstat(path: string): Promise<FileStats> {
    // Sử dụng sftp lệnh 'ls -l' để lấy thông tin file
    const logger = await import('../../logger');
    
    try {
      const out = await (this.client as any).runSftpCommand([`ls -la "${path}"`]);
      const lines = out.trim().split('\n').filter(l => l.trim());
      logger.default.info(`SFTPFileSystem.lstat() - Path: "${path}", Output lines: ${JSON.stringify(lines)}`);
      
      // Skip sftp prompt lines and find actual file listing
      const actualLines = lines.filter(line => !line.startsWith('sftp>') && line.match(/^[drwx-]/));
      
      if (actualLines.length === 1) {
        // Single entry - determine type from first character
        const line = actualLines[0];
        const type = line[0] === 'd' ? FileType.Directory : FileType.File;
        logger.default.info(`SFTPFileSystem.lstat() - Path: "${path}", Single entry first char: "${line[0]}", Detected type: ${type} (1=Directory, 2=File)`);
        return { type, mode: 0, size: 0, mtime: 0, atime: 0 };
      } else if (actualLines.length > 1) {
        // Multiple entries - this means we listed contents of a directory, so path is a directory  
        logger.default.info(`SFTPFileSystem.lstat() - Path: "${path}" is a directory (contains ${actualLines.length} entries)`);
        return { type: FileType.Directory, mode: 0, size: 0, mtime: 0, atime: 0 };
      } else {
        // If no file listings but command succeeded, check if it's a single file
        const nonPromptLines = lines.filter(line => !line.startsWith('sftp>') && !line.includes('exit'));
        if (nonPromptLines.length === 1) {
          const line = nonPromptLines[0];
          const type = line[0] === 'd' ? FileType.Directory : FileType.File;
          logger.default.info(`SFTPFileSystem.lstat() - Path: "${path}", Single entry first char: "${line[0]}", Detected type: ${type} (1=Directory, 2=File)`);
          return { type, mode: 0, size: 0, mtime: 0, atime: 0 };
        }
      }
    } catch (error) {
      logger.default.error(`SFTPFileSystem.lstat() - Error for path "${path}": ${error.message}`);
      // If ls fails, try to list parent directory to check if this is a directory
      try {
        const parentPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        const parentOut = await (this.client as any).runSftpCommand([`ls -l "${parentPath}"`]);
        const lines = parentOut.trim().split('\n').filter(l => l.trim() && !l.startsWith('total'));
        for (const line of lines) {
          if (line.includes(fileName)) {
            const type = line[0] === 'd' ? FileType.Directory : FileType.File;
            return { type, mode: 0, size: 0, mtime: 0, atime: 0 };
          }
        }
      } catch (e) {
        // Fallback
      }
    }
    // Default fallback
    logger.default.warn(`SFTPFileSystem.lstat() - Using fallback FileType.File for path "${path}"`);
    return { type: FileType.File, mode: 0, size: 0, mtime: 0, atime: 0 };
  }

  async readFile(path: string, option?: FileOption): Promise<string | Buffer> {
    const stream = await this.get(path, option);
    return new Promise((resolve, reject) => {
      const chunks: any[] = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const buffers = chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c));
        resolve(Buffer.concat(buffers as readonly Uint8Array[]));
      });
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
