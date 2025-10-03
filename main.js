const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');
const { autoUpdater } = require('electron-updater');

// Enable live reload for Electron in development
if (process.env.NODE_ENV === 'development') {
  require('electron-reload')(__dirname, {
    electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
    hardResetMethod: 'exit',
    ignore: /node_modules|[\/\\]\.|dist|\.git/,
    awaitWriteFinish: true
  });
  
  // Also watch for changes in public and templates directories
  require('electron-reload')(path.join(__dirname, 'public'), {
    electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
    hardResetMethod: 'exit',
    awaitWriteFinish: true
  });
  
  require('electron-reload')(path.join(__dirname, 'templates'), {
    electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
    hardResetMethod: 'exit',
    awaitWriteFinish: true
  });
}

// Store app data in custom folder
app.setPath('userData', path.join(app.getPath('userData'), 'cfpl-app'));

let serverProcess;
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.loadURL('http://localhost:3000/login.html');
}

// Poll until Express server is ready
function pollServer(callback) {
  const intervalId = setInterval(() => {
    http.get('http://localhost:3000', (res) => {
      clearInterval(intervalId);
      callback();
    }).on('error', () => {
      // Server not ready yet.
    });
  }, 500);
}

app.whenReady().then(() => {
  const appPath = app.getAppPath();
  const serverPath = path.join(appPath, 'server.js');

  // Start backend server
  serverProcess = fork(serverPath, [], { silent: true });

  serverProcess.stdout.on('data', (data) => {
    console.log(`Server stdout: ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`Server stderr: ${data}`);
  });

  pollServer(createWindow);

  // ======================
  // ⚡ Auto-Updater Events
  // ======================
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('checking-for-update', () => {
    console.log('🔍 Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('✅ Update available:', info.version);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) is downloading in the background.`
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('🚀 App is up to date.');
  });

  autoUpdater.on('error', (err) => {
    console.error('❌ Update error:', err);
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(
      `📥 Download speed: ${progress.bytesPerSecond} - ` +
      `${progress.percent.toFixed(2)}% complete ` +
      `(${progress.transferred}/${progress.total})`
    );
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('🎉 Update downloaded:', info.version);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'Restart now to install the latest version?',
      buttons: ['Restart', 'Later']
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
