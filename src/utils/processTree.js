const { exec } = require('child_process');

/**
 * 在 Windows 上终止整棵进程树
 * @param {number} pid - 主进程 PID
 * @returns {Promise<void>}
 */
function killProcessTree(pid) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      exec(`taskkill /F /T /PID ${pid}`, (err) => {
        // 忽略"进程不存在"错误
        if (err && !err.message.includes('not found')) {
          reject(err);
        } else {
          resolve();
        }
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
        resolve();
      } catch (e) {
        if (e.code === 'ESRCH') resolve(); // 进程已退出
        else reject(e);
      }
    }
  });
}

module.exports = { killProcessTree };
