import * as fs from 'fs';
import * as fse from 'fs-extra';
import FileSystem, { FileEntry, FileStats, FileOption, FileType } from './fileSystem';

export default class LocalFileSystem extends FileSystem {
  constructor(pathResolver: any) {
    super(pathResolver);
  }

  toFileStat(stat: fs.Stats): FileStats {
    return {
      type: FileSystem.getFileTypecharacter(stat),
      size: stat.size,
      mode: stat.mode & parseInt('777', 8), // tslint:disable-line:no-bitwise
      mtime: stat.mtime.getTime(),
      atime: stat.atime.getTime(),
    };
  }

  lstat(path: string): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      fs.lstat(path, (err, stat: fs.Stats) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  readFile(path, option?): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
      fs.readFile(path, option, (err, data) => {
        if (err) {
          return reject(err);
        }

        resolve(data);
      });
    });
  }

  async open(path: string, flags: string, mode?: number): Promise<number> {
    // Check if path is a directory first to prevent EISDIR errors
    try {
      const stats = await this.lstat(path);
      if (stats.type === FileType.Directory) {
        // Import logger dynamically to avoid circular imports
        const logger = require('../../logger').default;
        logger.error('LocalFileSystem.open() - Attempting to open directory as file:', {
          path,
          flags,
          mode,
          fileType: stats.type
        });
        throw new Error(`EISDIR: illegal operation on a directory, open '${path}'`);
      }
    } catch (error) {
      // If lstat fails, let fse.open handle it (file might not exist yet for write operations)
      if (error.message.includes('EISDIR')) {
        throw error;
      }
    }
    return fse.open(path, flags, mode);
  }

  close(fd: number): Promise<void> {
    return fse.close(fd);
  }

  fstat(fd: number): Promise<FileStats> {
    return fse.fstat(fd).then(stat => this.toFileStat(stat));
  }

  futimes(fd: number, atime: number, mtime: number): Promise<void> {
    return fse.futimes(fd, atime, mtime);
  }

  get(path, option?): Promise<fs.ReadStream> {
    return new Promise((resolve, reject) => {
      try {
        const stream = fs.createReadStream(path, option);
        stream.once('error', reject);
        resolve(stream);
      } catch (err) {
        reject(err);
      }
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.chmod(path, mode, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  put(input: fs.ReadStream, path, option?: FileOption): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (option && option.fd && typeof option.fd !== 'number') {
        return reject(new Error('fd is not a number'));
      }

      const writer = fs.createWriteStream(path, option as any);
      writer.once('error', reject).once('finish', resolve); // transffered

      input.once('error', err => {
        reject(err);
        writer.end();
      });
      input.pipe(writer);
    });
  }

  readlink(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      fs.readlink(path, (err, linkString) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(linkString);
      });
    });
  }

  symlink(targetPath: string, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.symlink(targetPath, path, null, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  mkdir(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.mkdir(dir, err => {
        if (err) {
          // Ignore error if directory already exists
          if (err.code === 'EEXIST') {
            return resolve(); // Success - directory exists
          }
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  ensureDir(dir: string): Promise<void> {
    return fse.ensureDir(dir).catch(error => {
      // Ignore error if directory already exists
      if (error.code === 'EEXIST') {
        return; // Success - directory exists
      }
      throw error; // Re-throw other errors
    });
  }

  toFileEntry(fullPath: string, stat: FileStats): FileEntry {
    return {
      fspath: fullPath,
      name: this.pathResolver.basename(fullPath),
      ...stat,
    };
  }

  list(dir: string): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      fs.readdir(dir, (err, files) => {
        if (err) {
          reject(err);
          return;
        }

        const fileStatus = files.map(file => {
          const fspath = this.pathResolver.join(dir, file);
          return this.lstat(fspath).then(stat =>
            this.toFileEntry(fspath, stat)
          );
        });

        resolve(Promise.all(fileStatus));
      });
    });
  }

  unlink(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.unlink(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    if (recursive) {
      return fse.remove(path);
    }

    return new Promise<void>((resolve, reject) => {
      fs.rmdir(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  rename(srcPath: string, destPath: string): Promise<void> {
    return fse.rename(srcPath, destPath);
  }

  renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return fse.rename(srcPath, destPath);
  }
}
