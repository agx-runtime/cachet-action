// action/post/src/main.ts
var import_promises = require("node:fs/promises");

// action/post/src/snapshot-path.ts
var import_node_path = require("node:path");
function snapshotPath(env) {
  return import_node_path.join(env["RUNNER_TEMP"] ?? "/tmp", "cachet-store-before.txt");
}

// action/post/src/real/host.ts
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");

// action/post/src/core/result.ts
function ok(value) {
  return { ok: true, value };
}
function fail(message) {
  return { ok: false, message };
}

// action/post/src/real/host.ts
var execFileAsync = import_node_util.promisify(import_node_child_process.execFile);
async function run(argv, options = {}) {
  const [command, ...args] = argv;
  if (command === undefined) {
    return fail("an empty command");
  }
  try {
    const { stdout } = await execFileAsync(command, args, {
      maxBuffer: 256 * 1024 * 1024,
      ...options
    });
    return ok(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    return fail(`${argv.join(" ")} failed: ${message}`);
  }
}

// action/post/src/main.ts
async function main() {
  const snapshot = await run(["nix", "path-info", "--all"]);
  if (!snapshot.ok) {
    process.stderr.write(`cachet: could not snapshot the store — nothing will be pushed. ${snapshot.message}
`);
    return;
  }
  await import_promises.writeFile(snapshotPath(process.env), snapshot.value, "utf8");
  process.stdout.write(`cachet: store snapshot taken
`);
}
main().catch((error) => {
  process.stderr.write(`cachet: the snapshot step failed unexpectedly: ${String(error)}
`);
});
