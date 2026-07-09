import fs from "fs/promises";
import path from "path";
import XLSX from "xlsx";
import db from "../config/db.js";
import {
  cleanString,
  getFirstValidProductionDate,
  normalizeAgentActivityRow,
  normalizeCallsAnsweredRow,
  normalizeEmailCaseRow,
} from "./usVisaKpiParserService.js";

function normalizeSheetName(value = "") {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findSheetName(workbook, possibleNames = []) {
  const normalizedPossibleNames = possibleNames.map(normalizeSheetName);

  for (const sheetName of workbook.SheetNames) {
    const normalized = normalizeSheetName(sheetName);

    if (normalizedPossibleNames.includes(normalized)) {
      return sheetName;
    }
  }

  for (const sheetName of workbook.SheetNames) {
    const normalized = normalizeSheetName(sheetName);

    if (
      normalizedPossibleNames.some(
        (target) => normalized.includes(target) || target.includes(normalized)
      )
    ) {
      return sheetName;
    }
  }

  return null;
}

function readSheetRows(workbook, sheetName) {
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];

  if (!sheet) return [];

  return XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
    blankrows: false,
  });
}

function generateBatchCode() {
  const now = new Date();
  const datePart = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();

  return `USVKPI-${datePart}-${randomPart}`;
}

async function createBatch({
  sourceFilename,
  productionDate,
  uploadedBy,
}) {
  const batchCode = generateBatchCode();

  const [result] = await db.query(
    `
    INSERT INTO us_visa_kpi_upload_batches (
      batch_code,
      source_filename,
      production_date,
      uploaded_by,
      status
    )
    VALUES (?, ?, ?, ?, 'processing')
    `,
    [
      batchCode,
      sourceFilename || null,
      productionDate || null,
      uploadedBy || null,
    ]
  );

  return {
    id: result.insertId,
    batchCode,
  };
}

async function markBatchCompleted(batchId, counts = {}) {
  await db.query(
    `
    UPDATE us_visa_kpi_upload_batches
    SET
      status = 'completed',
      agent_activity_rows = ?,
      calls_answered_rows = ?,
      email_case_rows = ?,
      summary_rows = ?,
      completed_at = NOW()
    WHERE id = ?
    `,
    [
      counts.agentActivityRows || 0,
      counts.callsAnsweredRows || 0,
      counts.emailCaseRows || 0,
      counts.summaryRows || 0,
      batchId,
    ]
  );
}

async function markBatchFailed(batchId, errorMessage) {
  if (!batchId) return;

  await db.query(
    `
    UPDATE us_visa_kpi_upload_batches
    SET
      status = 'failed',
      error_message = ?,
      completed_at = NOW()
    WHERE id = ?
    `,
    [cleanString(errorMessage).slice(0, 5000), batchId]
  );
}

async function insertAgentActivityRows(batchId, rows = []) {
  if (rows.length === 0) return 0;

  const normalizedRows = rows.map(normalizeAgentActivityRow);

  const values = normalizedRows.map((row) => [
    batchId,
    row.timestamp_raw,
    row.agent_raw,
    row.duration_seconds,
    row.activity_date,
    row.agent_name,
    row.start_time_raw,
    row.end_time_raw,
    row.duration_text,
    row.status,
    row.row_json,
    row.row_hash,
  ]);

  const [result] = await db.query(
    `
    INSERT IGNORE INTO us_visa_agent_activity_raw (
      batch_id,
      timestamp_raw,
      agent_raw,
      duration_seconds,
      activity_date,
      agent_name,
      start_time_raw,
      end_time_raw,
      duration_text,
      status,
      row_json,
      row_hash
    )
    VALUES ?
    `,
    [values]
  );

  return result.affectedRows || 0;
}

async function insertCallsAnsweredRows(batchId, rows = []) {
  if (rows.length === 0) return 0;

  const normalizedRows = rows.map(normalizeCallsAnsweredRow);

  const values = normalizedRows.map((row) => [
    batchId,
    row.timestamp_raw,
    row.agent_raw,
    row.talk_seconds,
    row.activity_date,
    row.call_id,
    row.direction,
    row.arrival_time_raw,
    row.arrival_queue_time_raw,
    row.answer_time_raw,
    row.end_time_raw,
    row.agent_name,
    row.skill,
    row.disconnect_indicator,
    row.duration_seconds,
    row.total_hold_seconds,
    row.total_hold_count,
    row.row_json,
    row.row_hash,
  ]);

  const [result] = await db.query(
    `
    INSERT IGNORE INTO us_visa_calls_answered_raw (
      batch_id,
      timestamp_raw,
      agent_raw,
      talk_seconds,
      activity_date,
      call_id,
      direction,
      arrival_time_raw,
      arrival_queue_time_raw,
      answer_time_raw,
      end_time_raw,
      agent_name,
      skill,
      disconnect_indicator,
      duration_seconds,
      total_hold_seconds,
      total_hold_count,
      row_json,
      row_hash
    )
    VALUES ?
    `,
    [values]
  );

  return result.affectedRows || 0;
}

async function insertEmailCaseRows(batchId, rows = []) {
  if (rows.length === 0) return 0;

  const normalizedRows = rows.map(normalizeEmailCaseRow);

  const values = normalizedRows.map((row) => [
    batchId,
    row.timestamp_raw,
    row.agent_raw,
    row.case_number,
    row.created_on_raw,
    row.modified_on_raw,
    row.resolution_date_raw,
    row.created_by,
    row.modified_by,
    row.case_status,
    row.status,
    row.case_country,
    row.owner,
    row.origin,
    row.applicant,
    row.description,
    row.row_json,
    row.row_hash,
  ]);

  const [result] = await db.query(
    `
    INSERT IGNORE INTO us_visa_email_cases_raw (
      batch_id,
      timestamp_raw,
      agent_raw,
      case_number,
      created_on_raw,
      modified_on_raw,
      resolution_date_raw,
      created_by,
      modified_by,
      case_status,
      status,
      case_country,
      owner,
      origin,
      applicant,
      description,
      row_json,
      row_hash
    )
    VALUES ?
    `,
    [values]
  );

  return result.affectedRows || 0;
}

export async function importUsVisaKpiWorkbook({
  filePath,
  originalFilename,
  productionDate,
  uploadedBy,
}) {
  let batchId = null;

  try {
    if (!filePath) {
      throw new Error("Excel file path is required.");
    }

    const workbook = XLSX.readFile(filePath, {
      cellDates: true,
      cellFormula: false,
      cellNF: false,
      cellText: true,
    });

    const agentActivitySheetName = findSheetName(workbook, [
      "HD_AgentStatistics_AgentActivity",
      "AgentStatistics AgentActivity",
      "Agent Activity",
      "AgentActivity",
    ]);

    const callsAnsweredSheetName = findSheetName(workbook, [
      "HD_CallReport_CallsAnswered",
      "CallReport CallsAnswered",
      "Calls Answered",
      "CallsAnswered",
    ]);

    const emailCasesSheetName = findSheetName(workbook, [
      "MSD(WFM Handled Emails)",
      "MSD WFM Handled Emails",
      "WFM Handled Emails",
      "Handled Emails",
      "Emails",
    ]);

    if (!agentActivitySheetName) {
      throw new Error("Missing Agent Activity sheet.");
    }

    if (!callsAnsweredSheetName) {
      throw new Error("Missing Calls Answered sheet.");
    }

    if (!emailCasesSheetName) {
      throw new Error("Missing WFM Handled Emails sheet.");
    }

    const agentActivityRows = readSheetRows(workbook, agentActivitySheetName);
    const callsAnsweredRows = readSheetRows(workbook, callsAnsweredSheetName);
    const emailCaseRows = readSheetRows(workbook, emailCasesSheetName);

    const detectedProductionDate =
      productionDate ||
      getFirstValidProductionDate(agentActivityRows) ||
      getFirstValidProductionDate(callsAnsweredRows) ||
      getFirstValidProductionDate(emailCaseRows);

    const batch = await createBatch({
      sourceFilename: originalFilename,
      productionDate: detectedProductionDate,
      uploadedBy,
    });

    batchId = batch.id;

    const insertedAgentActivityRows = await insertAgentActivityRows(
      batchId,
      agentActivityRows
    );

    const insertedCallsAnsweredRows = await insertCallsAnsweredRows(
      batchId,
      callsAnsweredRows
    );

    const insertedEmailCaseRows = await insertEmailCaseRows(
      batchId,
      emailCaseRows
    );

    const counts = {
      agentActivityRows: insertedAgentActivityRows,
      callsAnsweredRows: insertedCallsAnsweredRows,
      emailCaseRows: insertedEmailCaseRows,
      summaryRows: 0,
    };

    await markBatchCompleted(batchId, counts);

    return {
      success: true,
      batchId,
      batchCode: batch.batchCode,
      sourceFilename: originalFilename,
      productionDate: detectedProductionDate,
      sheets: {
        agentActivity: agentActivitySheetName,
        callsAnswered: callsAnsweredSheetName,
        emailCases: emailCasesSheetName,
      },
      counts,
      message: "US Visa KPI raw data imported successfully.",
    };
  } catch (error) {
    await markBatchFailed(batchId, error.message);

    throw error;
  } finally {
    if (filePath) {
      await fs.unlink(filePath).catch(() => {});
    }
  }
}

export async function getUsVisaKpiImportHistory({ page = 1, limit = 20 } = {}) {
  const currentPage = Math.max(Number(page) || 1, 1);
  const pageLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const offset = (currentPage - 1) * pageLimit;

  const [rows] = await db.query(
    `
    SELECT *
    FROM us_visa_kpi_upload_batches
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
    `,
    [pageLimit, offset]
  );

  const [[countRow]] = await db.query(
    `
    SELECT COUNT(*) AS total
    FROM us_visa_kpi_upload_batches
    `
  );

  const total = Number(countRow?.total || 0);

  return {
    success: true,
    data: rows,
    pagination: {
      currentPage,
      totalPages: Math.max(Math.ceil(total / pageLimit), 1),
      total,
      limit: pageLimit,
    },
  };
}

export async function getUsVisaKpiImportById(batchId) {
  const [rows] = await db.query(
    `
    SELECT *
    FROM us_visa_kpi_upload_batches
    WHERE id = ?
    LIMIT 1
    `,
    [batchId]
  );

  return rows[0] || null;
}