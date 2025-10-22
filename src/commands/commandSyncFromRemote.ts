import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_SYNC_FROM_REMOTE } from '../constants';
import { getWorkspaceFolders } from '../host';
import { getAllFileService } from '../modules/serviceManager';
import { showInformationMessage, showErrorMessage } from '../host';
import { checkCommand } from './abstract/createCommand';

// Helper function to check if files are different
async function needsDownload(remoteFs: any, localFs: any, remotePath: string, localPath: string): Promise<boolean> {
  try {
    // Check if local file exists
    const localExists = await localFs.pathExists(localPath);
    if (!localExists) {
      return true; // File doesn't exist locally, needs download
    }

    // Get remote and local file stats
    const remoteStat = await remoteFs.lstat(remotePath);
    const localStat = await localFs.lstat(localPath);

    // Compare file sizes first (quick check)
    if (remoteStat.size !== localStat.size) {
      return true; // Different sizes, needs download
    }

    // Compare modification times
    if (remoteStat.mtime && localStat.mtime) {
      const remoteTime = new Date(remoteStat.mtime).getTime();
      const localTime = new Date(localStat.mtime).getTime();
      
      // If remote is newer, download it
      if (remoteTime > localTime) {
        return true;
      }
    }

    // Files appear to be the same
    return false;
  } catch (error) {
    // If we can't compare, err on the side of downloading
    return true;
  }
}

// Helper function to sync directory recursively with intelligent comparison
async function syncDirectoryRecursive(remoteFs: any, localFs: any, remotePath: string, localPath: string) {
  let downloadedCount = 0;
  let skippedCount = 0;
  let totalCount = 0;

  try {
    // Ensure local directory exists
    await localFs.ensureDir(localPath);
    
    // List remote directory contents
    const entries = await remoteFs.list(remotePath);
    
    for (const entry of entries) {
      const remoteItemPath = path.posix.join(remotePath, entry.name);
      const localItemPath = path.join(localPath, entry.name);
      
      if (entry.type === 1) { // Directory
        const subResult = await syncDirectoryRecursive(remoteFs, localFs, remoteItemPath, localItemPath);
        downloadedCount += subResult.downloaded;
        skippedCount += subResult.skipped;
        totalCount += subResult.total;
      } else { // File
        totalCount++;
        try {
          const shouldDownload = await needsDownload(remoteFs, localFs, remoteItemPath, localItemPath);
          
          if (shouldDownload) {
            const fileStream = await remoteFs.get(remoteItemPath);
            await localFs.put(fileStream, localItemPath);
            downloadedCount++;
            console.log(`Downloaded: ${remoteItemPath}`);
          } else {
            skippedCount++;
            console.log(`Skipped (up to date): ${remoteItemPath}`);
          }
        } catch (error) {
          console.error(`Failed to process file ${remoteItemPath}:`, error.message);
          // Continue with other files even if one fails
        }
      }
    }
  } catch (error) {
    console.error(`Failed to process directory ${remotePath}:`, error.message);
    throw error; // Re-throw directory-level errors
  }

  return { downloaded: downloadedCount, skipped: skippedCount, total: totalCount };
}

export default checkCommand({
  id: COMMAND_SYNC_FROM_REMOTE,

  async handleCommand() {
    try {
      // Get available file services (SFTP configurations)
      const fileServices = getAllFileService();
      if (!fileServices || fileServices.length === 0) {
        showErrorMessage('No SFTP connection found. Please ensure you have opened a folder with SFTP configuration.');
        return;
      }

      let selectedFileService;
      if (fileServices.length === 1) {
        selectedFileService = fileServices[0];
      } else {
        // Let user choose which connection to use
        const serviceOptions = fileServices.map(service => {
          const config = service.getConfig();
          return {
            label: `${config.name || config.host}:${config.port || 22}`,
            description: config.host,
            service,
          };
        });

        const selectedOption = await vscode.window.showQuickPick(serviceOptions, {
          placeHolder: 'Select SFTP connection',
        });

        if (!selectedOption) {
          return;
        }

        selectedFileService = selectedOption.service;
      }

      // Ask user for remote path
      const remotePath = await vscode.window.showInputBox({
        prompt: 'Enter remote path to sync (only downloads files that are different or missing)',
        placeHolder: '/path/to/remote/file/or/directory',
        value: '/',
      });

      if (!remotePath) {
        return; // User cancelled
      }

      // Use workspace base directory as destination - preserve remote path structure
      const workspaceBaseDir = selectedFileService.baseDir;
      
      // Create local path that mirrors the remote structure
      // If remote path is absolute (starts with /), create relative path in workspace
      let relativePath = remotePath;
      if (remotePath.startsWith('/')) {
        // Remove leading slash for workspace-relative path
        relativePath = remotePath.substring(1);
      }
      
      const finalLocalPath = path.join(workspaceBaseDir, relativePath);

      // Get remote filesystem to check file type
      const config = selectedFileService.getConfig();
      const remoteFs = await selectedFileService.getRemoteFileSystem(config);
      
      let isDirectory: boolean;
      try {
        const stat = await remoteFs.lstat(remotePath);
        isDirectory = stat.type === 1; // 1 = Directory, 2 = File
      } catch (error) {
        showErrorMessage(`Failed to check remote path: ${error.message}`);
        return;
      }

      // Create a synthetic local URI that points to the workspace folder
      // This is needed for the file service mapping to work
      const workspaceFolders = getWorkspaceFolders();
      if (!workspaceFolders || workspaceFolders.length === 0) {
        showErrorMessage('No workspace folder found. Please open a workspace folder.');
        return;
      }

      // Sync directly using file system with intelligent comparison
      const localFs = selectedFileService.getLocalFileSystem();
      
      // Ensure local directory exists
      const localDir = path.dirname(finalLocalPath);
      await localFs.ensureDir(localDir);

      if (isDirectory) {
        showInformationMessage(`Syncing directory intelligently: ${remotePath} → workspace${path.sep}${relativePath}`);
        
        // Sync directory recursively with smart comparison
        const result = await syncDirectoryRecursive(remoteFs, localFs, remotePath, finalLocalPath);
        
        let message = `Directory sync completed: ${result.total} files processed`;
        if (result.downloaded > 0) {
          message += `, ${result.downloaded} downloaded`;
        }
        if (result.skipped > 0) {
          message += `, ${result.skipped} skipped (already up to date)`;
        }
        showInformationMessage(message);
      } else {
        // Check if single file needs download
        const shouldDownload = await needsDownload(remoteFs, localFs, remotePath, finalLocalPath);
        
        if (shouldDownload) {
          showInformationMessage(`Syncing file: ${remotePath} → workspace${path.sep}${relativePath}`);
          
          // Download single file
          const fileStream = await remoteFs.get(remotePath);
          await localFs.put(fileStream, finalLocalPath);
          
          showInformationMessage(`File synced successfully: ${finalLocalPath}`);
        } else {
          showInformationMessage(`File is already up to date: ${finalLocalPath}`);
        }
      }
    } catch (error) {
      showErrorMessage(`Sync failed: ${error.message}`);
    }
  },
});
