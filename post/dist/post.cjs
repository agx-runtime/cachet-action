// action/post/src/post.ts
var import_promises2 = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path3 = require("node:path");

// src/core/constants.ts
var NIX_STORE_DIR = "/nix/store";
var NIX_BASE32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
var STORE_PATH_HASH_LENGTH = 32;
var NAR_FILE_HASH_LENGTH = 52;
var STORE_PATH_NAME_BYTES_MAX = 211;
var NAR_SUFFIX_BY_COMPRESSION = {
  none: "",
  xz: ".xz",
  zstd: ".zst",
  bzip2: ".bz2",
  gzip: ".gz",
  br: ".br",
  lzip: ".lzip",
  lz4: ".lz4"
};
var ROOTS_PATHS_MAX = 4096;
var UPLOAD_SINGLE_MAX_BYTES = 94371840;
var UPLOAD_PART_BYTES = 67108864;
var MULTIPART_PARTS_MAX = 1000;
var UPLOAD_STALE_MAX_DAYS = 7;
var UPLOAD_RETRY_MAX = 3;
var UPLOAD_RETRY_BASE_DELAY_MS = 500;
var PUSH_PATHS_MAX = ROOTS_PATHS_MAX;
var FILTER_CONCURRENCY_MAX = 16;
var GRACE_WINDOW_DAYS = 14;
var LEASE_RETENTION_DAYS = 30;
var GC_RUNS_RETENTION_DAYS = 30;
var NAR_KEY_PREFIX = "nar/";
var UPLOAD_TOTAL_BYTES_HEADER = "x-cachet-upload-bytes";
var MILLIS_PER_DAY = 86400000;
var GRACE_WINDOW_MS = GRACE_WINDOW_DAYS * MILLIS_PER_DAY;
var LEASE_RETENTION_MS = LEASE_RETENTION_DAYS * MILLIS_PER_DAY;
var UPLOAD_STALE_MAX_MS = UPLOAD_STALE_MAX_DAYS * MILLIS_PER_DAY;
var GC_RUNS_RETENTION_MS = GC_RUNS_RETENTION_DAYS * MILLIS_PER_DAY;

// action/post/src/core/result.ts
function ok(value) {
  return { ok: true, value };
}
function fail(message) {
  return { ok: false, message };
}

// action/post/src/core/diff.ts
function parseSnapshot(text) {
  return text.split(`
`).map((line) => line.trim()).filter((line) => line.length > 0);
}
function storeDiff(before, after) {
  const seen = new Set(before);
  const added = [];
  for (const path of after) {
    if (!seen.has(path)) {
      seen.add(path);
      added.push(path);
    }
  }
  return added;
}
function boundCandidates(paths) {
  if (paths.length > PUSH_PATHS_MAX) {
    return fail(`this job added ${String(paths.length)} store paths, more than the ${String(PUSH_PATHS_MAX)} cap`);
  }
  return ok(paths);
}

// action/post/src/core/inputs.ts
var UPSTREAM_URL_DEFAULT = "https://cache.nixos.org";
function readInputs(env) {
  return {
    cacheUrl: env["CACHET_CACHE_URL"] ?? "",
    audience: env["CACHET_AUDIENCE"] ?? "",
    project: env["CACHET_PROJECT"] ?? "",
    upstreamUrl: env["CACHET_UPSTREAM_URL"] ?? UPSTREAM_URL_DEFAULT,
    signingKeyFile: env["CACHET_SIGNING_KEY_FILE"] ?? "",
    rootInstallables: (env["CACHET_ROOTS"] ?? "").split(/\s+/).filter((e) => e.length > 0),
    isDefaultBranch: isSameRef(env["GITHUB_REF"], env["CACHET_DEFAULT_BRANCH_REF"]),
    push: (env["CACHET_PUSH"] ?? "true") !== "false"
  };
}
function isSameRef(actual, expected) {
  if (actual === undefined || expected === undefined) {
    return false;
  }
  if (actual.length === 0 || expected.length === 0) {
    return false;
  }
  return actual === expected;
}
function missingInputs(inputs) {
  return [
    inputs.cacheUrl.length === 0 ? "CACHET_CACHE_URL" : undefined,
    inputs.project.length === 0 ? "CACHET_PROJECT" : undefined,
    inputs.audience.length === 0 ? "CACHET_AUDIENCE" : undefined
  ].filter((name) => name !== undefined);
}
function missingInputsMessage(missing) {
  return `cachet: nothing pushed, because ${missing.join(", ")} ` + `${missing.length === 1 ? "is" : "are"} unset. The cachet-setup composite action exports these ` + `to the job environment; if you are running the post action directly, set them yourself.
`;
}

// action/post/src/snapshot-path.ts
var import_node_path = require("node:path");
function snapshotPath(env) {
  return import_node_path.join(env["RUNNER_TEMP"] ?? "/tmp", "cachet-store-before.txt");
}

// src/core/result.ts
var STATUS_BY_CODE = {
  malformed_key: 400,
  malformed_narinfo: 400,
  malformed_roots: 400,
  malformed_auth: 400,
  part_number_invalid: 400,
  part_size_mismatch: 400,
  complete_parts_mismatch: 400,
  unauthorized: 401,
  forbidden_org: 403,
  forbidden_ref: 403,
  not_found: 404,
  upload_unknown: 404,
  narinfo_nar_missing: 409,
  length_required: 411,
  body_too_large: 413,
  auth_unavailable: 503,
  storage_unavailable: 503
};

class ClientError extends Error {
  status;
  code;
  constructor(code, message) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
function ok2(value) {
  return { ok: true, value };
}
function err(error) {
  return { ok: false, error };
}
function fail2(code, message) {
  return err(new ClientError(code, message));
}

// src/core/assert.ts
class CachetInvariantError extends Error {
  constructor(message) {
    super(`invariant violated: ${message}`);
    this.name = "CachetInvariantError";
  }
}
function assert(condition, message) {
  if (!condition) {
    throw new CachetInvariantError(message);
  }
}

// src/core/types.ts
assert(NIX_BASE32_ALPHABET.length === 32, "the Nix base-32 alphabet has exactly 32 symbols");
assert(/^[0-9a-z]+$/.test(NIX_BASE32_ALPHABET), "the Nix base-32 alphabet is alphanumeric — safe in a character class");
var STORE_PATH_HASH_PATTERN = new RegExp(`^[${NIX_BASE32_ALPHABET}]{${String(STORE_PATH_HASH_LENGTH)}}$`);
function parseStorePathHash(text) {
  if (text.length !== STORE_PATH_HASH_LENGTH) {
    return fail2("malformed_key", `a store-path hash is exactly ${String(STORE_PATH_HASH_LENGTH)} characters`);
  }
  if (!STORE_PATH_HASH_PATTERN.test(text)) {
    return fail2("malformed_key", "a store-path hash uses only the Nix base-32 alphabet");
  }
  return ok2(text);
}
function generation(value) {
  assert(Number.isSafeInteger(value), "a generation is a safe integer");
  assert(value >= 0, "a generation is not negative");
  return value;
}
var GENERATION_ZERO = generation(0);

// src/core/wire/keys.ts
function escapeForPattern(literal) {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var NAR_KEY_PATTERN = (() => {
  const suffixes = Object.values(NAR_SUFFIX_BY_COMPRESSION).filter((suffix) => suffix.length > 0).map(escapeForPattern);
  const alphabet = `[${NIX_BASE32_ALPHABET}]`;
  return new RegExp(`^${escapeForPattern(NAR_KEY_PREFIX)}${alphabet}{${String(NAR_FILE_HASH_LENGTH)}}\\.nar(?:${suffixes.join("|")})?$`);
})();
var STORE_PATH_NAME_PATTERN = /^[a-zA-Z0-9+._?=-]+$/;
function parseStorePath(text) {
  const prefix = `${NIX_STORE_DIR}/`;
  if (text.length > prefix.length + STORE_PATH_HASH_LENGTH + 1 + STORE_PATH_NAME_BYTES_MAX) {
    return fail2("malformed_key", "a store path is longer than any Nix store path can be");
  }
  if (!text.startsWith(prefix)) {
    return fail2("malformed_key", `a store path begins with ${prefix}`);
  }
  const basename = text.slice(prefix.length);
  if (basename.includes("/")) {
    return fail2("malformed_key", "a store path has no path separator after the store directory");
  }
  return parseStorePathBasename(basename);
}
function parseStorePathBasename(basename) {
  if (basename.length < STORE_PATH_HASH_LENGTH + 2) {
    return fail2("malformed_key", "a store path basename is <hash>-<name>");
  }
  const separator = basename[STORE_PATH_HASH_LENGTH];
  if (separator !== "-") {
    return fail2("malformed_key", "a store path basename separates hash and name with a dash");
  }
  const hash = parseStorePathHash(basename.slice(0, STORE_PATH_HASH_LENGTH));
  if (!hash.ok) {
    return hash;
  }
  const name = basename.slice(STORE_PATH_HASH_LENGTH + 1);
  if (name.length > STORE_PATH_NAME_BYTES_MAX) {
    return fail2("malformed_key", `a store path name exceeds ${String(STORE_PATH_NAME_BYTES_MAX)} bytes`);
  }
  if (!STORE_PATH_NAME_PATTERN.test(name)) {
    return fail2("malformed_key", "a store path name uses only letters, digits, and +-._?=");
  }
  return ok2({ hash: hash.value, name });
}

// action/post/src/core/filter.ts
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;; ) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}
async function filterAgainstUpstream(candidates, rootPaths, probe) {
  const roots = new Set(rootPaths);
  const rootCandidates = candidates.filter((path) => roots.has(path));
  const probeable = candidates.filter((path) => !roots.has(path));
  const answers = await mapWithConcurrency(probeable, FILTER_CONCURRENCY_MAX, async (path) => {
    const parsed = parseStorePath(path);
    if (!parsed.ok) {
      return { path, hasIt: undefined };
    }
    return { path, hasIt: await probe(String(parsed.value.hash)) };
  });
  const toPush = [...rootCandidates];
  const upstreamHits = [];
  let probeFailures = 0;
  for (const answer of answers) {
    if (answer.hasIt === true) {
      upstreamHits.push(answer.path);
      continue;
    }
    if (answer.hasIt === undefined) {
      probeFailures += 1;
    }
    toPush.push(answer.path);
  }
  return { toPush, upstreamHits, probeFailures, rootsKept: rootCandidates.length };
}

// src/core/routes/multipart.ts
function planParts(totalBytes) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return fail2("body_too_large", "a multipart upload declares a positive total size");
  }
  const expectedParts = Math.ceil(totalBytes / UPLOAD_PART_BYTES);
  if (expectedParts > MULTIPART_PARTS_MAX) {
    return fail2("body_too_large", `an object of ${String(totalBytes)} bytes needs more than ${String(MULTIPART_PARTS_MAX)} parts`);
  }
  const finalPartBytes = totalBytes - (expectedParts - 1) * UPLOAD_PART_BYTES;
  assert(finalPartBytes > 0, "the final part carries at least one byte");
  assert(finalPartBytes <= UPLOAD_PART_BYTES, "the final part is no larger than a full part");
  return ok2({ expectedParts, finalPartBytes });
}

// action/post/src/core/upload-plan.ts
function planUpload(object) {
  if (object.sizeBytes < 0 || !Number.isSafeInteger(object.sizeBytes)) {
    return fail(`${object.key} has an implausible size`);
  }
  if (object.sizeBytes <= UPLOAD_SINGLE_MAX_BYTES) {
    return ok({ kind: "single", object });
  }
  const parts = planParts(object.sizeBytes);
  if (!parts.ok) {
    return fail(`${object.key} is too large to upload: ${parts.error.message}`);
  }
  return ok({
    kind: "multipart",
    object,
    expectedParts: parts.value.expectedParts,
    partBytes: UPLOAD_PART_BYTES,
    finalPartBytes: parts.value.finalPartBytes
  });
}
function uploadOrder(objects) {
  const nars = objects.filter((object) => object.kind === "nar");
  const narinfos = objects.filter((object) => object.kind === "narinfo");
  return [...nars, ...narinfos];
}

// action/post/src/real/host.ts
var import_node_child_process = require("node:child_process");
var import_promises = require("node:fs/promises");
var import_node_path2 = require("node:path");
var import_node_util = require("node:util");
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
async function readStagingDirectory(root) {
  const files = [];
  try {
    for (const entry of await import_promises.readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".narinfo")) {
        const filePath = import_node_path2.join(root, entry.name);
        files.push({
          key: entry.name,
          filePath,
          sizeBytes: (await import_promises.stat(filePath)).size,
          kind: "narinfo"
        });
      }
    }
    const narDirectory = import_node_path2.join(root, "nar");
    for (const entry of await import_promises.readdir(narDirectory, { withFileTypes: true })) {
      if (entry.isFile()) {
        const filePath = import_node_path2.join(narDirectory, entry.name);
        files.push({
          key: `nar/${import_node_path2.basename(entry.name)}`,
          filePath,
          sizeBytes: (await import_promises.stat(filePath)).size,
          kind: "nar"
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    return fail(`could not read the staging directory ${root}: ${message}`);
  }
  return ok(files);
}
async function readFileOrEmpty(filePath) {
  try {
    return await import_promises.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
async function readStagedFile(filePath) {
  try {
    return ok(await import_promises.readFile(filePath));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    return fail(`could not read ${filePath}: ${message}`);
  }
}
async function requestIdToken(audience, env) {
  const requestUrl = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const requestToken = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (requestUrl === undefined || requestToken === undefined) {
    return fail("no OIDC token request variables. Add `permissions: { id-token: write }` to the job.");
  }
  try {
    const response = await fetch(`${requestUrl}&audience=${encodeURIComponent(audience)}`, {
      headers: { Authorization: `Bearer ${requestToken}` }
    });
    if (!response.ok) {
      return fail(`the OIDC token request returned ${String(response.status)}`);
    }
    const body = await response.json();
    if (typeof body.value !== "string" || body.value.length === 0) {
      return fail("the OIDC token response carried no token");
    }
    return ok(body.value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    return fail(`the OIDC token request failed: ${message}`);
  }
}
async function probeUpstream(upstreamUrl, storePathHash) {
  try {
    const response = await fetch(`${upstreamUrl.replace(/\/+$/, "")}/${storePathHash}.narinfo`, {
      method: "HEAD"
    });
    if (response.status === 404) {
      return false;
    }
    if (response.ok) {
      return true;
    }
    return;
  } catch {
    return;
  }
}

// action/post/src/core/retry.ts
async function withRetries(what, attempt, sleep) {
  let last = "no attempt was made";
  for (let tries = 0;tries < UPLOAD_RETRY_MAX; tries += 1) {
    let result;
    try {
      result = await attempt();
    } catch (error) {
      result = fail(error instanceof Error ? error.message : String(error));
    }
    if (result.ok) {
      return result;
    }
    last = result.message;
    if (tries + 1 < UPLOAD_RETRY_MAX) {
      await sleep(UPLOAD_RETRY_BASE_DELAY_MS * (tries + 1));
    }
  }
  return fail(`${what} failed after ${String(UPLOAD_RETRY_MAX)} attempts: ${last}`);
}

// action/post/src/real/upload.ts
function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}
function objectUrl(target, key, query = "") {
  return `${target.cacheUrl.replace(/\/+$/, "")}/${key}${query}`;
}
var realSleep = (millis) => new Promise((resolve) => {
  setTimeout(resolve, millis);
});
async function putWhole(target, plan) {
  const bytes = await readStagedFile(plan.object.filePath);
  if (!bytes.ok) {
    return bytes;
  }
  return withRetriesUsingRealSleep(`PUT ${plan.object.key}`, async () => {
    const token = await target.mintToken();
    if (!token.ok) {
      return token;
    }
    const response = await fetch(objectUrl(target, plan.object.key), {
      method: "PUT",
      headers: authHeaders(token.value, { "Content-Length": String(plan.object.sizeBytes) }),
      body: new Uint8Array(bytes.value)
    });
    return response.ok ? ok(undefined) : fail(`${String(response.status)} ${await response.text()}`);
  });
}
async function beginUpload(target, plan) {
  return withRetriesUsingRealSleep(`begin ${plan.object.key}`, async () => {
    const token = await target.mintToken();
    if (!token.ok) {
      return token;
    }
    const response = await fetch(objectUrl(target, plan.object.key, "?uploads"), {
      method: "POST",
      headers: authHeaders(token.value, {
        [UPLOAD_TOTAL_BYTES_HEADER]: String(plan.object.sizeBytes)
      })
    });
    if (!response.ok) {
      return fail(`${String(response.status)} ${await response.text()}`);
    }
    return ok(await response.json());
  });
}
async function uploadOnePart(target, plan, uploadId, partNumber, bytes) {
  const offset = (partNumber - 1) * plan.partBytes;
  const length = partNumber === plan.expectedParts ? plan.finalPartBytes : plan.partBytes;
  const slice = new Uint8Array(bytes.subarray(offset, offset + length));
  const query = `?uploadId=${uploadId}&partNumber=${String(partNumber)}`;
  return withRetriesUsingRealSleep(`part ${String(partNumber)} of ${plan.object.key}`, async () => {
    const token = await target.mintToken();
    if (!token.ok) {
      return token;
    }
    const response = await fetch(objectUrl(target, plan.object.key, query), {
      method: "PUT",
      headers: authHeaders(token.value, { "Content-Length": String(length) }),
      body: slice
    });
    if (!response.ok) {
      return fail(`${String(response.status)} ${await response.text()}`);
    }
    return ok(await response.json());
  });
}
async function completeUpload(target, plan, uploadId, parts) {
  return withRetriesUsingRealSleep(`complete ${plan.object.key}`, async () => {
    const token = await target.mintToken();
    if (!token.ok) {
      return token;
    }
    const response = await fetch(objectUrl(target, plan.object.key, `?uploadId=${uploadId}`), {
      method: "POST",
      headers: authHeaders(token.value, { "Content-Type": "application/json" }),
      body: JSON.stringify(parts)
    });
    return response.ok ? ok(undefined) : fail(`${String(response.status)} ${await response.text()}`);
  });
}
async function abortUpload(target, plan, uploadId) {
  const token = await target.mintToken();
  if (!token.ok) {
    return;
  }
  await fetch(objectUrl(target, plan.object.key, `?uploadId=${uploadId}`), {
    method: "DELETE",
    headers: authHeaders(token.value)
  }).catch(() => {
    return;
  });
}
async function putInParts(target, plan) {
  const bytes = await readStagedFile(plan.object.filePath);
  if (!bytes.ok) {
    return bytes;
  }
  const created = await beginUpload(target, plan);
  if (!created.ok) {
    return created;
  }
  const { uploadId } = created.value;
  const parts = [];
  for (let partNumber = 1;partNumber <= plan.expectedParts; partNumber += 1) {
    const sent = await uploadOnePart(target, plan, uploadId, partNumber, bytes.value);
    if (!sent.ok) {
      await abortUpload(target, plan, uploadId);
      return sent;
    }
    parts.push(sent.value);
  }
  return completeUpload(target, plan, uploadId, parts);
}
async function uploadObject(target, plan) {
  return plan.kind === "single" ? putWhole(target, plan) : putInParts(target, plan);
}
async function postRoots(target, project, storePaths, installables) {
  return withRetriesUsingRealSleep(`renew the lease for ${project}`, async () => {
    const token = await target.mintToken();
    if (!token.ok) {
      return token;
    }
    const response = await fetch(`${target.cacheUrl.replace(/\/+$/, "")}/roots/${project}`, {
      method: "POST",
      headers: authHeaders(token.value, { "Content-Type": "application/json" }),
      body: JSON.stringify({ storePaths, installables })
    });
    return response.ok ? ok(undefined) : fail(`${String(response.status)} ${await response.text()}`);
  });
}
function withRetriesUsingRealSleep(what, attempt) {
  return withRetries(what, attempt, realSleep);
}

// action/post/src/post.ts
async function resolveRootPaths(installables) {
  const paths = [];
  for (const installable of installables) {
    const resolved = await run(["nix", "path-info", installable]);
    if (resolved.ok) {
      paths.push(...parseSnapshot(resolved.value));
    } else {
      process.stderr.write(`cachet: could not resolve ${installable}; it will not be a lease root
`);
    }
  }
  return paths;
}
async function stageAndUpload(inputs, target, paths) {
  const stagingRoot = await import_promises2.mkdtemp(import_node_path3.join(import_node_os.tmpdir(), "cachet-staging-"));
  const destination = `file://${stagingRoot}?compression=zstd&secret-key=${inputs.signingKeyFile}`;
  const staged = await run(["nix", "copy", "--to", destination, ...paths]);
  if (!staged.ok) {
    return staged;
  }
  const files = await readStagingDirectory(stagingRoot);
  if (!files.ok) {
    return files;
  }
  let uploaded = 0;
  for (const object of uploadOrder(files.value)) {
    const plan = planUpload(object);
    if (!plan.ok) {
      return plan;
    }
    const sent = await uploadObject(target, plan.value);
    if (!sent.ok) {
      return sent;
    }
    uploaded += 1;
  }
  return ok(uploaded);
}
async function push(inputs) {
  const before = parseSnapshot(await readFileOrEmpty(snapshotPath(process.env)));
  const afterOutput = await run(["nix", "path-info", "--all"]);
  if (!afterOutput.ok) {
    process.stderr.write(`cachet: ${afterOutput.message}
`);
    return;
  }
  const candidates = boundCandidates(storeDiff(before, parseSnapshot(afterOutput.value)));
  if (!candidates.ok) {
    process.stderr.write(`cachet: ${candidates.message}
`);
    return;
  }
  if (candidates.value.length === 0) {
    process.stdout.write(`cachet: the job added nothing to the store
`);
    return;
  }
  const rootPaths = await resolveRootPaths(inputs.rootInstallables);
  const filtered = await filterAgainstUpstream(candidates.value, rootPaths, (hash) => probeUpstream(inputs.upstreamUrl, hash));
  process.stdout.write(`cachet: ${String(filtered.toPush.length)} to push, ${String(filtered.upstreamHits.length)} already upstream` + `${filtered.probeFailures > 0 ? `, ${String(filtered.probeFailures)} probes failed (kept)` : ""}
`);
  if (filtered.toPush.length === 0) {
    return;
  }
  const probe = await requestIdToken(inputs.audience, process.env);
  if (!probe.ok) {
    process.stderr.write(`cachet: ${probe.message}
`);
    return;
  }
  const target = {
    cacheUrl: inputs.cacheUrl,
    mintToken: () => requestIdToken(inputs.audience, process.env)
  };
  const uploaded = await stageAndUpload(inputs, target, filtered.toPush);
  if (!uploaded.ok) {
    process.stderr.write(`cachet: ${uploaded.message}
`);
    return;
  }
  process.stdout.write(`cachet: uploaded ${String(uploaded.value)} objects
`);
  if (!inputs.isDefaultBranch) {
    process.stdout.write(`cachet: not the default branch, so the lease is not renewed
`);
    return;
  }
  const renewed = await postRoots(target, inputs.project, rootPaths, inputs.rootInstallables);
  if (!renewed.ok) {
    process.stderr.write(`cachet: ${renewed.message}
`);
    return;
  }
  process.stdout.write(`cachet: lease renewed for ${inputs.project}
`);
}
async function pushIfConfigured() {
  const inputs = readInputs(process.env);
  if (!inputs.push) {
    process.stdout.write(`cachet: pushing is disabled for this job
`);
    return;
  }
  const missing = missingInputs(inputs);
  if (missing.length > 0) {
    process.stderr.write(missingInputsMessage(missing));
    return;
  }
  await push(inputs);
}
pushIfConfigured().catch((error) => {
  process.stderr.write(`cachet: the push failed unexpectedly: ${String(error)}
`);
});
