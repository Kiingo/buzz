import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

// Failure-only custody of the existing audiopus build, never a compiler probe.
// No paths, arguments, environment, file text or content hashes leave this reader.
const expectedWorkspace = "C:\\KiingoRunner\\_work\\buzz\\buzz";
const roots = [
  "target/debug/build",
  "target/x86_64-pc-windows-msvc/debug/build",
  "desktop/src-tauri/target/debug/build",
  "desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/build",
];
const codeAllowlist = new Set([
  "MSB4018",
  "MSB4019",
  "MSB4236",
  "MSB6001",
  "MSB6003",
  "MSB6006",
  "MSB8003",
  "MSB8020",
  "MSB8036",
  "MSB8037",
  "MSB8040",
  "MSB8066",
  "C1034",
  "C1041",
  "C1083",
  "C1900",
  "C1902",
]);
// These public identifiers are fixed diagnostics, never values copied from a log.
const taskAllowlist = new Set([
  "SetEnv",
  "CL",
  "Link",
  "ResolveAssemblyReference",
  "ResolveSDKReference",
  "GetReferenceAssemblyPaths",
]);
const exceptionAllowlist = new Set([
  "System.NullReferenceException",
  "System.ArgumentNullException",
  "System.ArgumentException",
  "System.InvalidOperationException",
  "System.IO.FileNotFoundException",
  "System.IO.DirectoryNotFoundException",
  "System.IO.IOException",
  "System.UnauthorizedAccessException",
  "System.TypeLoadException",
  "System.TypeInitializationException",
  "System.DllNotFoundException",
  "System.BadImageFormatException",
  "System.Security.SecurityException",
  "System.ComponentModel.Win32Exception",
  "System.Runtime.InteropServices.COMException",
]);
const patterns = {
  msvc_toolset_unavailable: /MSB8020|MSB8003/gu,
  windows_sdk_unavailable: /MSB8036|MSB8037/gu,
  compiler_header_unavailable: /(?:fatal error|error)\s+C1083\b/gu,
  compiler_include_environment_missing: /(?:fatal error|error)\s+C1034\b/gu,
  msbuild_import_unavailable: /MSB4019|MSB4236/gu,
  msbuild_task_failure: /MSB4018|MSB6001|MSB6003|MSB6006/gu,
  compiler_database_failure:
    /(?:fatal error|error)\s+(?:C1041|C1900|C1902)\b/gu,
  compiler_not_found:
    /No CMAKE_(?:C|CXX)_COMPILER could be found|not a full path and was not found in the PATH/gu,
  compiler_identification_unknown:
    /(?:C|CXX) compiler identification is unknown/gu,
  compiler_identification_build_failed:
    /Compiling the (?:C|CXX) compiler identification source file.*failed/gu,
  compiler_simple_compile_failed:
    /is not able to compile a simple test program/gu,
  visual_studio_instance_unavailable:
    /could not find any instance of Visual Studio/giu,
  compiler_permission_failure: /Permission denied|Access is denied/giu,
  compiler_process_launch_failure:
    /The system cannot find the (?:file|path) specified|CreateProcess failed/giu,
};
class ReadRefusal extends Error {}
const normalize = (value) =>
  path.win32
    .normalize(value)
    .replace(/^\\\\\?\\/u, "")
    .toLowerCase();
const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino && a.ino > 0n;
const started = performance.now();
const deadline = () => {
  if (performance.now() - started > 5000) throw new ReadRefusal("deadline");
};
const receipt = {
  kind: "kiingo-windows-cmake-failure-custody",
  schemaVersion: 2,
  sourceSha: /^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "")
    ? process.env.GITHUB_SHA
    : null,
  runId: /^[0-9]{1,14}$/u.test(process.env.GITHUB_RUN_ID ?? "")
    ? process.env.GITHUB_RUN_ID
    : null,
  attempt: /^[1-9][0-9]{0,5}$/u.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
    ? process.env.GITHUB_RUN_ATTEMPT
    : null,
  scopeQualified: false,
  scanComplete: false,
  readOutcome: "unknown",
  directoriesInspected: 0,
  entriesInspected: 0,
  filesRead: 0,
  bytesRead: 0,
  codeCounts: {},
  categoryCounts: {},
  unrecognizedCodeCount: 0,
  taskCounts: {},
  exceptionCounts: {},
  unrecognizedTaskCount: 0,
  unrecognizedExceptionCount: 0,
  taskSubtypeOutcome: "unknown",
  exceptionSubtypeOutcome: "unknown",
  rawOutputRetained: false,
  compilerQualified: false,
  operatorMutation: false,
};

// lstat every component and compare canonical paths before and after reads.
// Missing conventional build directories/logs are explicit absence; permission,
// reparse, identity and deadline uncertainties never become successful scans.
function chain(relative, file = false) {
  const parts = relative.split("/").filter(Boolean);
  let current = expectedWorkspace;
  const records = [];
  for (const segment of ["", ...parts]) {
    deadline();
    if (segment) current = path.join(current, segment);
    let info;
    try {
      info = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        stable(records);
        return null;
      }
      throw new ReadRefusal("native_read_unavailable");
    }
    const last = current === path.join(expectedWorkspace, ...parts);
    if (
      info.isSymbolicLink() ||
      (file && last ? !info.isFile() : !info.isDirectory()) ||
      info.ino <= 0n
    ) {
      throw new ReadRefusal("path_unqualified");
    }
    if (normalize(fs.realpathSync.native(current)) !== normalize(current))
      throw new ReadRefusal("path_unqualified");
    records.push({ location: current, info });
  }
  return records;
}
function stable(records) {
  for (const { location, info } of records) {
    deadline();
    const now = fs.lstatSync(location, { bigint: true });
    if (
      now.isSymbolicLink() ||
      !sameObject(info, now) ||
      normalize(fs.realpathSync.native(location)) !== normalize(location)
    ) {
      throw new ReadRefusal("path_changed");
    }
  }
}
function readLog(relative) {
  const records = chain(relative, true);
  if (!records) return;
  const before = records.at(-1).info;
  if (
    before.nlink !== 1n ||
    before.size > 262144n ||
    receipt.filesRead >= 8 ||
    receipt.bytesRead + Number(before.size) > 1048576
  ) {
    throw new ReadRefusal("read_bound");
  }
  const location = path.join(expectedWorkspace, ...relative.split("/"));
  let descriptor;
  try {
    descriptor = fs.openSync(
      location,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameObject(before, opened) ||
      before.size !== opened.size ||
      before.mtimeNs !== opened.mtimeNs
    ) {
      throw new ReadRefusal("path_changed");
    }
    stable(records);
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      deadline();
      const count = fs.readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (count === 0) throw new ReadRefusal("path_changed");
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !sameObject(opened, after) ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs
    )
      throw new ReadRefusal("path_changed");
    stable(records);
    const text = buffer.toString("utf8");
    const categories = {};
    for (const [name, pattern] of Object.entries(patterns))
      categories[name] = [...text.matchAll(pattern)].length;
    const codes = [...text.matchAll(/\b(MSB[0-9]{4}|C[0-9]{4})\b/gu)].map(
      (match) => match[1],
    );
    for (const code of codes) {
      if (codeAllowlist.has(code))
        receipt.codeCounts[code] = (receipt.codeCounts[code] ?? 0) + 1;
      else receipt.unrecognizedCodeCount += 1;
    }
    for (const [name, count] of Object.entries(categories))
      if (count)
        receipt.categoryCounts[name] =
          (receipt.categoryCounts[name] ?? 0) + count;
    // Classify only the already bounded, identity-qualified ConfigureLog bytes.
    // Unknown identifiers contribute a count; their text is never retained.
    for (const match of text.matchAll(
      /\bThe \\?["']([A-Za-z_][A-Za-z0-9_.]{0,99})\\?["'] task failed unexpectedly(?:\.|$)/gmu,
    )) {
      deadline();
      const task = match[1];
      if (taskAllowlist.has(task))
        receipt.taskCounts[task] = (receipt.taskCounts[task] ?? 0) + 1;
      else receipt.unrecognizedTaskCount += 1;
    }
    for (const match of text.matchAll(
      /\b(System(?:\.[A-Za-z_][A-Za-z0-9_]{0,39}){0,4}\.[A-Za-z_][A-Za-z0-9_]{0,39}Exception)\b/gu,
    )) {
      deadline();
      const exception = match[1];
      if (exceptionAllowlist.has(exception))
        receipt.exceptionCounts[exception] =
          (receipt.exceptionCounts[exception] ?? 0) + 1;
      else receipt.unrecognizedExceptionCount += 1;
    }
    receipt.filesRead += 1;
    receipt.bytesRead += buffer.length;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

try {
  if (
    process.argv.length !== 2 ||
    process.platform !== "win32" ||
    process.env.GITHUB_REPOSITORY !== "Kiingo/buzz" ||
    process.env.GITHUB_JOB !== "windows-rust" ||
    process.env.RUNNER_OS !== "Windows" ||
    normalize(process.env.GITHUB_WORKSPACE ?? "") !==
      normalize(expectedWorkspace) ||
    receipt.sourceSha === null ||
    receipt.runId === null ||
    receipt.attempt === null
  )
    throw new ReadRefusal("context_unqualified");
  if (
    process.env.CARGO_TARGET_DIR &&
    !["target", "desktop/src-tauri/target"].some(
      (relative) =>
        normalize(
          path.resolve(expectedWorkspace, process.env.CARGO_TARGET_DIR),
        ) === normalize(path.join(expectedWorkspace, relative)),
    )
  ) {
    throw new ReadRefusal("target_directory_unqualified");
  }
  const workspace = chain("");
  if (!workspace) throw new ReadRefusal("context_unqualified");
  receipt.scopeQualified = true;
  for (const root of roots) {
    deadline();
    const records = chain(root);
    if (!records) continue;
    const directory = fs.opendirSync(
      path.join(expectedWorkspace, ...root.split("/")),
    );
    try {
      let count = 0;
      let entry;
      while ((entry = directory.readSync()) !== null) {
        deadline();
        if (++count > 512) throw new ReadRefusal("read_bound");
        receipt.entriesInspected += 1;
        if (!/^audiopus_sys-[a-f0-9]{16}$/u.test(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new ReadRefusal("path_unqualified");
        readLog(
          `${root}/${entry.name}/out/build/CMakeFiles/CMakeConfigureLog.yaml`,
        );
      }
    } finally {
      directory.closeSync();
    }
    stable(records);
    receipt.directoriesInspected += 1;
  }
  stable(workspace);
  receipt.scanComplete = true;
  receipt.readOutcome = receipt.filesRead
    ? "closed_categories_observed"
    : "known_logs_absent";
} catch (error) {
  receipt.readOutcome =
    error instanceof ReadRefusal ? error.message : "native_read_unavailable";
}
function subtypeOutcome(counts, unknownCount) {
  if (!receipt.scanComplete) return "incomplete";
  if (!Object.keys(counts).length) return "unknown";
  return unknownCount ? "allowlisted_and_unknown" : "allowlisted_observed";
}
receipt.taskSubtypeOutcome = subtypeOutcome(
  receipt.taskCounts,
  receipt.unrecognizedTaskCount,
);
receipt.exceptionSubtypeOutcome = subtypeOutcome(
  receipt.exceptionCounts,
  receipt.unrecognizedExceptionCount,
);
// The compile step already owns its exit/conclusion. Diagnostics never make a
// failed compiler successful and cannot grant source/image/compiler custody.
process.stdout.write(
  `Kiingo Windows CMake failure custody ${JSON.stringify(receipt)}\n`,
);
