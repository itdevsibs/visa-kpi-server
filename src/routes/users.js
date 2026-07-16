import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import multer from "multer";
import db from "../config/db.js";
import {
  getKronosDatasFromApi,
  getKronosDataByIdFromApi,
} from "../services/kronosDatasApiService.js";
import {
  listEmployeeAssignments,
  saveEmployeeAssignments,
  syncKronosEmployeeAssignments,
} from "../services/employeeAssignmentsService.js";
import {
  deleteKpiImportBatch,
  importKpiRawFile,
  listKpiImportHistory,
  normalizeSourceType,
  rebuildKpiSummaries,
} from "../services/kpiRawImportService.js";

const router = express.Router();

const KPI_RAW_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const KPI_RAW_ALLOWED_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);

const kpiRawUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: KPI_RAW_UPLOAD_MAX_BYTES,
    files: 1,
  },
  fileFilter(req, file, callback) {
    const originalName = cleanText(file?.originalname).toLowerCase();
    const extension = originalName.includes(".")
      ? originalName.slice(originalName.lastIndexOf("."))
      : "";

    if (!KPI_RAW_ALLOWED_EXTENSIONS.has(extension)) {
      return callback(
        new Error("Only .xlsx, .xls, and .csv files are accepted."),
      );
    }

    return callback(null, true);
  },
}).single("file");

function handleKpiRawUpload(req, res, next) {
  kpiRawUpload(req, res, (error) => {
    if (!error) return next();

    const isSizeError = error.code === "LIMIT_FILE_SIZE";

    return res.status(400).json({
      success: false,
      message: isSizeError
        ? "The uploaded file exceeds the 50 MB limit."
        : error.message || "Unable to read the uploaded KPI file.",
    });
  });
}

/* =====================================
   HELPERS
===================================== */

function cleanText(value) {
  return String(value ?? "").trim();
}

function buildFullName(user = {}) {
  return [
    cleanText(user.first_name),
    cleanText(user.middle_name),
    cleanText(user.last_name),
  ]
    .filter(Boolean)
    .join(" ");
}

function createUserResponse(user = {}) {
  return {
    id: user.id,
    sibs_id: user.sibs_id,

    first_name: user.first_name,
    middle_name: user.middle_name,
    last_name: user.last_name,
    full_name: buildFullName(user),

    email: user.email || "",

    role: user.role,

    account_id: user.account_id ?? null,
    account_name: user.account_name || "",

    department_id: user.department_id ?? null,
    department_name: user.department_name || "",

    is_active: Boolean(user.is_active),
    last_login: user.last_login || null,
    created_at: user.created_at || null,
    updated_at: user.updated_at || null,
  };
}

/* =====================================
   PASSWORD ENCRYPTION
===================================== */

function encryptPass(password) {
  const method = process.env.ENCRYPT_METHOD;
  const secretKey = process.env.ENCRYPT_SECRET_KEY;
  const secretIv = process.env.ENCRYPT_SECRET_IV;

  if (!method || !secretKey || !secretIv) {
    throw new Error("Missing encryption environment variables.");
  }

  const key = Buffer.from(
    crypto.createHash("sha256").update(secretKey).digest("hex"),
    "utf8",
  ).slice(0, 32);

  const iv = Buffer.from(
    crypto
      .createHash("sha256")
      .update(secretIv)
      .digest("hex")
      .substring(0, 16),
    "utf8",
  );

  const cipher = crypto.createCipheriv(method, key, iv);

  let encrypted = cipher.update(String(password), "utf8", "base64");
  encrypted += cipher.final("base64");

  return Buffer.from(encrypted, "utf8").toString("base64");
}

/* =====================================
   JWT AUTHENTICATION MIDDLEWARE
===================================== */

function authenticateToken(req, res, next) {
  try {
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader) {
      return res.status(401).json({
        success: false,
        message: "Authorization token is required.",
      });
    }

    const [scheme, token] = authorizationHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        success: false,
        message: "Invalid authorization header.",
      });
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not configured.");
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;

    return next();
  } catch (error) {
    console.error("[AUTHENTICATION ERROR]", error);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Your session has expired. Please log in again.",
      });
    }

    return res.status(401).json({
      success: false,
      message: "Invalid authentication token.",
    });
  }
}

function requireAdministrator(req, res, next) {
  const role = cleanText(req.user?.role)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!["admin", "administrator", "super_admin", "superadmin", "super_administrator", "superadministrator"].includes(role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access is required.",
    });
  }

  return next();
}

/* =====================================
   LOGIN
===================================== */

router.post("/login", async (req, res) => {
  try {
    const sibsId = cleanText(req.body?.sibs_id);
    const password = String(req.body?.password || "");

    if (!sibsId || !password) {
      return res.status(400).json({
        success: false,
        message: "SIBS ID and password are required.",
      });
    }

    const [rows] = await db.query(
      `
      SELECT
        id,
        sibs_id,
        password,
        first_name,
        middle_name,
        last_name,
        email,
        role,
        account_id,
        account_name,
        department_id,
        department_name,
        is_active,
        last_login,
        created_at,
        updated_at
      FROM us_visa_users
      WHERE sibs_id = ?
        AND is_active = 1
      LIMIT 1
      `,
      [sibsId],
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid SIBS ID or password.",
      });
    }

    const user = rows[0];
    const encryptedPassword = encryptPass(password);

    if (encryptedPassword !== user.password) {
      return res.status(401).json({
        success: false,
        message: "Invalid SIBS ID or password.",
      });
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not configured.");
    }

    const token = jwt.sign(
      {
        id: user.id,
        sibs_id: user.sibs_id,
        email: user.email || "",
        role: user.role,
        account_id: user.account_id ?? null,
        account_name: user.account_name || "",
        department_id: user.department_id ?? null,
        department_name: user.department_name || "",
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN || "8h",
      },
    );

    await db.query(
      `
      UPDATE us_visa_users
      SET last_login = NOW()
      WHERE id = ?
      `,
      [user.id],
    );

    const responseUser = createUserResponse({
      ...user,
      last_login: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token,
      user: responseUser,
      data: responseUser,
    });
  } catch (error) {
    console.error("[LOGIN ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to log in.",
    });
  }
});

/* =====================================
   GET CURRENT USER
===================================== */

router.get("/me", authenticateToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        id,
        sibs_id,
        first_name,
        middle_name,
        last_name,
        email,
        role,
        account_id,
        account_name,
        department_id,
        department_name,
        is_active,
        last_login,
        created_at,
        updated_at
      FROM us_visa_users
      WHERE id = ?
        AND is_active = 1
      LIMIT 1
      `,
      [req.user.id],
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User account was not found.",
      });
    }

    const responseUser = createUserResponse(rows[0]);

    return res.status(200).json({
      success: true,
      message: "Current user retrieved successfully.",
      data: responseUser,
      user: responseUser,
    });
  } catch (error) {
    console.error("[GET CURRENT USER ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to retrieve the current user.",
    });
  }
});

/* =====================================
   KPI EMPLOYEE ASSIGNMENTS
===================================== */

router.get(
  "/employee-assignments",
  authenticateToken,
  requireAdministrator,
  async (req, res) => {
    try {
      const employees = await listEmployeeAssignments(req.user);

      return res.status(200).json({
        success: true,
        data: employees,
        message: "Employee assignments loaded successfully.",
      });
    } catch (error) {
      console.error("[GET EMPLOYEE ASSIGNMENTS ERROR]", error);

      return res.status(500).json({
        success: false,
        data: [],
        message:
          error.sqlMessage ||
          error.message ||
          "Unable to load employee assignments.",
      });
    }
  },
);

router.post(
  "/employee-assignments/sync-kronos",
  authenticateToken,
  requireAdministrator,
  async (req, res) => {
    try {
      const result = await syncKronosEmployeeAssignments(req.user);

      return res.status(200).json({
        success: true,
        data: result.employees,
        summary: result.summary,
        message: `Kronos synchronization completed. ${result.summary.eligible} active US Visa employees are available for assignment.`,
      });
    } catch (error) {
      console.error("[SYNC KRONOS EMPLOYEE ASSIGNMENTS ERROR]", error);

      const responseStatus = Number(error?.response?.status);
      const statusCode =
        Number.isFinite(responseStatus) && responseStatus >= 400
          ? responseStatus
          : 500;

      return res.status(statusCode).json({
        success: false,
        data: [],
        message:
          error?.response?.data?.message ||
          error.sqlMessage ||
          error.message ||
          "Unable to synchronize Kronos employees.",
      });
    }
  },
);

router.put(
  "/employee-assignments",
  authenticateToken,
  requireAdministrator,
  async (req, res) => {
    try {
      const assignments = req.body?.assignments;

      if (!Array.isArray(assignments)) {
        return res.status(400).json({
          success: false,
          data: [],
          message: "The assignments field must be an array.",
        });
      }

      const result = await saveEmployeeAssignments(assignments, req.user);
      let rebuildResult = { productionDates: [], summaryRows: 0 };
      let rebuildWarning = "";

      if (result.updated > 0) {
        try {
          rebuildResult = await rebuildKpiSummaries();
        } catch (rebuildError) {
          console.error(
            "[REBUILD KPI SUMMARY AFTER ASSIGNMENT SAVE ERROR]",
            rebuildError,
          );
          rebuildWarning =
            " Assignments were saved, but the KPI summary rebuild failed. Use Rebuild Reports in Administration after checking the server log.";
        }
      }

      return res.status(200).json({
        success: true,
        data: result.employees,
        updated: result.updated,
        rebuild: rebuildResult,
        rebuildWarning: rebuildWarning || null,
        message: `${result.updated} employee assignment${
          result.updated === 1 ? "" : "s"
        } saved successfully. ${Number(rebuildResult.summaryRows || 0).toLocaleString()} KPI summary row${
          Number(rebuildResult.summaryRows || 0) === 1 ? "" : "s"
        } regenerated using the current mappings.${rebuildWarning}`,
      });
    } catch (error) {
      console.error("[SAVE EMPLOYEE ASSIGNMENTS ERROR]", error);

      const isValidationError =
        error instanceof TypeError ||
        /not found|maximum|valid|required/i.test(error.message || "");

      return res.status(isValidationError ? 400 : 500).json({
        success: false,
        data: [],
        message:
          error.sqlMessage ||
          error.message ||
          "Unable to save employee assignments.",
      });
    }
  },
);

/* =====================================
   KPI RAW DATA IMPORT
===================================== */

router.get(
  "/kpi-raw-import/history",
  authenticateToken,
  requireAdministrator,
  async (req, res) => {
    try {
      const history = await listKpiImportHistory(req.query?.limit);

      return res.status(200).json({
        success: true,
        data: history,
        message: "KPI import history loaded successfully.",
      });
    } catch (error) {
      console.error("[GET KPI RAW IMPORT HISTORY ERROR]", error);

      return res.status(500).json({
        success: false,
        data: [],
        message:
          error.sqlMessage ||
          error.message ||
          "Unable to load KPI import history.",
      });
    }
  },
);

router.post(
  "/kpi-raw-import/rebuild",
  authenticateToken,
  requireAdministrator,
  async (req, res) => {
    try {
      const productionDates = Array.isArray(req.body?.productionDates)
        ? req.body.productionDates
        : [];
      const result = await rebuildKpiSummaries(productionDates);

      return res.status(200).json({
        success: true,
        data: result,
        message: `${Number(result.summaryRows || 0).toLocaleString()} KPI summary row${
          Number(result.summaryRows || 0) === 1 ? "" : "s"
        } regenerated for ${result.productionDates.length.toLocaleString()} production date${
          result.productionDates.length === 1 ? "" : "s"
        }.`,
      });
    } catch (error) {
      console.error("[REBUILD KPI SUMMARY ERROR]", error);

      return res.status(500).json({
        success: false,
        message:
          error.sqlMessage ||
          error.message ||
          "Unable to rebuild KPI reports from the imported raw data.",
      });
    }
  },
);

router.delete(
  "/kpi-raw-import/:batchId",
  authenticateToken,
  requireAdministrator,
  async (req, res) => {
    try {
      const result = await deleteKpiImportBatch(req.params.batchId);
      const deletedRows = Number(result.deletedRows?.total || 0);

      return res.status(200).json({
        success: true,
        data: result,
        message: `${result.batch.sourceFilename || "KPI import"} was deleted. ${deletedRows.toLocaleString()} raw row${
          deletedRows === 1 ? "" : "s"
        } removed and ${Number(result.regeneratedSummaryRows || 0).toLocaleString()} KPI summary row${
          Number(result.regeneratedSummaryRows || 0) === 1 ? "" : "s"
        } regenerated from the remaining imports.`,
      });
    } catch (error) {
      console.error("[DELETE KPI RAW IMPORT ERROR]", error);

      const isNotFound = error.code === "KPI_IMPORT_NOT_FOUND";
      const isValidationError =
        error instanceof TypeError || /valid|required/i.test(error.message || "");

      return res.status(isNotFound ? 404 : isValidationError ? 400 : 500).json({
        success: false,
        message:
          error.sqlMessage ||
          error.message ||
          "Unable to delete the selected KPI import.",
      });
    }
  },
);

router.post(
  "/kpi-raw-import",
  authenticateToken,
  requireAdministrator,
  handleKpiRawUpload,
  async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({
          success: false,
          message: "Choose an Excel or CSV file to import.",
        });
      }

      const result = await importKpiRawFile({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        sourceType: normalizeSourceType(req.body?.sourceType),
        uploadedBy: req.user?.id,
      });

      const insertedRows = result.sources.reduce(
        (total, source) => total + Number(source.insertedRows || 0),
        0,
      );
      const duplicateRows = result.sources.reduce(
        (total, source) => total + Number(source.duplicateRows || 0),
        0,
      );

      return res.status(201).json({
        success: true,
        data: result,
        message: `${insertedRows.toLocaleString()} raw row${
          insertedRows === 1 ? "" : "s"
        } imported, ${duplicateRows.toLocaleString()} duplicate row${
          duplicateRows === 1 ? "" : "s"
        } skipped, and ${result.summaryRows.toLocaleString()} KPI summary row${
          result.summaryRows === 1 ? "" : "s"
        } generated.`,
      });
    } catch (error) {
      console.error("[KPI RAW IMPORT ERROR]", error);

      const isValidationError =
        error instanceof TypeError ||
        error instanceof RangeError ||
        /supported|format|header|empty|maximum|file/i.test(error.message || "");

      return res.status(isValidationError ? 400 : 500).json({
        success: false,
        message:
          error.sqlMessage ||
          error.message ||
          "Unable to import the KPI raw-data file.",
      });
    }
  },
);

/* =====================================
   GET KRONOS EMPLOYEES
===================================== */

router.get("/kronos-employees", authenticateToken, async (req, res) => {
  try {
    const result = await getKronosDatasFromApi(req.query, req.user);

    return res.status(200).json({
      success: result?.success !== false,
      message:
        result?.message || "Kronos employees retrieved successfully.",
      ...result,
    });
  } catch (error) {
    console.error("[GET KRONOS EMPLOYEES ERROR]", error);

    const responseStatus = Number(error?.response?.status);

    const statusCode =
      Number.isFinite(responseStatus) && responseStatus >= 400
        ? responseStatus
        : 500;

    return res.status(statusCode).json({
      success: false,
      message:
        error?.response?.data?.message ||
        error?.message ||
        "Unable to retrieve Kronos employees.",
      data: [],
      pagination: {
        page: 1,
        limit: Number(process.env.KRONOS_DATAS_PAGE_LIMIT || 25),
        total: 0,
        totalPages: 0,
      },
    });
  }
});

/* =====================================
   GET KRONOS EMPLOYEE BY SIBS ID
===================================== */

router.get(
  "/kronos-employees/:sibsId",
  authenticateToken,
  async (req, res) => {
    try {
      const sibsId = cleanText(req.params.sibsId);

      if (!sibsId) {
        return res.status(400).json({
          success: false,
          message: "SIBS ID is required.",
          data: null,
        });
      }

      const result = await getKronosDataByIdFromApi(sibsId);

      if (!result?.data) {
        return res.status(404).json({
          success: false,
          message:
            result?.message ||
            `No Kronos employee was found for SIBS ID ${sibsId}.`,
          data: null,
        });
      }

      return res.status(200).json({
        success: true,
        message:
          result?.message || "Kronos employee retrieved successfully.",
        ...result,
      });
    } catch (error) {
      console.error("[GET KRONOS EMPLOYEE ERROR]", error);

      const responseStatus = Number(error?.response?.status);

      const statusCode =
        Number.isFinite(responseStatus) && responseStatus >= 400
          ? responseStatus
          : 500;

      return res.status(statusCode).json({
        success: false,
        message:
          error?.response?.data?.message ||
          error?.message ||
          "Unable to retrieve the Kronos employee.",
        data: null,
      });
    }
  },
);

export default router;