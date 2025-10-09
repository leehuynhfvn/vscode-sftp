import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_DOWNLOAD_FROM_REMOTE } from '../constants';
import { getWorkspaceFolders } from '../host';
import { getAllFileService } from '../modules/serviceManager';
import { showOpenDialog, showInformationMessage, showErrorMessage } from '../host';
import { checkCommand } from './abstract/createCommand';

// Helper function to download directory recursively
async function downloadDirectoryRecursive(remoteFs: any, localFs: any, remotePath: string, localPath: string) {
  // Ensure local directory exists
  await localFs.ensureDir(localPath);
  
  // List remote directory contents
  const entries = await remoteFs.list(remotePath);
  
  for (const entry of entries) {
    const remoteItemPath = path.posix.join(remotePath, entry.name);
    const localItemPath = path.join(localPath, entry.name);
    
    if (entry.type === 1) { // Directory
      await downloadDirectoryRecursive(remoteFs, localFs, remoteItemPath, localItemPath);
    } else { // File
      try {
        const fileStream = await remoteFs.get(remoteItemPath);
        await localFs.put(fileStream, localItemPath);
      } catch (error) {
        console.error(`Failed to download file ${remoteItemPath}:`, error.message);
      }
    }
  }
}

export default checkCommand({
  id: COMMAND_DOWNLOAD_FROM_REMOTE,

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
        prompt: 'Enter remote file or directory path to download',
        placeHolder: '/path/to/remote/file/or/directory',
        value: '/',
      });

      if (!remotePath) {
        return; // User cancelled
      }

      // Ask user for local destination
      const openDialogOptions: vscode.OpenDialogOptions = {
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Local Destination',
      };

      const localDestinations = await showOpenDialog(openDialogOptions);
      if (!localDestinations || localDestinations.length === 0) {
        return; // User cancelled
      }

      const localDestinationDir = localDestinations[0].fsPath;
      
      // Determine the final local path
      const remoteBaseName = path.basename(remotePath);
      const finalLocalPath = path.join(localDestinationDir, remoteBaseName);

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



      // Download directly using file system without going through the handler layer
      const localFs = selectedFileService.getLocalFileSystem();
      
      // Ensure local directory exists
      const localDir = path.dirname(finalLocalPath);
      await localFs.ensureDir(localDir);

      if (isDirectory) {
        showInformationMessage(`Downloading directory: ${remotePath} to ${finalLocalPath}`);
        
        // Download directory recursively
        await downloadDirectoryRecursive(remoteFs, localFs, remotePath, finalLocalPath);
        
        showInformationMessage(`Directory downloaded successfully: ${finalLocalPath}`);
      } else {
        showInformationMessage(`Downloading file: ${remotePath} to ${finalLocalPath}`);
        
        // Download single file
        const fileStream = await remoteFs.get(remotePath);
        await localFs.put(fileStream, finalLocalPath);
        
        showInformationMessage(`File downloaded successfully: ${finalLocalPath}`);
      }
    } catch (error) {
      showErrorMessage(`Download failed: ${error.message}`);
    }
  },
});