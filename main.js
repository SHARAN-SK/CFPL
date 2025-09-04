const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');
const { autoUpdater } = require('electron-updater');

// Set the user data path before the app is ready
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
  serverProcess = fork(serverPath, [], {
    silent: true
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`Server stdout: ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`Server stderr: ${data}`);
  });

  pollServer(createWindow);

  // 🔹 Auto-updater check
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-available', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: 'A new version is downloading in the background.'
    });
  });

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'Restart now to install the latest version?',
      buttons: ['Restart', 'Later']
    }).then(result => {
      if (result.response === 0) autoUpdater.quitAndInstall();
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
