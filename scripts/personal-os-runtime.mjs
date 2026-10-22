import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { createGzip } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), "..");
const nativeHome = userInfo().homedir;
const dataDir = join(nativeHome, ".local/share/bb-personal-os");
const manager = join(dataDir, "runtime-manager");
const configPath = join(manager, "config.json");
const statePath = join(manager, "state.json");
const launchLock = join(manager, "launch.lock");
const bundledNode = join(nativeHome, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node");
const entries = {
  server: join(repo, "apps/server/dist/index.js"),
  daemon: join(repo, "apps/host-daemon/dist/index.js"),
};

async function json(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function save(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function requireFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`Missing or empty file: ${path}`);
}

async function config() {
  const value = await json(configPath);
  if (!value || value.schemaVersion !== 1 || value.repo !== repo || value.dataDir !== dataDir) {
    throw new Error("Run setup explicitly for this checkout before start.");
  }
  const node = await realpath(value.node);
  await requireNode(node);
  return { ...value, node };
}

async function requireNode(node) {
  const result = await exec(node, ["-p", "JSON.stringify({version:process.version,abi:process.versions.modules})"]);
  const version = JSON.parse(result.stdout);
  if (!/^v24\./.test(version.version) || version.abi !== "137") throw new Error("This runtime requires Node24 / ABI137, matching its native dependencies.");
}

async function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const result = await exec("/bin/ps", ["-ww", "-p", String(pid), "-o", "uid=", "-o", "lstart=", "-o", "command="], { env: { ...process.env, LC_ALL: "C" } });
    const match = result.stdout.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    return match ? { pid, uid: Number(match[1]), started: match[2], command: match[3] } : null;
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}

async function owned(saved, node, entry, marker) {
  if (!saved || !marker) return false;
  const current = await identity(saved.pid);
  return current !== null && current.uid === process.getuid() &&
    current.uid === saved.uid && current.started === saved.started &&
    current.command === saved.command && current.command === `${node} ${entry} ${marker}`;
}

async function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); done(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function ownsPort(pid, port) {
  try {
    const result = await exec("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return result.stdout.trim().split(/\s+/).every((value) => value === String(pid));
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

function runtimeEnv() {
  const overrides = new Set(["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]);
  const providerOverride = /^(?:ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|AZURE_OPENAI_|GEMINI_|GOOGLE_AI_|GOOGLE_GENAI_|OPENROUTER_)/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BB_") && !providerOverride.test(key) && !overrides.has(key)));
  return {
    ...env,
    HOME: nativeHome,
    NODE_ENV: "production",
    BB_DATA_DIR: dataDir,
    BB_SERVER_URL: "http://127.0.0.1:7319",
    BB_SERVER_BIND_HOST: "127.0.0.1",
    BB_SERVER_PORT: "7319",
    BB_HOST_DAEMON_PORT: "7320",
    BB_APP_URL: "http://127.0.0.1:7319",
    BB_TELEMETRY: "false",
    BB_SKIP_ONBOARDING: "0",
    BB_HOST_DAEMON_AUTO_UPDATE: "false",
    BB_HOST_DAEMON_SUPERVISED: "false",
    BB_CLI_DIR: join(repo, "apps/host-daemon/dist"),
    BB_BRIDGE_DIR: join(repo, "apps/host-daemon/dist"),
  };
}

async function enrolled() {
  await Promise.all(["bb.db", "auth.json", "host-id"].map((name) => requireFile(join(dataDir, name))));
  const hostId = (await readFile(join(dataDir, "host-id"), "utf8")).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(hostId)) throw new Error("Existing public host-id is invalid; no enrollment was changed.");
  return hostId;
}

async function serviceReady(name, hostId) {
  try {
    const response = await fetch(name === "server" ? "http://127.0.0.1:7319/health" : "http://127.0.0.1:7320/status", { signal: AbortSignal.timeout(1000), redirect: "error" });
    if (!response.ok) return false;
    const body = await response.json();
    return name === "server" ? body.ok === true : body.connected === true && body.hostId === hostId;
  } catch { return false; }
}

async function status() {
  const state = await json(statePath);
  const settings = await json(configPath);
  const services = {};
  for (const [name, port] of [["server", 7319], ["daemon", 7320]]) {
    const managed = state && settings && await owned(state[name], settings.node, entries[name], state.marker);
    const listening = await portOpen(port);
    const ownedListener = Boolean(managed && listening && await ownsPort(state[name].pid, port));
    services[name] = { port, managed: Boolean(managed), listening, ownedListener, ready: Boolean(ownedListener && await serviceReady(name, state.hostId)), pid: managed ? state[name].pid : null };
  }
  const supervisor = Boolean(state && settings && await owned(state.supervisor, settings.node, script, `supervise ${state.token}`));
  return { dataDir, setup: Boolean(settings), phase: state?.phase ?? "not_managed", supervisor, services, error: state?.error ?? null };
}

async function terminate(saved, settings, entry, marker, attempts = 100) {
  if (!await owned(saved, settings.node, entry, marker)) return;
  process.kill(saved.pid, "SIGTERM");
  for (let count = 0; count < attempts; count += 1) {
    if (!await owned(saved, settings.node, entry, marker)) return;
    await sleep(100);
  }
  throw new Error(`Owned process ${saved.pid} did not stop; no force signal sent.`);
}

async function lockLaunch() {
  try { await mkdir(launchLock); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await json(join(launchLock, "owner.json"));
    if (!owner || owner.uid !== process.getuid()) throw new Error("Launch lock has unknown ownership; inspect it manually.");
    const current = await identity(owner.pid);
    if (current && current.started === owner.started && current.command === owner.command) throw new Error("Another start is already running.");
    throw new Error("An interrupted start left launch.lock. Inspect its saved owner and runtime status before removing only this manager lock.");
  }
  await save(join(launchLock, "owner.json"), await identity(process.pid));
  return async () => {
    await rm(join(launchLock, "owner.json"));
    await rmdir(launchLock);
  };
}

async function supervise(token) {
  const settings = await config();
  const hostId = await enrolled();
  const pending = await json(statePath);
  if (pending?.token !== token || pending.phase !== "starting") throw new Error("Launch intent changed.");
  const state = { ...pending, hostId, supervisor: await identity(process.pid) };
  const sinks = [];
  let stopping = false;
  let launching = null;
  const shutdown = async (failure = null) => {
    if (stopping) return;
    stopping = true;
    if (launching) await launching.catch(() => undefined);
    const failures = [];
    for (const name of ["daemon", "server"]) {
      try { await terminate(state[name], settings, entries[name], state.marker); }
      catch (error) { failures.push(error.message); }
    }
    for (const sink of sinks) {
      if (sink.closed) {
        const drained = await Promise.race([sink.closed.then(() => true), sleep(3000).then(() => false)]);
        if (!drained) {
          sink.child.stdout.unpipe(sink.gzip);
          sink.child.stderr.unpipe(sink.gzip);
          sink.child.stdout.destroy();
          sink.child.stderr.destroy();
          if (!sink.gzip.destroyed) sink.gzip.write("\nRuntime log drainage timed out after process stop.\n");
        }
      }
      sink.gzip.end();
      await new Promise((done) => sink.output.closed ? done() : sink.output.once("close", done));
    }
    state.phase = failures.length ? "stop_failed" : failure ? "failed" : "stopped";
    state.error = failures.join("; ") || failure;
    await save(statePath, state);
    await save(join(manager, `${token}-state.json`), state);
    process.exitCode = failures.length || failure ? 1 : 0;
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  try {
    await save(statePath, state);
    for (const [name, port] of [["server", 7319], ["daemon", 7320]]) {
      if (await portOpen(port)) throw new Error(`Port ${port} is already occupied; refusing to adopt or stop it.`);
      if (stopping) return;
      const gzip = createGzip();
      const output = createWriteStream(join(manager, `${token}-${name}.log.gz`), { flags: "wx", mode: 0o600 });
      gzip.pipe(output);
      const sink = { gzip, output, child: null, closed: null };
      sinks.push(sink);
      output.once("error", () => void shutdown(`${name} compressed log write failed.`));
      gzip.once("error", () => { output.destroy(); void shutdown(`${name} compressed log encoding failed.`); });
      let child;
      launching = (async () => {
        if (stopping) return;
        child = spawn(settings.node, [entries[name], state.marker], {
          cwd: repo,
          env: { ...runtimeEnv(), PATH: `${dirname(settings.node)}:${process.env.PATH ?? ""}` },
          stdio: ["ignore", "pipe", "pipe"],
        });
        sink.child = child;
        sink.closed = new Promise((done) => child.once("close", done));
        child.stdout.pipe(gzip, { end: false });
        child.stderr.pipe(gzip, { end: false });
        child.once("error", (error) => void shutdown(`${name} could not start: ${error.code ?? "unknown"}`));
        child.once("exit", (code, signal) => {
          if (!stopping) void shutdown(`${name} exited (${code ?? signal}); see compressed runtime log.`);
        });
        state[name] = await identity(child.pid);
        if (!state[name]) throw new Error(`Could not record ${name} process identity.`);
        await save(statePath, state);
      })();
      await launching;
      launching = null;
      if (stopping) return;
      let ready = false;
      for (let count = 0; count < 150 && !stopping; count += 1) {
        if (await portOpen(port) && await ownsPort(child.pid, port) && await serviceReady(name, hostId)) { ready = true; break; }
        await sleep(200);
      }
      if (!ready) throw new Error(`${name} did not become healthy and connected on loopback port ${port}.`);
    }
    if (!stopping) { state.phase = "running"; await save(statePath, state); }
  } catch (error) {
    await shutdown(error.message);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "status") {
    if (args.length) throw new Error("status accepts no arguments.");
    console.log(JSON.stringify(await status(), null, 2));
    return;
  }
  if (command === "setup") {
    if (args.length && (args.length !== 2 || args[0] !== "--node")) throw new Error("Usage: setup [--node /absolute/path/to/node24]");
    const node = await realpath(args[1] ?? bundledNode);
    await requireNode(node);
    const prior = await json(configPath);
    if (prior && (prior.node !== node || prior.repo !== repo || prior.dataDir !== dataDir)) throw new Error("Existing setup differs; refusing to overwrite it.");
    await mkdir(manager, { recursive: true, mode: 0o700 });
    await save(configPath, { schemaVersion: 1, repo, dataDir, node });
    console.log("Setup saved. Enrollment is not created or changed. start requires existing bb.db, auth.json and host-id.");
    return;
  }
  if (command === "supervise") {
    if (args.length !== 1 || !/^[a-f0-9-]{36}$/.test(args[0])) throw new Error("Invalid supervisor launch.");
    await supervise(args[0]);
    return;
  }
  if (!["start", "stop"].includes(command) || args.length) throw new Error("Usage: personal-os-runtime.mjs setup --node PATH | start | stop | status");
  const settings = await config();
  if (command === "stop") {
    const state = await json(statePath);
    if (!state) throw new Error("No owned runtime. Existing services will not be adopted or stopped.");
    await terminate(state.supervisor, settings, script, `supervise ${state.token}`, 300);
    for (const name of ["daemon", "server"]) await terminate(state[name], settings, entries[name], state.marker);
    const latest = await json(statePath);
    if (latest?.token === state.token) await save(statePath, { ...latest, phase: "stopped", error: null });
    console.log(JSON.stringify(await status(), null, 2));
    return;
  }
  await enrolled();
  await Promise.all([...Object.values(entries), join(repo, "apps/app/dist/index.html"), join(repo, "apps/host-daemon/dist/bb"), join(repo, "apps/host-daemon/dist/bb-plugin-host-worker.mjs"), join(repo, "apps/host-daemon/dist/bb-provider-bridge-worker.mjs")].map(requireFile));
  const sqliteAddon = join(repo, "packages/db/node_modules/better-sqlite3/build/Release/better_sqlite3.node");
  await requireFile(sqliteAddon);
  await exec(settings.node, ["-e", "require(process.argv[1])", sqliteAddon], { env: runtimeEnv() });
  const release = await lockLaunch();
  try {
    const current = await status();
    if (current.supervisor || Object.values(current.services).some((service) => service.managed || service.listening)) throw new Error("A runtime or occupied port exists. Inspect status; no service was stopped or adopted.");
    const token = randomUUID();
    await save(statePath, { token, marker: `--personal-os-runtime-owner=${token}`, phase: "starting", error: null });
    const supervisor = spawn(settings.node, [script, "supervise", token], { cwd: repo, env: runtimeEnv(), detached: true, stdio: "ignore" });
    supervisor.unref();
    for (let count = 0; count < 180; count += 1) {
      const state = await json(statePath);
      if (state?.token !== token) throw new Error("Launch ownership changed.");
      if (state.phase === "running") { console.log(JSON.stringify(await status(), null, 2)); return; }
      if (["failed", "stop_failed", "stopped"].includes(state.phase)) throw new Error(state.error ?? "Runtime stopped during launch.");
      await sleep(400);
    }
    throw new Error("Startup still pending. Inspect status; do not repeat start blindly.");
  } finally {
    await release();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
