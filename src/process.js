const { spawn } = require("child_process");
const { join } = require("path");

const { defaultDir, bin, ready, inUse } = require("./constants");
const errorMessageRegEx = /ERROR.*/;
const errorCodeRegEx = /ERR_NGROK_\d*/;

let processPromise, activeProcess;

/*
  ngrok process runs internal ngrok api
  and should be spawned only ONCE
  (respawn allowed if it fails or .kill method called)
*/
async function getProcess(opts) {
  if (processPromise) return processPromise;
  try {
    processPromise = startProcess(opts);
    return await processPromise;
  } catch (ex) {
    processPromise = null;
    throw ex;
  }
}

function parseAddr(message) {
  if (message[0] === "{") {
    const parsed = JSON.parse(message);
    return parsed.addr;
  } else {
    const parsed = message.match(ready);
    if (parsed) {
      return parsed[1];
    }
  }
}

async function startProcess(opts) {
  let dir = defaultDir;
  const start = ["start", "--none", "--log=stdout"];
  if (opts.authtoken) start.push(`--authtoken=${opts.authtoken}`);
  if (opts.region) start.push(`--region=${opts.region}`);
  if (opts.configPath) start.push(`--config=${opts.configPath}`);
  if (opts.binPath) dir = opts.binPath(dir);

  const ngrok = spawn(join(dir, bin), start, { windowsHide: true });

  let resolve, reject;
  const apiUrl = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  ngrok.stdout.on("data", (data) => {
    const msg = data.toString().trim();
    if (opts.onLogEvent) {
      opts.onLogEvent(msg);
    }
    if (opts.onStatusChange) {
      if (msg.match("client session established")) {
        opts.onStatusChange("connected");
      } else if (msg.match("session closed, starting reconnect loop")) {
        opts.onStatusChange("closed");
      }
    }

    const msgs = msg.split(/\n/);
    msgs.forEach((msg) => {
      const addr = parseAddr(msg);
      if (addr) {
        resolve(`http://${addr}`);
      } else if (msg.match(inUse)) {
        reject(new Error(msg.substring(0, 10000)));
      }
    });
  });

  ngrok.stderr.on("data", (data) => {
    const msg = data.toString().substring(0, 10000);
    const lines = msg.split(/\n/);
    lines.forEach(line => {
      let errorMessage = line.match(errorMessageRegEx);
      if (errorMessage) {
        errors.push(cleanError(errorMessage[0]));
        if (line.match(errorCodeRegEx)) {
          reject(new Error(errors.join('\n')));
        }
      }
    })
    reject(new Error(msg));
  });

  ngrok.on("exit", () => {
    processPromise = null;
    activeProcess = null;
    if (opts.onTerminated) {
      opts.onTerminated();
    }
  });

  try {
    const url = await apiUrl;
    activeProcess = ngrok;
    return url;
  } catch (ex) {
    ngrok.kill();
    throw ex;
  } finally {
    // Remove the stdout listeners if nobody is interested in the content.
    if (!opts.onLogEvent && !opts.onStatusChange) {
      ngrok.stdout.removeAllListeners("data");
    }
    ngrok.stderr.removeAllListeners("data");
  }
}

function cleanError(message) {
  const newMessage = message.replace(/ERROR:\s+/, '');
  return newMessage.replace(errorCodeRegEx, `More info: https://ngrok.com/docs/errors/${newMessage.toLowerCase()}`);
}

function killProcess() {
  if (!activeProcess) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    activeProcess.on("exit", () => resolve());
    activeProcess.kill();
  });
}

process.on("exit", () => {
  if (activeProcess) {
    activeProcess.kill();
  }
});

module.exports = {
  getProcess,
  killProcess,
};
