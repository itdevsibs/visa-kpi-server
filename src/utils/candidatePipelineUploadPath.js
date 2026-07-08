import fs from "fs";
import path from "path";
import os from "os";

function cleanText(value) {
  return String(value ?? "").trim();
}

function isWindowsRuntime() {
  const forcedOs = cleanText(process.env.SMB_FORCE_OS).toLowerCase();

  if (forcedOs === "windows") return true;
  if (forcedOs === "linux") return false;

  return process.platform === "win32";
}

function normalizeSlashes(value = "") {
  return cleanText(value).replace(/\\/g, "/").replace(/\/+$/g, "");
}

function hasWindowsRoot(value = "") {
  const text = cleanText(value);

  return (
    text.startsWith("//") ||
    text.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

function hasLinuxRoot(value = "") {
  const text = cleanText(value);

  return text.startsWith("/") && !text.startsWith("//");
}

function toWindowsUncPath(value = "") {
  const text = cleanText(value);

  if (!text) return "";

  if (text.startsWith("\\\\")) return text;

  if (text.startsWith("//")) {
    return text.replace(/\//g, "\\");
  }

  return text;
}

function toWindowsForwardUncPath(value = "") {
  const text = cleanText(value);

  if (!text) return "";

  if (text.startsWith("\\\\")) {
    return text.replace(/\\/g, "/");
  }

  return text.replace(/\\/g, "/");
}

function getSmbHost() {
  return cleanText(process.env.SMB_HOST) || "172.18.7.154";
}

function getSmbShare() {
  return cleanText(process.env.SMB_SHARE) || "web-dev";
}

function getWindowsSmbBasePath() {
  return (
    normalizeSlashes(process.env.SMB_WINDOWS_SERVER_PATH) ||
    `//${getSmbHost()}/${getSmbShare()}`
  );
}

function getLinuxSmbBasePath() {
  return normalizeSlashes(process.env.SMB_LINUX_SERVER_PATH) || "/mnt/smb_files/web-dev";
}

function getHrisRootFolder() {
  return cleanText(process.env.SMB_HRIS_ROOT_FOLDER) || "SiBS HRIS";
}

function getCandidatePipelineFolderName() {
  return (
    cleanText(process.env.SMB_CANDIDATE_PIPELINE_PATH) ||
    cleanText(process.env.CANDIDATE_PIPELINE_FOLDER_NAME) ||
    "Candidate-Pipeline"
  );
}

function convertLinuxSmbPathToWindowsPath(value = "") {
  const manualRoot = normalizeSlashes(value);
  const linuxBase = getLinuxSmbBasePath();
  const windowsBase = getWindowsSmbBasePath();

  if (!manualRoot || !manualRoot.startsWith(linuxBase)) {
    return "";
  }

  const relativePath = manualRoot.slice(linuxBase.length).replace(/^\/+/, "");

  return normalizeSlashes(`${windowsBase}/${relativePath}`);
}

function convertWindowsSmbPathToLinuxPath(value = "") {
  const manualRoot = normalizeSlashes(value);
  const windowsBase = getWindowsSmbBasePath();
  const linuxBase = getLinuxSmbBasePath();

  if (!manualRoot || !manualRoot.startsWith(windowsBase)) {
    return "";
  }

  const relativePath = manualRoot.slice(windowsBase.length).replace(/^\/+/, "");

  return normalizeSlashes(`${linuxBase}/${relativePath}`);
}

function getManualCandidatePipelineRoot() {
  const manualRoot = normalizeSlashes(process.env.CANDIDATE_PIPELINE_UPLOAD_ROOT);

  if (!manualRoot) return "";

  if (isWindowsRuntime()) {
    if (hasWindowsRoot(manualRoot)) {
      return manualRoot;
    }

    const convertedRoot = convertLinuxSmbPathToWindowsPath(manualRoot);

    if (convertedRoot) {
      console.warn(
        `[CandidatePipelineUploadPath] Converted Linux SMB root to Windows SMB root: ${convertedRoot}`,
      );

      return convertedRoot;
    }

    console.warn(
      `[CandidatePipelineUploadPath] Ignored incompatible CANDIDATE_PIPELINE_UPLOAD_ROOT for Windows runtime: ${manualRoot}`,
    );

    return "";
  }

  if (hasLinuxRoot(manualRoot)) {
    return manualRoot;
  }

  const convertedRoot = convertWindowsSmbPathToLinuxPath(manualRoot);

  if (convertedRoot) {
    console.warn(
      `[CandidatePipelineUploadPath] Converted Windows SMB root to Linux SMB root: ${convertedRoot}`,
    );

    return convertedRoot;
  }

  console.warn(
    `[CandidatePipelineUploadPath] Ignored incompatible CANDIDATE_PIPELINE_UPLOAD_ROOT for Linux runtime: ${manualRoot}`,
  );

  return "";
}

function joinStoragePath(...parts) {
  const filteredParts = parts.map((part) => cleanText(part)).filter(Boolean);

  if (!filteredParts.length) return "";

  if (isWindowsRuntime()) {
    const [first, ...rest] = filteredParts;

    if (first.startsWith("//") || first.startsWith("\\\\")) {
      return path.win32.join(toWindowsUncPath(first), ...rest);
    }

    return path.win32.join(first, ...rest);
  }

  return path.posix.join(
    ...filteredParts.map((part) => part.replace(/\\/g, "/")),
  );
}

function safeFileName(filename = "file") {
  const ext = path.extname(filename || "");
  const base = path
    .basename(filename || "file", ext)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 90);

  return `${base || "file"}${ext}`;
}

function safeFolderPart(value = "UNKNOWN") {
  return cleanText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function normalizeNameToLastFirst(candidate = {}) {
  const firstName = cleanText(
    candidate.firstName ||
      candidate.first_name ||
      candidate.givenName ||
      candidate.given_name,
  );

  const middleName = cleanText(
    candidate.middleName ||
      candidate.middle_name ||
      candidate.middleInitial ||
      candidate.middle_initial,
  );

  const lastName = cleanText(
    candidate.lastName || candidate.last_name || candidate.surname,
  );

  if (lastName || firstName || middleName) {
    return `${lastName || "UNKNOWN"}, ${[firstName, middleName]
      .filter(Boolean)
      .join(" ")}`.toUpperCase();
  }

  const fullName = cleanText(
    candidate.fullName ||
      candidate.full_name ||
      candidate.name ||
      candidate.candidateName ||
      candidate.candidate_name,
  );

  if (!fullName) return "UNKNOWN APPLICANT";

  if (fullName.includes(",")) return fullName.toUpperCase();

  const parts = fullName.split(/\s+/).filter(Boolean);

  if (parts.length <= 1) return fullName.toUpperCase();

  const last = parts.pop();
  const firstMiddle = parts.join(" ");

  return `${last}, ${firstMiddle}`.toUpperCase();
}

function getRecordId(candidate = {}) {
  return (
    cleanText(candidate.recordId) ||
    cleanText(candidate.record_id) ||
    cleanText(candidate.sourceTalentPoolId) ||
    cleanText(candidate.source_talent_pool_id) ||
    cleanText(candidate.candidateApplicationId) ||
    cleanText(candidate.candidate_application_id) ||
    cleanText(candidate.applicationId) ||
    cleanText(candidate.application_id) ||
    cleanText(candidate.id) ||
    cleanText(candidate.candidateId) ||
    cleanText(candidate.candidate_id) ||
    "UNKNOWN"
  );
}

export function getCandidatePipelineUploadRoot() {
  const manualRoot = getManualCandidatePipelineRoot();

  if (manualRoot) {
    return joinStoragePath(manualRoot);
  }

  const basePath = isWindowsRuntime()
    ? getWindowsSmbBasePath()
    : getLinuxSmbBasePath();

  return joinStoragePath(
    basePath,
    getHrisRootFolder(),
    getCandidatePipelineFolderName(),
  );
}

export function getCandidatePipelineApplicantFolderName(candidate = {}) {
  const recordId = getRecordId(candidate);
  const name = normalizeNameToLastFirst(candidate);

  return safeFolderPart(`${recordId} - ${name}`);
}

export function getCandidatePipelineApplicantDir(candidate = {}) {
  return joinStoragePath(
    getCandidatePipelineUploadRoot(),
    getCandidatePipelineApplicantFolderName(candidate),
  );
}

export function ensureCandidatePipelineApplicantDir(candidate = {}) {
  const root = getCandidatePipelineUploadRoot();
  const applicantDir = getCandidatePipelineApplicantDir(candidate);

  if (!root) {
    throw new Error("Candidate Pipeline upload root is not configured.");
  }

  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  if (!fs.existsSync(applicantDir)) {
    fs.mkdirSync(applicantDir, { recursive: true });
  }

  return applicantDir;
}

function buildSavedFileName(prefix = "candidate_file", originalName = "file") {
  const now = new Date();

  const datePart = now
    .toLocaleString("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .replaceAll("-", "");

  const timePart = now
    .toLocaleString("en-GB", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replaceAll(":", "");

  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();

  return `${safeFileName(prefix)}_${datePart}${timePart}_${randomPart}_${safeFileName(
    originalName,
  )}`;
}

export function saveCandidatePipelineFileBuffer({
  file,
  candidate,
  prefix = "candidate_file",
}) {
  if (!file?.buffer) return null;

  const applicantDir = ensureCandidatePipelineApplicantDir(candidate);
  const originalName = file.originalname || file.originalName || "file";
  const finalName = buildSavedFileName(prefix, originalName);
  const storedPath = joinStoragePath(applicantDir, finalName);

  fs.writeFileSync(storedPath, file.buffer);

  return {
    originalName,
    filename: finalName,
    savedFileName: finalName,
    storedPath,
    filePath: storedPath,
    folderPath: applicantDir,
    applicantFolderName: path.basename(applicantDir),
    mimetype: file.mimetype || file.mimeType || "application/octet-stream",
    size: file.size || file.buffer.length,
  };
}

export function moveCandidatePipelineFileFromDisk({
  file,
  candidate,
  prefix = "candidate_file",
}) {
  if (!file?.path) return null;

  const applicantDir = ensureCandidatePipelineApplicantDir(candidate);
  const originalName = file.originalname || file.originalName || "file";
  const finalName = buildSavedFileName(prefix, originalName);
  const storedPath = joinStoragePath(applicantDir, finalName);

  fs.renameSync(file.path, storedPath);

  return {
    originalName,
    filename: finalName,
    savedFileName: finalName,
    storedPath,
    filePath: storedPath,
    folderPath: applicantDir,
    applicantFolderName: path.basename(applicantDir),
    mimetype: file.mimetype || file.mimeType || "application/octet-stream",
    size: file.size || 0,
  };
}

export function resolveCandidatePipelineStoredPath(storedPath = "") {
  const value = cleanText(storedPath);

  if (!value) return "";

  if (isWindowsRuntime()) {
    if (value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value)) {
      return value;
    }

    if (value.startsWith("//")) {
      return toWindowsUncPath(value);
    }

    if (value.startsWith("/mnt/")) {
      const convertedRoot = convertLinuxSmbPathToWindowsPath(value);

      if (convertedRoot) {
        return toWindowsUncPath(convertedRoot);
      }
    }

    return path.win32.resolve(value);
  }

  if (value.startsWith("\\\\") || value.startsWith("//")) {
    const convertedRoot = convertWindowsSmbPathToLinuxPath(value);

    if (convertedRoot) {
      return convertedRoot;
    }
  }

  if (path.posix.isAbsolute(value)) {
    return value.replace(/\\/g, "/");
  }

  return path.posix.resolve(process.cwd(), value.replace(/\\/g, "/"));
}

export function fileExists(filePath = "") {
  const value = cleanText(filePath);

  if (!value) return false;

  try {
    return fs.existsSync(value) && fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

export function getCandidatePipelineReadablePath(filePath = "") {
  const value = cleanText(filePath);

  if (!value) return "";

  if (isWindowsRuntime()) {
    return toWindowsForwardUncPath(value);
  }

  return value.replace(/\\/g, "/");
}

export function logCandidatePipelineUploadConfig() {
  console.log("[CandidatePipelineUploadPath] Runtime:", {
    platform: os.platform(),
    processPlatform: process.platform,
    forcedOs: cleanText(process.env.SMB_FORCE_OS) || "auto",
    isWindowsRuntime: isWindowsRuntime(),
    smbWindowsServerPath: getWindowsSmbBasePath(),
    smbLinuxServerPath: getLinuxSmbBasePath(),
    hrisRootFolder: getHrisRootFolder(),
    candidatePipelineUploadRoot: getCandidatePipelineUploadRoot(),
  });
}