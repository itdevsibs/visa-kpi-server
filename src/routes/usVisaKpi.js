import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import {
  getUsVisaKpiImportById,
  getUsVisaKpiImportHistory,
  importUsVisaKpiWorkbook,
} from "../services/usVisaKpiImportService.js";
import { generateUsVisaKpiHourlySummary } from "../services/usVisaKpiAggregationService.js";
import {
  getUsVisaKpiAgents,
  getUsVisaKpiDashboard,
} from "../services/usVisaKpiDashboardService.js";
import {
  bulkUpsertUsVisaKpiEmployees,
  createUsVisaKpiEmployee,
  getUsVisaKpiEmployeeByUid,
  importOfficialUsVisaRoster,
  listUsVisaKpiEmployees,
  syncUsVisaKpiEmployeesFromSummary,
  updateUsVisaKpiEmployee,
} from "../services/usVisaKpiEmployeeService.js";
import { getUsVisaKpiPerformance } from "../services/usVisaKpiPerformanceService.js";

const router = express.Router();

const uploadDir = path.resolve("uploads/us-visa-kpi");

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function destination(req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function filename(req, file, cb) {
    const timestamp = Date.now();
    const safeOriginalName = String(file.originalname || "upload.xlsx")
      .replace(/[^\w.\-() ]+/g, "_")
      .replace(/\s+/g, "_");

    cb(null, `${timestamp}-${safeOriginalName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
  fileFilter: function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();

    const allowedExtensions = [".xlsx", ".xls", ".xlsm", ".csv"];

    if (!allowedExtensions.includes(ext)) {
      return cb(new Error("Only Excel or CSV files are allowed."));
    }

    return cb(null, true);
  },
});

/**
 * GET /api/us-visa-kpi/dashboard
 */
router.get("/dashboard", async (req, res) => {
  try {
    const result = await getUsVisaKpiDashboard(req.query);

    return res.json(result);
  } catch (error) {
    console.error("[US VISA KPI DASHBOARD ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch US Visa KPI dashboard.",
    });
  }
});

/**
 * GET /api/us-visa-kpi/agents
 */
router.get("/agents", async (req, res) => {
  try {
    const result = await getUsVisaKpiAgents({
      date: req.query.date,
      batchId: req.query.batchId,
    });

    return res.json(result);
  } catch (error) {
    console.error("[US VISA KPI AGENTS ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch US Visa KPI agents.",
    });
  }
});

/**
 * GET /api/us-visa-kpi/employees
 */
router.get("/employees", async (req, res) => {
  try {
    const employees = await listUsVisaKpiEmployees({
      activeOnly: req.query.activeOnly === "true",
      includeDashboardOnly: req.query.includeDashboardOnly === "true",
      search: req.query.search || "",
    });

    return res.json({
      success: true,
      data: employees,
    });
  } catch (error) {
    console.error("[US VISA KPI EMPLOYEE LIST ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch US Visa KPI employees.",
    });
  }
});

/**
 * POST /api/us-visa-kpi/employees
 */
router.post("/employees", async (req, res) => {
  try {
    const employee = await createUsVisaKpiEmployee(req.body || {});

    return res.status(201).json({
      success: true,
      data: employee,
      message: "US Visa employee added successfully.",
    });
  } catch (error) {
    console.error("[US VISA KPI EMPLOYEE CREATE ERROR]", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Failed to create US Visa employee.",
    });
  }
});

/**
 * POST /api/us-visa-kpi/employees/import-official-roster
 */
router.post("/employees/import-official-roster", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const deactivateMissing = req.body?.deactivateMissing !== false;

    const result = await importOfficialUsVisaRoster({
      rows,
      deactivateMissing,
    });

    return res.json({
      success: true,
      data: result.employees,
      summary: result.summary,
      message: "Official US Visa roster imported successfully.",
    });
  } catch (error) {
    console.error("[US VISA KPI OFFICIAL ROSTER IMPORT ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to import official US Visa roster.",
    });
  }
});

/**
 * POST /api/us-visa-kpi/employees/bulk-upsert
 */
router.post("/employees/bulk-upsert", async (req, res) => {
  try {
    const employees = Array.isArray(req.body?.employees)
      ? req.body.employees
      : [];

    const result = await bulkUpsertUsVisaKpiEmployees(employees);

    return res.json({
      success: true,
      data: result.employees,
      summary: {
        total: result.total,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
      },
      message: "US Visa employees saved successfully.",
    });
  } catch (error) {
    console.error("[US VISA KPI EMPLOYEE BULK UPSERT ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to save US Visa employees.",
    });
  }
});


/**
 * POST /api/us-visa-kpi/employees/sync-from-kpi
 */
router.post("/employees/sync-from-kpi", async (req, res) => {
  try {
    const result = await syncUsVisaKpiEmployeesFromSummary({
      date: req.body?.date || req.query.date || "",
      batchId: req.body?.batchId || req.query.batchId || null,
    });

    return res.json({
      success: true,
      data: result.employees,
      summary: {
        selectedDate: result.selectedDate,
        batchId: result.batchId,
        sourceAgents: result.sourceAgents,
        added: result.added,
        matched: result.matched,
        aliasesCreated: result.aliasesCreated,
        skipped: result.skipped,
      },
      message: "US Visa employees synced from KPI summary successfully.",
    });
  } catch (error) {
    console.error("[US VISA KPI EMPLOYEE SYNC FROM SUMMARY ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to sync employees from KPI data.",
    });
  }
});

/**
 * GET /api/us-visa-kpi/employees/:employeeUid
 */
router.get("/employees/:employeeUid", async (req, res) => {
  try {
    const employee = await getUsVisaKpiEmployeeByUid(req.params.employeeUid);

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found.",
      });
    }

    return res.json({
      success: true,
      data: employee,
    });
  } catch (error) {
    console.error("[US VISA KPI EMPLOYEE DETAIL ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch US Visa KPI employee.",
    });
  }
});

/**
 * PUT /api/us-visa-kpi/employees/:employeeUid
 */
router.put("/employees/:employeeUid", async (req, res) => {
  try {
    const employee = await updateUsVisaKpiEmployee(
      req.params.employeeUid,
      req.body || {}
    );

    return res.json({
      success: true,
      data: employee,
      message: "US Visa employee updated successfully.",
    });
  } catch (error) {
    console.error("[US VISA KPI EMPLOYEE UPDATE ERROR]", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Failed to update US Visa KPI employee.",
    });
  }
});

/**
 * POST /api/us-visa-kpi/import
 */
router.post("/import", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Excel file is required. Use form-data field name: file.",
      });
    }

    const result = await importUsVisaKpiWorkbook({
      filePath: req.file.path,
      originalFilename: req.file.originalname,
      productionDate: req.body.productionDate || null,
      uploadedBy: req.user?.id || null,
    });

    return res.json(result);
  } catch (error) {
    console.error("[US VISA KPI IMPORT ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to import US Visa KPI workbook.",
    });
  }
});

/**
 * GET /api/us-visa-kpi/performance
 */
router.get("/performance", async (req, res) => {
  try {
    const result = await getUsVisaKpiPerformance(req.query);

    return res.json(result);
  } catch (error) {
    console.error("[US VISA KPI PERFORMANCE ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch US Visa KPI performance.",
    });
  }
});

/**
 * POST /api/us-visa-kpi/imports/:batchId/generate-summary
 */
router.post("/imports/:batchId/generate-summary", async (req, res) => {
  try {
    const result = await generateUsVisaKpiHourlySummary(req.params.batchId);

    return res.json(result);
  } catch (error) {
    console.error("[US VISA KPI SUMMARY GENERATION ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to generate US Visa KPI summary.",
    });
  }
});

/**
 * GET /api/us-visa-kpi/imports
 */
router.get("/imports", async (req, res) => {
  try {
    const result = await getUsVisaKpiImportHistory({
      page: req.query.page,
      limit: req.query.limit,
    });

    return res.json(result);
  } catch (error) {
    console.error("[US VISA KPI IMPORT HISTORY ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch import history.",
    });
  }
});

/**
 * GET /api/us-visa-kpi/imports/:batchId
 */
router.get("/imports/:batchId", async (req, res) => {
  try {
    const batch = await getUsVisaKpiImportById(req.params.batchId);

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Import batch not found.",
      });
    }

    return res.json({
      success: true,
      data: batch,
    });
  } catch (error) {
    console.error("[US VISA KPI IMPORT DETAIL ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch import batch.",
    });
  }
});

export default router;
