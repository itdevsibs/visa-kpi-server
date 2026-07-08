import path from "path";
import fs from "fs";

export function getRuntimeOS() {
  const forcedOS = String(process.env.SMB_FORCE_OS || "")
    .trim()
    .toLowerCase();

  if (forcedOS === "windows") return "windows";
  if (forcedOS === "linux") return "linux";

  return process.platform === "win32" ? "windows" : "linux";
}

export function normalizeStorageRootPath(value) {
  const cleanValue = String(value || "").trim();

  if (!cleanValue) {
    return path.join(process.cwd(), "uploads");
  }

  if (cleanValue.startsWith("//") || cleanValue.startsWith("\\\\")) {
    return cleanValue.replace(/\//g, "\\");
  }

  return cleanValue;
}

export function getStorageRootDir() {
  const runtimeOS = getRuntimeOS();

  const selectedPath =
    runtimeOS === "windows"
      ? process.env.SMB_WINDOWS_SERVER_PATH || process.env.SMB_SERVER_PATH
      : process.env.SMB_LINUX_SERVER_PATH || process.env.SMB_SERVER_PATH;

  return normalizeStorageRootPath(selectedPath);
}

export function getHrisRootDir() {
  return path.join(
    getStorageRootDir(),
    process.env.SMB_HRIS_ROOT_FOLDER || "SiBS HRIS",
  );
}

export function getModuleUploadDir(moduleEnvKey, fallbackFolderName) {
  return path.join(
    getHrisRootDir(),
    process.env[moduleEnvKey] || fallbackFolderName,
  );
}

export function ensureDirectoryExists(directoryPath) {
  if (!directoryPath) return;

  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

export function getCommonHrisUploadDirs() {
  return {
    hrisRootDir: getHrisRootDir(),

    profilePictureDir: getModuleUploadDir(
      "SMB_PROFILE_PICTURE_PATH",
      "profile-picture",
    ),

    resignationDir: getModuleUploadDir("SMB_RESIGNATION_PATH", "resignation"),

    attritionDir: getModuleUploadDir("SMB_ATTRITION_PATH", "attrition"),

    weeklyHiringPlanDir: getModuleUploadDir(
      "SMB_WEEKLY_HIRING_PLAN_PATH",
      "weekly-hiring-plan",
    ),

    recruitmentDir: getModuleUploadDir("SMB_RECRUITMENT_PATH", "recruitment"),

    candidateFilesDir: getModuleUploadDir(
      "SMB_CANDIDATE_FILES_PATH",
      "recruitment/candidate-files",
    ),

    offerFilesDir: getModuleUploadDir(
      "SMB_OFFER_FILES_PATH",
      "recruitment/offer-files",
    ),

    onboardingFilesDir: getModuleUploadDir(
      "SMB_ONBOARDING_FILES_PATH",
      "recruitment/onboarding-files",
    ),
  };
}

export function logStorageConfig(moduleName, moduleUploadDir) {
  console.log("=========================================");
  console.log(`${moduleName} STORAGE`);
  console.log("Runtime OS:", getRuntimeOS());
  console.log("Storage Root Directory:", getStorageRootDir());
  console.log("HRIS Root Directory:", getHrisRootDir());
  console.log(`${moduleName} Upload Directory:`, moduleUploadDir);
  console.log("Upload Directory Exists:", fs.existsSync(moduleUploadDir));
  console.log("=========================================");
}