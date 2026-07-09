import db from "../config/db.js";
import { cleanString } from "./usVisaKpiParserService.js";

const DEFAULT_EXPECTED_SECONDS = Number(
  process.env.US_VISA_DEFAULT_EXPECTED_SECONDS || 3600
);

const CALL_TARGET_PER_HOUR = Number(
  process.env.US_VISA_CALL_TARGET_PER_HOUR || 5
);

const EMAIL_STANDARD_SECONDS = Number(
  process.env.US_VISA_EMAIL_STANDARD_SECONDS || 120
);

function toLocalSqlDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function toSqlDateOnly(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toLocalSqlDate(value);
  }

  const raw = cleanString(value);

  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }

  const parsed = new Date(raw);

  if (!Number.isNaN(parsed.getTime())) {
    return toLocalSqlDate(parsed);
  }

  return null;
}

function normalizeAgentKey(value) {
  return cleanString(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
}

function parseDateTime(baseDate, value) {
  if (!value) return null;

  const raw = cleanString(value);

  if (
    !raw ||
    raw === "###########" ||
    raw === "#VALUE!" ||
    raw === "#NAME?" ||
    raw === "0000-00-00" ||
    raw === "0000-00-00 00:00:00"
  ) {
    return null;
  }

  const direct = new Date(raw);

  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const timeOnly = raw.match(
    /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*(AM|PM)?$/i
  );

  if (timeOnly && baseDate) {
    let hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2] || 0);
    const second = Number(timeOnly[3] || 0);
    const meridiem = cleanString(timeOnly[4]).toUpperCase();

    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;

    const safeHour = String(hour).padStart(2, "0");
    const safeMinute = String(minute).padStart(2, "0");
    const safeSecond = String(second).padStart(2, "0");

    const parsed = new Date(
      `${baseDate}T${safeHour}:${safeMinute}:${safeSecond}`
    );

    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function splitIntervalByHour(startDate, endDate) {
  const segments = [];

  if (!startDate || !endDate) return segments;
  if (endDate <= startDate) return segments;

  let cursor = new Date(startDate);
  let guard = 0;

  while (cursor < endDate && guard < 48) {
    const hourStart = new Date(cursor);
    hourStart.setMinutes(0, 0, 0);

    const hourEnd = new Date(hourStart);
    hourEnd.setHours(hourEnd.getHours() + 1);

    const segmentEnd = endDate < hourEnd ? endDate : hourEnd;
    const seconds = Math.max(0, Math.round((segmentEnd - cursor) / 1000));

    if (seconds > 0) {
      segments.push({
        productionDate: toLocalSqlDate(cursor),
        intervalHour: cursor.getHours(),
        seconds,
      });
    }

    cursor = segmentEnd;
    guard += 1;
  }

  return segments;
}

function normalizeStatus(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isOfflineStatus(status) {
  const normalized = normalizeStatus(status);

  return [
    "offline",
    "loggedout",
    "logout",
    "signedout",
    "notloggedin",
  ].includes(normalized);
}

function isAvailableStatus(status) {
  const normalized = normalizeStatus(status);

  return ["available", "avail", "ready", "idle"].includes(normalized);
}

function isBreakStatus(status) {
  const normalized = normalizeStatus(status);

  return (
    normalized.includes("break") ||
    normalized.includes("meal") ||
    normalized.includes("lunch")
  );
}

function isOccupiedStatus(status) {
  const normalized = normalizeStatus(status);

  return (
    normalized.includes("ontask") ||
    normalized.includes("onqueue") ||
    normalized.includes("interacting") ||
    normalized.includes("busy") ||
    normalized.includes("call") ||
    normalized.includes("acw") ||
    normalized.includes("wrap") ||
    normalized.includes("aftercall")
  );
}

function roundPercent(value) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) return 0;

  return Math.round(numberValue * 100) / 100;
}

function getSummaryKey(productionDate, agentKey, intervalHour) {
  return `${productionDate}__${agentKey}__${intervalHour}`;
}

function ensureSummaryRow(summaryMap, productionDate, agentName, intervalHour) {
  const agentKey = normalizeAgentKey(agentName);

  if (
    !productionDate ||
    !agentKey ||
    intervalHour === null ||
    intervalHour === undefined
  ) {
    return null;
  }

  const key = getSummaryKey(productionDate, agentKey, intervalHour);

  if (!summaryMap.has(key)) {
    summaryMap.set(key, {
      productionDate,
      agentKey,
      agentName: cleanString(agentName),
      intervalHour: Number(intervalHour),

      expectedSeconds: DEFAULT_EXPECTED_SECONDS,
      actualLoggedSeconds: 0,
      availableSeconds: 0,
      occupiedCandidateSeconds: 0,
      breakSeconds: 0,

      callIds: new Set(),
      talkSecondsTotal: 0,
      holdSecondsTotal: 0,

      emailCaseNumbers: new Set(),
    });
  }

  return summaryMap.get(key);
}
function buildKnownAgentKeySet(agentActivityRows = [], callsAnsweredRows = []) {
  const knownAgentKeys = new Set();

  agentActivityRows.forEach((row) => {
    const agentName = cleanString(row.agent_name || row.agent_raw);
    const agentKey = normalizeAgentKey(agentName);

    if (agentKey) {
      knownAgentKeys.add(agentKey);
    }
  });

  callsAnsweredRows.forEach((row) => {
    const agentName = cleanString(row.agent_name || row.agent_raw);
    const agentKey = normalizeAgentKey(agentName);

    if (agentKey) {
      knownAgentKeys.add(agentKey);
    }
  });

  return knownAgentKeys;
}

function getEmailAgentName(row) {
  const preferredField = cleanString(process.env.US_VISA_EMAIL_AGENT_FIELD);

  if (preferredField && cleanString(row?.[preferredField])) {
    return cleanString(row[preferredField]);
  }

  return cleanString(row.modified_by || row.created_by || row.agent_raw);
}

function getEmailDateTime(row, baseDate) {
  return parseDateTime(
    baseDate,
    row.resolution_date_raw ||
      row.modified_on_raw ||
      row.created_on_raw ||
      row.timestamp_raw
  );
}

async function getBatch(batchId) {
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

async function loadRawRows(batchId) {
  const [agentActivityRows] = await db.query(
    `
    SELECT *
    FROM us_visa_agent_activity_raw
    WHERE batch_id = ?
    `,
    [batchId]
  );

  const [callsAnsweredRows] = await db.query(
    `
    SELECT *
    FROM us_visa_calls_answered_raw
    WHERE batch_id = ?
    `,
    [batchId]
  );

  const [emailCaseRows] = await db.query(
    `
    SELECT *
    FROM us_visa_email_cases_raw
    WHERE batch_id = ?
    `,
    [batchId]
  );

  return {
    agentActivityRows,
    callsAnsweredRows,
    emailCaseRows,
  };
}

function addAgentActivityToSummary(summaryMap, rows = [], fallbackProductionDate) {
  for (const row of rows) {
    const agentName = cleanString(row.agent_name || row.agent_raw);
    const rowDate = toSqlDateOnly(row.activity_date) || fallbackProductionDate;

    if (!agentName || !rowDate) continue;

    const status = cleanString(row.status);
    const durationSeconds = Math.max(Number(row.duration_seconds || 0), 0);

    let startDate = parseDateTime(rowDate, row.start_time_raw || row.timestamp_raw);
    let endDate = parseDateTime(rowDate, row.end_time_raw);

    if (!startDate && durationSeconds <= 0) continue;

    if (!endDate && startDate && durationSeconds > 0) {
      endDate = new Date(startDate.getTime() + durationSeconds * 1000);
    }

    if (startDate && endDate && endDate <= startDate) {
      if (durationSeconds > 0) {
        endDate = new Date(startDate.getTime() + durationSeconds * 1000);
      } else {
        endDate = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
      }
    }

    if (!startDate || !endDate) continue;

    const segments = splitIntervalByHour(startDate, endDate);

    for (const segment of segments) {
      if (segment.productionDate !== fallbackProductionDate) continue;

      const summaryRow = ensureSummaryRow(
        summaryMap,
        segment.productionDate,
        agentName,
        segment.intervalHour
      );

      if (!summaryRow) continue;

      if (!isOfflineStatus(status)) {
        summaryRow.actualLoggedSeconds += segment.seconds;
      }

      if (isAvailableStatus(status)) {
        summaryRow.availableSeconds += segment.seconds;
      }

      if (isOccupiedStatus(status)) {
        summaryRow.occupiedCandidateSeconds += segment.seconds;
      }

      if (isBreakStatus(status)) {
        summaryRow.breakSeconds += segment.seconds;
      }
    }
  }
}

function addCallsToSummary(summaryMap, rows = [], fallbackProductionDate) {
  for (const row of rows) {
    const agentName = cleanString(row.agent_name || row.agent_raw);
    const rowDate = toSqlDateOnly(row.activity_date) || fallbackProductionDate;

    if (!agentName || !rowDate) continue;

    const callDateTime = parseDateTime(
      rowDate,
      row.answer_time_raw ||
        row.end_time_raw ||
        row.arrival_time_raw ||
        row.timestamp_raw
    );

    if (!callDateTime) continue;

    const productionDate = toLocalSqlDate(callDateTime);

    if (productionDate !== fallbackProductionDate) continue;

    const intervalHour = callDateTime.getHours();

    const summaryRow = ensureSummaryRow(
      summaryMap,
      productionDate,
      agentName,
      intervalHour
    );

    if (!summaryRow) continue;

    const callId = cleanString(row.call_id || `row-${row.id}`);

    if (!summaryRow.callIds.has(callId)) {
      summaryRow.callIds.add(callId);
      summaryRow.talkSecondsTotal += Math.max(Number(row.talk_seconds || 0), 0);
      summaryRow.holdSecondsTotal += Math.max(
        Number(row.total_hold_seconds || 0),
        0
      );
    }
  }
}

function addEmailsToSummary(
  summaryMap,
  rows = [],
  fallbackProductionDate,
  knownAgentKeys = new Set()
) {
  for (const row of rows) {
    const agentName = getEmailAgentName(row);
    const agentKey = normalizeAgentKey(agentName);

    if (!agentName || !agentKey || !fallbackProductionDate) continue;

    // Important:
    // Do not allow WFM/MSD email rows to create new dashboard agents.
    // Emails should only attach to agents already found in Agent Activity or Calls Answered.
    if (!knownAgentKeys.has(agentKey)) continue;

    const emailDateTime = getEmailDateTime(row, fallbackProductionDate);

    if (!emailDateTime) continue;

    const productionDate = toLocalSqlDate(emailDateTime);

    if (productionDate !== fallbackProductionDate) continue;

    const intervalHour = emailDateTime.getHours();

    const summaryRow = ensureSummaryRow(
      summaryMap,
      productionDate,
      agentName,
      intervalHour
    );

    if (!summaryRow) continue;

    const caseNumber = cleanString(row.case_number || `row-${row.id}`);

    if (caseNumber) {
      summaryRow.emailCaseNumbers.add(caseNumber);
    }
  }
}

function finalizeSummaryRows(summaryMap, batchId) {
  return [...summaryMap.values()]
    .map((row) => {
      const handledCalls = row.callIds.size;
      const actualEmails = row.emailCaseNumbers.size;

      const avgTalkSeconds =
        handledCalls > 0
          ? Math.round(row.talkSecondsTotal / handledCalls)
          : 0;

      const avgHoldSeconds =
        handledCalls > 0
          ? Math.round(row.holdSecondsTotal / handledCalls)
          : 0;

      const fallbackOccupiedSeconds = Math.max(
        row.actualLoggedSeconds - row.availableSeconds - row.breakSeconds,
        0
      );

      const occupiedSeconds =
        row.occupiedCandidateSeconds > 0
          ? row.occupiedCandidateSeconds
          : fallbackOccupiedSeconds;

      const phoneOccupancyPct =
        row.actualLoggedSeconds > 0
          ? roundPercent((occupiedSeconds / row.actualLoggedSeconds) * 100)
          : 0;

      const targetEmails =
        EMAIL_STANDARD_SECONDS > 0
          ? Math.floor(row.availableSeconds / EMAIL_STANDARD_SECONDS)
          : 0;

      const emailCapacity = Math.max(targetEmails - actualEmails, 0);

      const emailUtilizationPct =
        targetEmails > 0
          ? roundPercent((actualEmails / targetEmails) * 100)
          : actualEmails > 0
            ? 100
            : 0;

      const callAchievementPct =
        CALL_TARGET_PER_HOUR > 0
          ? roundPercent((handledCalls / CALL_TARGET_PER_HOUR) * 100)
          : 0;

      const loggedAchievementPct =
        row.expectedSeconds > 0
          ? roundPercent((row.actualLoggedSeconds / row.expectedSeconds) * 100)
          : 0;

      const efficiencyComponents = [];

      if (row.expectedSeconds > 0) {
        efficiencyComponents.push(Math.min(loggedAchievementPct, 100));
      }

      if (CALL_TARGET_PER_HOUR > 0) {
        efficiencyComponents.push(Math.min(callAchievementPct, 100));
      }

      if (targetEmails > 0 || actualEmails > 0) {
        efficiencyComponents.push(Math.min(emailUtilizationPct, 100));
      }

      const actualEfficiencyPct =
        efficiencyComponents.length > 0
          ? roundPercent(
              efficiencyComponents.reduce((sum, value) => sum + value, 0) /
                efficiencyComponents.length
            )
          : 0;

      return {
        batchId,
        productionDate: row.productionDate,
        agentKey: row.agentKey,
        agentName: row.agentName,
        intervalHour: row.intervalHour,

        expectedSeconds: row.expectedSeconds,
        actualLoggedSeconds: row.actualLoggedSeconds,

        handledCalls,
        avgTalkSeconds,
        avgHoldSeconds,

        availableSeconds: row.availableSeconds,
        phoneOccupancyPct,

        emailCapacity,
        targetEmails,
        actualEmails,
        emailUtilizationPct,

        actualEfficiencyPct,
      };
    })
    .filter((row) => {
      return (
        row.actualLoggedSeconds > 0 ||
        row.handledCalls > 0 ||
        row.actualEmails > 0
      );
    })
    .sort((a, b) => {
      if (a.productionDate !== b.productionDate) {
        return a.productionDate.localeCompare(b.productionDate);
      }

      if (a.agentName !== b.agentName) {
        return a.agentName.localeCompare(b.agentName);
      }

      return a.intervalHour - b.intervalHour;
    });
}

async function replaceSummaryRows(summaryRows = [], batchId) {
  await db.query(
    `
    DELETE FROM us_visa_kpi_hourly_summary
    WHERE batch_id = ?
    `,
    [batchId]
  );

  if (summaryRows.length === 0) return 0;

  const values = summaryRows.map((row) => [
    row.batchId,
    row.productionDate,
    row.agentKey,
    row.agentName,
    row.intervalHour,

    row.expectedSeconds,
    row.actualLoggedSeconds,

    row.handledCalls,
    row.avgTalkSeconds,
    row.avgHoldSeconds,

    row.availableSeconds,
    row.phoneOccupancyPct,

    row.emailCapacity,
    row.targetEmails,
    row.actualEmails,
    row.emailUtilizationPct,

    row.actualEfficiencyPct,
  ]);

  await db.query(
    `
    INSERT INTO us_visa_kpi_hourly_summary (
      batch_id,
      production_date,
      agent_key,
      agent_name,
      interval_hour,

      expected_seconds,
      actual_logged_seconds,

      handled_calls,
      avg_talk_seconds,
      avg_hold_seconds,

      available_seconds,
      phone_occupancy_pct,

      email_capacity,
      target_emails,
      actual_emails,
      email_utilization_pct,

      actual_efficiency_pct
    )
    VALUES ?
    `,
    [values]
  );

  return summaryRows.length;
}

async function updateBatchSummaryCount(batchId, summaryRowsCount) {
  await db.query(
    `
    UPDATE us_visa_kpi_upload_batches
    SET summary_rows = ?
    WHERE id = ?
    `,
    [summaryRowsCount, batchId]
  );
}

export async function generateUsVisaKpiHourlySummary(batchId) {
  const cleanBatchId = Number(batchId);

  if (!cleanBatchId) {
    throw new Error("Valid batch ID is required.");
  }

  const batch = await getBatch(cleanBatchId);

  if (!batch) {
    throw new Error("Import batch not found.");
  }

  const fallbackProductionDate = toSqlDateOnly(batch.production_date);

  if (!fallbackProductionDate) {
    throw new Error("Batch has no valid production date.");
  }

  const { agentActivityRows, callsAnsweredRows, emailCaseRows } =
    await loadRawRows(cleanBatchId);

  const summaryMap = new Map();

  addAgentActivityToSummary(
    summaryMap,
    agentActivityRows,
    fallbackProductionDate
  );

  addCallsToSummary(summaryMap, callsAnsweredRows, fallbackProductionDate);

  const knownAgentKeys = buildKnownAgentKeySet(
  agentActivityRows,
  callsAnsweredRows
);

addEmailsToSummary(
  summaryMap,
  emailCaseRows,
  fallbackProductionDate,
  knownAgentKeys
);

  const summaryRows = finalizeSummaryRows(summaryMap, cleanBatchId);

  const insertedSummaryRows = await replaceSummaryRows(
    summaryRows,
    cleanBatchId
  );

  await updateBatchSummaryCount(cleanBatchId, insertedSummaryRows);

  return {
    success: true,
    batchId: cleanBatchId,
    batchCode: batch.batch_code,
    productionDate: fallbackProductionDate,
    sourceRows: {
      agentActivityRows: agentActivityRows.length,
      callsAnsweredRows: callsAnsweredRows.length,
      emailCaseRows: emailCaseRows.length,
    },
    summaryRows: insertedSummaryRows,
    config: {
      expectedSecondsPerHour: DEFAULT_EXPECTED_SECONDS,
      callTargetPerHour: CALL_TARGET_PER_HOUR,
      emailStandardSeconds: EMAIL_STANDARD_SECONDS,
      emailAgentField:
  process.env.US_VISA_EMAIL_AGENT_FIELD ||
  "modified_by, fallback created_by/agent_raw",
    },
    message: "US Visa KPI hourly summary generated successfully.",
  };
}