import crypto from "crypto";
import XLSX from "xlsx";

import db from "../config/db.js";

export const SOURCE_TYPES = Object.freeze({
  AUTO: "auto",
  MSD: "msd",
  HD_CALLS: "hd_calls",
  HD_ACTIVITY: "hd_activity",
});

const SOURCE_LABELS = Object.freeze({
  [SOURCE_TYPES.MSD]: "MSD (WFM Handled Emails)",
  [SOURCE_TYPES.HD_CALLS]: "HD Call Report - Calls Answered",
  [SOURCE_TYPES.HD_ACTIVITY]: "HD Agent Statistics - Agent Activity",
});

const TABLES = Object.freeze({
  employees: "us_visa_kpi_employees",
  aliases: "us_visa_kpi_employee_aliases",
  batches: "us_visa_kpi_upload_batches",
  activity: "us_visa_agent_activity_raw",
  calls: "us_visa_calls_answered_raw",
  emails: "us_visa_email_cases_raw",
  summary: "us_visa_kpi_hourly_summary",
});

const LOGGED_ACTIVITY_STATUSES = new Set([
  "available",
  "ontask",
  "on task",
  "training",
]);

const AVAILABLE_ACTIVITY_STATUSES = new Set([
  "available",
  "ontask",
  "on task",
]);

const REPORT_START_HOUR = 8;
const REPORT_END_HOUR = 16;

const MAX_IMPORT_ROWS = 250_000;
const INSERT_CHUNK_SIZE = 250;
const HASH_LOOKUP_CHUNK_SIZE = 500;
const EMAIL_SECONDS_PER_TARGET = 240;

function cleanText(value, maximumLength = 10_000) {
  if (value === null || value === undefined) return "";

  if (value instanceof Date) {
    return formatPseudoLocalDateTime(value);
  }

  return String(value).trim().slice(0, maximumLength);
}

export function normalizeComparable(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSibsId(value) {
  const compact = cleanText(value, 100)
    .toUpperCase()
    .replace(/^SIB[\s_-]*/i, "")
    .replace(/[^A-Z0-9]/g, "");

  return compact ? `SIB-${compact}` : "";
}

function normalizeHeader(value) {
  return normalizeComparable(value).replace(/\s+/g, "");
}

export function normalizeSourceType(value) {
  const normalized = normalizeComparable(value).replace(/\s+/g, "_");

  if (["msd", "email", "emails", "handled_emails"].includes(normalized)) {
    return SOURCE_TYPES.MSD;
  }

  if (
    [
      "hd_calls",
      "hd_call",
      "calls",
      "call_report",
      "hd_call_report",
    ].includes(normalized)
  ) {
    return SOURCE_TYPES.HD_CALLS;
  }

  if (
    [
      "hd_activity",
      "activity",
      "agent_activity",
      "agent_statistics",
      "hd_agent_statistics",
    ].includes(normalized)
  ) {
    return SOURCE_TYPES.HD_ACTIVITY;
  }

  return SOURCE_TYPES.AUTO;
}

export function detectSourceFromHeaders(headers = []) {
  const normalizedHeaders = new Set(
    (Array.isArray(headers) ? headers : [])
      .map(normalizeHeader)
      .filter(Boolean),
  );

  const has = (...values) => values.some((value) => normalizedHeaders.has(value));
  const hasAll = (...values) => values.every((value) => normalizedHeaders.has(value));

  if (
    hasAll("casenumber", "modifiedon") &&
    has("modifiedby", "agent") &&
    has("casestatus", "status")
  ) {
    return SOURCE_TYPES.MSD;
  }

  if (
    hasAll("callid", "agentname", "endtime") &&
    has("answertime", "arrivaltimeinqueue") &&
    has("durationsec", "talktime", "totalholdtimesec")
  ) {
    return SOURCE_TYPES.HD_CALLS;
  }

  if (
    hasAll("agentname", "starttime", "endtime", "status") &&
    has("duration", "durationsec")
  ) {
    return SOURCE_TYPES.HD_ACTIVITY;
  }

  return null;
}

function detectSourceFromSheetName(sheetName) {
  const normalized = normalizeComparable(sheetName).replace(/\s+/g, "");

  if (normalized.includes("msd") && normalized.includes("handledemail")) {
    return SOURCE_TYPES.MSD;
  }

  if (
    normalized.includes("callreport") ||
    normalized.includes("callsanswered")
  ) {
    return SOURCE_TYPES.HD_CALLS;
  }

  if (
    normalized.includes("agentstatistics") ||
    normalized.includes("agentactivity")
  ) {
    return SOURCE_TYPES.HD_ACTIVITY;
  }

  return null;
}

function round(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * multiplier) / multiplier;
}

export function parseDurationSeconds(value) {
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 0 && value < 1) {
      return Math.max(0, Math.round(value * 86_400));
    }

    return Math.max(0, Math.round(value));
  }

  if (value instanceof Date) {
    return (
      value.getHours() * 3600 +
      value.getMinutes() * 60 +
      value.getSeconds()
    );
  }

  const text = cleanText(value);
  const clockMatch = text.match(/^(\d{1,4}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);

  if (clockMatch) {
    const hours = Number(clockMatch[1] || 0);
    const minutes = Number(clockMatch[2] || 0);
    const seconds = Number(clockMatch[3] || 0);
    return Math.max(0, Math.round(hours * 3600 + minutes * 60 + seconds));
  }

  const numericValue = Number(text.replace(/,/g, ""));
  return Number.isFinite(numericValue) ? Math.max(0, Math.round(numericValue)) : 0;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateParts(parts) {
  if (!parts) return "";
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function formatDateTimeParts(parts) {
  if (!parts) return "";
  return `${formatDateParts(parts)} ${pad2(parts.hour || 0)}:${pad2(parts.minute || 0)}:${pad2(parts.second || 0)}`;
}

function formatPseudoLocalDateTime(date) {
  return formatDateTimeParts({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  });
}

function parseAmPmHour(hour, amPm) {
  let result = Number(hour || 0);
  const marker = cleanText(amPm).toUpperCase();

  if (marker === "AM" && result === 12) result = 0;
  if (marker === "PM" && result < 12) result += 12;

  return result;
}

function parseDateOnlyString(value) {
  const text = cleanText(value);
  if (!text) return null;

  let match = text.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: 0,
      minute: 0,
      second: 0,
    };
  }

  match = text.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (match) {
    return {
      year: Number(match[3]),
      month: Number(match[1]),
      day: Number(match[2]),
      hour: 0,
      minute: 0,
      second: 0,
    };
  }

  return null;
}

function parseDateTimeString(value, fallbackDate = "") {
  const text = cleanText(value);
  if (!text) return null;

  let match = text.match(
    /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?\s*(AM|PM)?)?$/i,
  );

  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: parseAmPmHour(match[4] || 0, match[7]),
      minute: Number(match[5] || 0),
      second: Math.floor(Number(match[6] || 0)),
    };
  }

  match = text.match(
    /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?\s*(AM|PM)?)?$/i,
  );

  if (match) {
    return {
      year: Number(match[3]),
      month: Number(match[1]),
      day: Number(match[2]),
      hour: parseAmPmHour(match[4] || 0, match[7]),
      minute: Number(match[5] || 0),
      second: Math.floor(Number(match[6] || 0)),
    };
  }

  match = text.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?\s*(AM|PM)?$/i);

  if (match && fallbackDate) {
    const dateParts = parseDateOnlyString(fallbackDate);
    if (!dateParts) return null;

    return {
      ...dateParts,
      hour: parseAmPmHour(match[1], match[4]),
      minute: Number(match[2] || 0),
      second: Math.floor(Number(match[3] || 0)),
    };
  }

  return null;
}

function parseDateParts(value, fallbackDate = "") {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const dateParts = {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
      hour: value.getHours(),
      minute: value.getMinutes(),
      second: value.getSeconds(),
    };

    if (dateParts.year <= 1900 && fallbackDate) {
      const fallbackParts = parseDateOnlyString(fallbackDate);
      return fallbackParts
        ? {
            ...fallbackParts,
            hour: dateParts.hour,
            minute: dateParts.minute,
            second: dateParts.second,
          }
        : null;
    }

    return dateParts;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const decoded = XLSX.SSF.parse_date_code(value);

    if (decoded) {
      if (decoded.y <= 1900 && fallbackDate) {
        const fallbackParts = parseDateOnlyString(fallbackDate);
        return fallbackParts
          ? {
              ...fallbackParts,
              hour: decoded.H || 0,
              minute: decoded.M || 0,
              second: Math.floor(decoded.S || 0),
            }
          : null;
      }

      return {
        year: decoded.y,
        month: decoded.m,
        day: decoded.d,
        hour: decoded.H || 0,
        minute: decoded.M || 0,
        second: Math.floor(decoded.S || 0),
      };
    }
  }

  return parseDateTimeString(value, fallbackDate);
}

function normalizeDate(value, fallbackDate = "") {
  return formatDateParts(parseDateParts(value, fallbackDate));
}

function normalizeDateTime(value, fallbackDate = "") {
  return formatDateTimeParts(parseDateParts(value, fallbackDate));
}

function dateTimeToEpoch(value) {
  const parts = parseDateTimeString(value);
  if (!parts) return Number.NaN;

  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
  );
}

function epochToDateTime(epoch) {
  return formatPseudoLocalDateTime(new Date(epoch));
}

function resolveActivityEndDateTime(row = {}) {
  const startEpoch = dateTimeToEpoch(row.startDateTime);
  const endEpoch = dateTimeToEpoch(row.endDateTime);
  const durationSeconds = Number(row.durationSeconds);
  const sourcePrecision = Number(row.sourcePrecision ?? 3);

  // When the source includes seconds (the combined XLSX workbook), use the
  // actual Start time and End time exactly like the Google Sheets formula.
  // The formatted Duration cell can be one second lower because of spreadsheet
  // floating-point formatting, so it must not replace a precise End time.
  if (
    sourcePrecision >= 2 &&
    Number.isFinite(startEpoch) &&
    Number.isFinite(endEpoch) &&
    endEpoch >= startEpoch
  ) {
    return row.endDateTime;
  }

  // A CSV export can hide seconds from Start time and End time. For those rows,
  // use the reconstructed timeline produced by prepareActivityRows().
  if (
    Number.isFinite(startEpoch) &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
  ) {
    return epochToDateTime(startEpoch + Math.round(durationSeconds) * 1000);
  }

  return row.endDateTime;
}

function durationBetweenDateTimes(startDateTime, endDateTime) {
  const startEpoch = dateTimeToEpoch(startDateTime);
  const endEpoch = dateTimeToEpoch(endDateTime);

  if (
    !Number.isFinite(startEpoch) ||
    !Number.isFinite(endEpoch) ||
    endEpoch < startEpoch
  ) {
    return 0;
  }

  return Math.max(0, Math.round((endEpoch - startEpoch) / 1000));
}

function addDayIfBefore(value, comparisonValue) {
  const valueEpoch = dateTimeToEpoch(value);
  const comparisonEpoch = dateTimeToEpoch(comparisonValue);

  if (!Number.isFinite(valueEpoch) || !Number.isFinite(comparisonEpoch)) {
    return value;
  }

  return valueEpoch < comparisonEpoch
    ? epochToDateTime(valueEpoch + 86_400_000)
    : value;
}

function buildHeaderIndex(headers) {
  const index = new Map();

  headers.forEach((header, columnIndex) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return;

    if (!index.has(normalized)) index.set(normalized, []);
    index.get(normalized).push(columnIndex);
  });

  return index;
}

function getIndexedValue(row, headerIndex, candidates, occurrence = 0) {
  for (const candidate of candidates) {
    const indexes = headerIndex.get(normalizeHeader(candidate));
    const columnIndex = indexes?.[occurrence];

    if (Number.isInteger(columnIndex)) {
      return row[columnIndex];
    }
  }

  return "";
}

function isMeaningfulAgentValue(value) {
  const text = cleanText(value);
  return Boolean(text && text !== "0" && text.toLowerCase() !== "false");
}

function rowToObject(headers, row) {
  const result = {};
  const duplicateCounter = new Map();

  headers.forEach((headerValue, index) => {
    const baseHeader = cleanText(headerValue) || `Column ${index + 1}`;
    const count = (duplicateCounter.get(baseHeader) || 0) + 1;
    duplicateCounter.set(baseHeader, count);
    const key = count === 1 ? baseHeader : `${baseHeader}_${count}`;
    const value = row[index];

    result[key] = value instanceof Date ? formatPseudoLocalDateTime(value) : value;
  });

  return result;
}

function stableHash(sourceType, row) {
  const stablePayload = Object.keys(row)
    .sort()
    .reduce((payload, key) => {
      payload[key] = row[key];
      return payload;
    }, {});

  return crypto
    .createHash("sha256")
    .update(`${sourceType}|${JSON.stringify(stablePayload)}`)
    .digest("hex");
}

function findHeaderRow(matrix, sourceHint = SOURCE_TYPES.AUTO) {
  const maximumRow = Math.min(matrix.length, 25);

  for (let rowIndex = 0; rowIndex < maximumRow; rowIndex += 1) {
    const headers = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
    const detectedSource = detectSourceFromHeaders(headers);

    if (
      detectedSource &&
      (sourceHint === SOURCE_TYPES.AUTO || detectedSource === sourceHint)
    ) {
      return {
        rowIndex,
        sourceType: detectedSource,
        headers,
      };
    }
  }

  return null;
}

function parseMsdSection({ sheetName, matrix, headerRow }) {
  const headerIndex = buildHeaderIndex(headerRow.headers);
  const records = [];

  for (let rowIndex = headerRow.rowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    const caseNumber = cleanText(
      getIndexedValue(row, headerIndex, ["Case Number"]),
      150,
    );
    const modifiedOnValue = getIndexedValue(row, headerIndex, ["Modified On"]);
    const resolutionValue = getIndexedValue(row, headerIndex, ["Resolution Date"]);
    const createdOnValue = getIndexedValue(row, headerIndex, ["Created On"]);
    const timestampValue = getIndexedValue(row, headerIndex, ["Timestamp"]);
    const modifiedBy = cleanText(
      getIndexedValue(row, headerIndex, ["Modified By"]),
      255,
    );
    const agentValue = getIndexedValue(row, headerIndex, ["Agent"]);
    const sourceAgentName = isMeaningfulAgentValue(agentValue)
      ? cleanText(agentValue, 255)
      : modifiedBy;

    if (!caseNumber && !modifiedOnValue && !sourceAgentName) continue;

    const status = cleanText(
      getIndexedValue(row, headerIndex, ["Status"]),
      150,
    );
    const timestampDateTime = normalizeDateTime(timestampValue);
    const modifiedOnDateTime = normalizeDateTime(modifiedOnValue);
    const resolutionDateTime = normalizeDateTime(resolutionValue);
    const createdOnDateTime = normalizeDateTime(createdOnValue);
    const selectedSourceDateTime =
      normalizeComparable(status) === "resolved"
        ? resolutionDateTime || modifiedOnDateTime
        : modifiedOnDateTime || resolutionDateTime;
    const modifiedDateTime =
      timestampDateTime || selectedSourceDateTime || createdOnDateTime;
    const productionDate = normalizeDate(modifiedDateTime);
    const rowJson = rowToObject(headerRow.headers, row);

    records.push({
      sourceType: SOURCE_TYPES.MSD,
      sheetName,
      productionDate,
      sourceAgentName,
      modifiedDateTime,
      sql: {
        timestamp_raw: normalizeDateTime(timestampValue),
        agent_raw: sourceAgentName,
        case_number: caseNumber,
        created_on_raw: normalizeDateTime(createdOnValue),
        modified_on_raw: modifiedDateTime,
        resolution_date_raw: normalizeDateTime(resolutionValue),
        created_by: cleanText(
          getIndexedValue(row, headerIndex, ["Created By"]),
          255,
        ),
        modified_by: modifiedBy,
        case_status: cleanText(
          getIndexedValue(row, headerIndex, ["Case Status"]),
          150,
        ),
        status,
        case_country: cleanText(
          getIndexedValue(row, headerIndex, ["casecountry", "Case Country"]),
          150,
        ),
        owner: cleanText(getIndexedValue(row, headerIndex, ["Owner"]), 255),
        origin: cleanText(getIndexedValue(row, headerIndex, ["Origin"]), 150),
        applicant: cleanText(
          getIndexedValue(row, headerIndex, ["Applicant"]),
          255,
        ),
        description: cleanText(
          getIndexedValue(row, headerIndex, ["Description"]),
          65_000,
        ),
        row_json: rowJson,
        row_hash: stableHash(SOURCE_TYPES.MSD, rowJson),
      },
    });
  }

  return records;
}

function parseCallSection({ sheetName, matrix, headerRow }) {
  const headerIndex = buildHeaderIndex(headerRow.headers);
  const records = [];

  for (let rowIndex = headerRow.rowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    const activityDate =
      normalizeDate(getIndexedValue(row, headerIndex, ["Date"])) ||
      normalizeDate(getIndexedValue(row, headerIndex, ["Timestamp"]));
    const sourceAgentName = cleanText(
      getIndexedValue(row, headerIndex, ["Agent name", "Agent"]),
      255,
    );
    const callId = cleanText(
      getIndexedValue(row, headerIndex, ["Call ID"]),
      120,
    );

    if (!activityDate && !sourceAgentName && !callId) continue;

    const answerDateTime = normalizeDateTime(
      getIndexedValue(row, headerIndex, ["Answer time"]),
      activityDate,
    );
    let endDateTime = normalizeDateTime(
      getIndexedValue(row, headerIndex, ["End time"]),
      activityDate,
    );
    endDateTime = addDayIfBefore(endDateTime, answerDateTime);

    const durationSeconds = parseDurationSeconds(
      getIndexedValue(row, headerIndex, ["Duration (sec)", "Duration"]),
    );
    const totalHoldSeconds = parseDurationSeconds(
      getIndexedValue(row, headerIndex, ["Total hold time (sec)"]),
    );
    const talkSecondsValue = getIndexedValue(row, headerIndex, ["Talk Time"]);
    const talkSeconds = parseDurationSeconds(talkSecondsValue) ||
      Math.max(0, durationSeconds - totalHoldSeconds);
    const rowJson = rowToObject(headerRow.headers, row);

    records.push({
      sourceType: SOURCE_TYPES.HD_CALLS,
      sheetName,
      productionDate: activityDate || normalizeDate(answerDateTime),
      activityDate: activityDate || normalizeDate(answerDateTime),
      sourceAgentName,
      answerDateTime,
      endDateTime,
      durationSeconds,
      totalHoldSeconds,
      sql: {
        timestamp_raw: normalizeDateTime(
          getIndexedValue(row, headerIndex, ["Timestamp"]),
          activityDate,
        ),
        agent_raw: cleanText(
          getIndexedValue(row, headerIndex, ["Agent"]),
          255,
        ),
        talk_seconds: talkSeconds,
        activity_date: activityDate || normalizeDate(answerDateTime) || null,
        call_id: callId,
        direction: cleanText(
          getIndexedValue(row, headerIndex, ["Direction"]),
          80,
        ),
        arrival_time_raw: normalizeDateTime(
          getIndexedValue(row, headerIndex, ["Arrival time in IVR"]),
          activityDate,
        ),
        arrival_queue_time_raw: normalizeDateTime(
          getIndexedValue(row, headerIndex, ["Arrival time in queue"]),
          activityDate,
        ),
        answer_time_raw: answerDateTime,
        end_time_raw: endDateTime,
        agent_name: sourceAgentName,
        skill: cleanText(getIndexedValue(row, headerIndex, ["Skill"]), 255),
        disconnect_indicator: cleanText(
          getIndexedValue(row, headerIndex, ["Disconnect initiator"]),
          120,
        ),
        duration_seconds: durationSeconds,
        total_hold_seconds: totalHoldSeconds,
        total_hold_count: Math.max(
          0,
          Math.round(
            Number(
              getIndexedValue(row, headerIndex, ["Total hold count"]),
            ) || 0,
          ),
        ),
        row_json: rowJson,
        row_hash: stableHash(SOURCE_TYPES.HD_CALLS, rowJson),
      },
    });
  }

  return records;
}

function parseActivitySection({ sheetName, matrix, headerRow }) {
  const headerIndex = buildHeaderIndex(headerRow.headers);
  const records = [];

  for (let rowIndex = headerRow.rowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    const activityDate =
      normalizeDate(getIndexedValue(row, headerIndex, ["Date"])) ||
      normalizeDate(getIndexedValue(row, headerIndex, ["Timestamp"]));
    const sourceAgentName = cleanText(
      getIndexedValue(row, headerIndex, ["Agent name", "Agent"]),
      255,
    );
    const status = cleanText(
      getIndexedValue(row, headerIndex, ["Status"]),
      100,
    );

    if (!activityDate && !sourceAgentName && !status) continue;

    const startDateTime = normalizeDateTime(
      getIndexedValue(row, headerIndex, ["Start time", "Timestamp"]),
      activityDate,
    );
    let endDateTime = normalizeDateTime(
      getIndexedValue(row, headerIndex, ["End time"]),
      activityDate,
    );
    endDateTime = addDayIfBefore(endDateTime, startDateTime);

    const parsedDurationSeconds = parseDurationSeconds(
      getIndexedValue(row, headerIndex, ["Duration", "Duration (sec)"], 0),
    );
    const calculatedDurationSeconds = durationBetweenDateTimes(
      startDateTime,
      endDateTime,
    );
    const durationSeconds = Number.isFinite(parsedDurationSeconds)
      ? parsedDurationSeconds || calculatedDurationSeconds
      : calculatedDurationSeconds;
    const durationTextValue = getIndexedValue(
      row,
      headerIndex,
      ["Duration"],
      1,
    );
    const rowJson = rowToObject(headerRow.headers, row);

    records.push({
      sourceType: SOURCE_TYPES.HD_ACTIVITY,
      sheetName,
      productionDate: activityDate || normalizeDate(startDateTime),
      activityDate: activityDate || normalizeDate(startDateTime),
      sourceAgentName,
      startDateTime,
      endDateTime,
      status,
      durationSeconds,
      sql: {
        timestamp_raw: normalizeDateTime(
          getIndexedValue(row, headerIndex, ["Timestamp"]),
          activityDate,
        ),
        agent_raw: cleanText(
          getIndexedValue(row, headerIndex, ["Agent"]),
          255,
        ),
        duration_seconds: durationSeconds,
        activity_date: activityDate || normalizeDate(startDateTime) || null,
        agent_name: sourceAgentName,
        start_time_raw: startDateTime,
        end_time_raw: endDateTime,
        duration_text:
          cleanText(durationTextValue, 100) || String(durationSeconds),
        status,
        row_json: rowJson,
        row_hash: stableHash(SOURCE_TYPES.HD_ACTIVITY, rowJson),
      },
    });
  }

  return records;
}

function parseDetectedSection(section) {
  switch (section.headerRow.sourceType) {
    case SOURCE_TYPES.MSD:
      return parseMsdSection(section);
    case SOURCE_TYPES.HD_CALLS:
      return parseCallSection(section);
    case SOURCE_TYPES.HD_ACTIVITY:
      return parseActivitySection(section);
    default:
      return [];
  }
}

export function parseRawWorkbook(buffer, fileName, sourceTypeHint = SOURCE_TYPES.AUTO) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError("The uploaded file is empty.");
  }

  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: false,
    cellFormula: false,
    cellHTML: false,
    dense: false,
  });

  const normalizedHint = normalizeSourceType(sourceTypeHint);
  const sections = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet?.["!ref"]) continue;

    const matrix = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      raw: true,
      blankrows: false,
    });

    const nameType = detectSourceFromSheetName(sheetName);
    const effectiveHint =
      normalizedHint !== SOURCE_TYPES.AUTO
        ? normalizedHint
        : nameType || SOURCE_TYPES.AUTO;
    const headerRow =
      findHeaderRow(matrix, effectiveHint) ||
      (effectiveHint !== SOURCE_TYPES.AUTO
        ? findHeaderRow(matrix, SOURCE_TYPES.AUTO)
        : null);

    if (!headerRow) continue;

    const records = parseDetectedSection({
      sheetName,
      matrix,
      headerRow,
    });

    if (records.length > 0) {
      sections.push({
        sheetName,
        sourceType: headerRow.sourceType,
        records,
      });
    }
  }

  if (sections.length === 0) {
    throw new TypeError(
      "No supported raw-data sheet was detected. Use the MSD, HD Call Report, or HD Agent Statistics format.",
    );
  }

  const totalRows = sections.reduce(
    (total, section) => total + section.records.length,
    0,
  );

  if (totalRows > MAX_IMPORT_ROWS) {
    throw new RangeError(
      `The file contains ${totalRows.toLocaleString()} rows. The maximum per upload is ${MAX_IMPORT_ROWS.toLocaleString()} rows.`,
    );
  }

  const productionDates = Array.from(
    new Set(
      sections
        .flatMap((section) => section.records)
        .map((record) => record.productionDate)
        .filter(Boolean),
    ),
  ).sort();

  return {
    fileName: cleanText(fileName, 255),
    sections,
    productionDates,
    totalRows,
  };
}

function normalizeEmployeeRecord(employee = {}) {
  return {
    employeeUid: cleanText(
      employee.employeeUid || employee.employee_uid,
      100,
    ),
    sibsId: normalizeSibsId(
      employee.sibsId || employee.employee_id || employee.employee_number,
    ),
    employeeName: cleanText(
      employee.employeeName || employee.employee_name,
      255,
    ),
    heroDash: cleanText(employee.heroDash || employee.herodash, 255),
    msd: cleanText(employee.msd, 255),
  };
}

function addEmployeeAlias(aliasMap, aliasValue, employee) {
  const normalized = normalizeComparable(aliasValue);
  if (!normalized || !employee.employeeUid) return;

  if (!aliasMap.has(normalized)) aliasMap.set(normalized, new Map());
  aliasMap.get(normalized).set(employee.employeeUid, employee);
}

function uniqueEmployeeFromAliasMap(aliasMap, normalizedValue) {
  const candidates = aliasMap.get(normalizedValue);
  if (!candidates || candidates.size !== 1) return null;
  return [...candidates.values()][0];
}

export function buildEmployeeMatcher(employees = [], aliases = []) {
  const normalizedEmployees = (Array.isArray(employees) ? employees : [])
    .map(normalizeEmployeeRecord)
    .filter((employee) => employee.employeeUid && employee.employeeName);

  const heroDashMap = new Map();
  const msdMap = new Map();
  const officialMap = new Map();

  normalizedEmployees.forEach((employee) => {
    addEmployeeAlias(officialMap, employee.employeeName, employee);
    addEmployeeAlias(heroDashMap, employee.heroDash, employee);
    addEmployeeAlias(msdMap, employee.msd, employee);

    // Exact official-name fallback is safe only when it resolves uniquely.
    addEmployeeAlias(heroDashMap, employee.employeeName, employee);
    addEmployeeAlias(msdMap, employee.employeeName, employee);
  });

  (Array.isArray(aliases) ? aliases : []).forEach((alias) => {
    const employee = normalizedEmployees.find(
      (item) => item.employeeUid === cleanText(alias.employee_uid, 100),
    );
    if (!employee) return;

    const sourceSystem = normalizeComparable(alias.source_system);
    const sourceValue = alias.source_agent_name || alias.source_agent_key;

    if (sourceSystem.includes("msd")) {
      addEmployeeAlias(msdMap, sourceValue, employee);
    } else if (sourceSystem.includes("hero")) {
      addEmployeeAlias(heroDashMap, sourceValue, employee);
    }
  });

  const msdContainsAliases = [...msdMap.entries()]
    .filter(([aliasValue, candidateMap]) => aliasValue.length >= 5 && candidateMap.size === 1)
    .map(([aliasValue, candidateMap]) => ({
      aliasValue,
      employee: [...candidateMap.values()][0],
    }))
    .sort((a, b) => b.aliasValue.length - a.aliasValue.length);

  function match(sourceType, sourceValue) {
    const normalizedValue = normalizeComparable(sourceValue);
    if (!normalizedValue) return null;

    const exactMap =
      sourceType === SOURCE_TYPES.MSD ? msdMap : heroDashMap;
    const exactMatch = uniqueEmployeeFromAliasMap(exactMap, normalizedValue);
    if (exactMatch) return exactMatch;

    const officialMatch = uniqueEmployeeFromAliasMap(
      officialMap,
      normalizedValue,
    );
    if (officialMatch) return officialMatch;

    if (sourceType === SOURCE_TYPES.MSD) {
      const containedMatches = msdContainsAliases.filter(({ aliasValue }) =>
        normalizedValue.includes(aliasValue),
      );

      if (containedMatches.length > 0) {
        const longestLength = containedMatches[0].aliasValue.length;
        const longestEmployees = new Map(
          containedMatches
            .filter(({ aliasValue }) => aliasValue.length === longestLength)
            .map(({ employee }) => [employee.employeeUid, employee]),
        );

        if (longestEmployees.size === 1) {
          return [...longestEmployees.values()][0];
        }
      }
    }

    return null;
  }

  return {
    employees: normalizedEmployees,
    match,
  };
}

function getHourStartEpoch(productionDate, hour) {
  return dateTimeToEpoch(
    `${productionDate} ${pad2(hour)}:00:00`,
  );
}

function overlapSeconds(startDateTime, endDateTime, rangeStart, rangeEnd) {
  const start = dateTimeToEpoch(startDateTime);
  const end = dateTimeToEpoch(endDateTime);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }

  return Math.max(0, Math.round((Math.min(end, rangeEnd) - Math.max(start, rangeStart)) / 1000));
}


function parseStoredRowJson(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function hasExplicitSecondComponent(value) {
  if (value instanceof Date || typeof value === "number") return true;

  const text = cleanText(value);
  return /(?:^|[ T])\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*[AP]M)?$/i.test(text);
}

function getActivitySourcePrecision(row = {}) {
  const explicitValue = Number(row.sourcePrecision);
  if (Number.isFinite(explicitValue) && explicitValue > 0) {
    return explicitValue;
  }

  const sourceRow = parseStoredRowJson(row.rowJson || row.row_json);
  const sourceStart =
    sourceRow["Start time"] ?? sourceRow.start_time ?? sourceRow.startTime;
  const sourceEnd =
    sourceRow["End time"] ?? sourceRow.end_time ?? sourceRow.endTime;
  const sourceTimestamp = sourceRow.Timestamp ?? sourceRow.timestamp;

  // Direct calculator inputs and legacy rows may not include row_json. A
  // duration that differs materially from the visible Start/End range means
  // the CSV display hid seconds, so treat it as minute-only data.
  if (Object.keys(sourceRow).length === 0) {
    const durationSeconds = Number(row.durationSeconds);
    const displayedDuration = durationBetweenDateTimes(
      row.startDateTime,
      row.endDateTime,
    );

    if (
      Number.isFinite(durationSeconds) &&
      durationSeconds > 0 &&
      Math.abs(durationSeconds - displayedDuration) > 1
    ) {
      return 1;
    }
  }

  if (
    sourceTimestamp !== undefined ||
    hasExplicitSecondComponent(sourceStart) ||
    hasExplicitSecondComponent(sourceEnd) ||
    hasExplicitSecondComponent(row.startDateTime) ||
    hasExplicitSecondComponent(row.endDateTime)
  ) {
    return 3;
  }

  return 1;
}

function minuteEpoch(value) {
  const epoch = dateTimeToEpoch(value);
  return Number.isFinite(epoch) ? Math.floor(epoch / 60_000) * 60_000 : Number.NaN;
}

function isNearDuplicateActivity(first, second) {
  if (
    first.employeeUid !== second.employeeUid ||
    first.activityDate !== second.activityDate ||
    normalizeComparable(first.status) !== normalizeComparable(second.status)
  ) {
    return false;
  }

  const firstStart = dateTimeToEpoch(first.startDateTime);
  const secondStart = dateTimeToEpoch(second.startDateTime);
  const firstEnd = dateTimeToEpoch(first.endDateTime);
  const secondEnd = dateTimeToEpoch(second.endDateTime);

  if (
    !Number.isFinite(firstStart) ||
    !Number.isFinite(secondStart) ||
    !Number.isFinite(firstEnd) ||
    !Number.isFinite(secondEnd)
  ) {
    return false;
  }

  const firstDuration = Math.max(0, Number(first.durationSeconds) || 0);
  const secondDuration = Math.max(0, Number(second.durationSeconds) || 0);

  return (
    Math.abs(firstStart - secondStart) < 60_000 &&
    Math.abs(firstEnd - secondEnd) < 60_000 &&
    Math.abs(firstDuration - secondDuration) <= 2
  );
}

function dedupeActivityRows(rows = []) {
  const ordered = [...rows].sort((first, second) => {
    const precisionDifference =
      getActivitySourcePrecision(second) - getActivitySourcePrecision(first);
    if (precisionDifference !== 0) return precisionDifference;

    return Number(first.sourceRowId || 0) - Number(second.sourceRowId || 0);
  });
  const accepted = [];

  ordered.forEach((candidate) => {
    if (accepted.some((existing) => isNearDuplicateActivity(existing, candidate))) {
      return;
    }

    accepted.push({
      ...candidate,
      sourcePrecision: getActivitySourcePrecision(candidate),
    });
  });

  return accepted;
}

function inferMinuteOnlyStart(row) {
  const startMinute = minuteEpoch(row.startDateTime);
  let endMinute = minuteEpoch(row.endDateTime);
  const durationSeconds = Math.max(0, Math.round(Number(row.durationSeconds) || 0));

  if (!Number.isFinite(startMinute)) return Number.NaN;
  if (!Number.isFinite(endMinute)) return startMinute;
  if (endMinute < startMinute) endMinute += 86_400_000;

  const inferredStart = endMinute - durationSeconds * 1000;
  const minuteEnd = startMinute + 59_000;

  return Math.min(minuteEnd, Math.max(startMinute, inferredStart));
}

function reconstructMinuteOnlyActivityRows(rows = []) {
  const groups = new Map();

  rows.forEach((row) => {
    const key = `${row.employeeUid}|${row.activityDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  const reconstructed = [];

  groups.forEach((groupRows) => {
    const ordered = [...groupRows].sort((first, second) => {
      const firstId = Number(first.sourceRowId || 0);
      const secondId = Number(second.sourceRowId || 0);
      if (firstId && secondId && firstId !== secondId) return firstId - secondId;

      return dateTimeToEpoch(first.startDateTime) - dateTimeToEpoch(second.startDateTime);
    });

    let previousEnd = Number.NaN;

    ordered.forEach((row) => {
      const precision = getActivitySourcePrecision(row);
      if (precision >= 2) {
        reconstructed.push({ ...row, sourcePrecision: precision });
        previousEnd = dateTimeToEpoch(row.endDateTime);
        return;
      }

      const displayedStartMinute = minuteEpoch(row.startDateTime);
      const durationSeconds = Math.max(
        0,
        Math.round(Number(row.durationSeconds) || 0),
      );
      let startEpoch = inferMinuteOnlyStart(row);

      if (
        Number.isFinite(previousEnd) &&
        Number.isFinite(displayedStartMinute) &&
        Math.floor(previousEnd / 60_000) * 60_000 === displayedStartMinute
      ) {
        startEpoch = previousEnd;
      }

      if (!Number.isFinite(startEpoch)) {
        reconstructed.push({ ...row, sourcePrecision: precision });
        previousEnd = Number.NaN;
        return;
      }

      let endEpoch = startEpoch + durationSeconds * 1000;
      const displayedEndMinute = minuteEpoch(row.endDateTime);

      // Some spreadsheet duration cells are displayed one second lower. Add
      // that second only when it is required to land in the displayed end minute.
      if (
        Number.isFinite(displayedEndMinute) &&
        Math.floor(endEpoch / 60_000) * 60_000 !== displayedEndMinute &&
        Math.floor((endEpoch + 1000) / 60_000) * 60_000 === displayedEndMinute
      ) {
        endEpoch += 1000;
      }

      reconstructed.push({
        ...row,
        startDateTime: epochToDateTime(startEpoch),
        endDateTime: epochToDateTime(endEpoch),
        sourcePrecision: 2,
      });
      previousEnd = endEpoch;
    });
  });

  return reconstructed;
}

function prepareActivityRows(rows = []) {
  return reconstructMinuteOnlyActivityRows(dedupeActivityRows(rows));
}

function isNearDuplicateCall(first, second) {
  if (
    first.employeeUid !== second.employeeUid ||
    first.activityDate !== second.activityDate
  ) {
    return false;
  }

  if (
    first.sourceRecordId &&
    second.sourceRecordId &&
    normalizeComparable(first.sourceRecordId) === normalizeComparable(second.sourceRecordId)
  ) {
    return true;
  }

  const firstStart = dateTimeToEpoch(first.answerDateTime);
  const secondStart = dateTimeToEpoch(second.answerDateTime);
  const firstEnd = dateTimeToEpoch(first.endDateTime);
  const secondEnd = dateTimeToEpoch(second.endDateTime);

  return (
    Number.isFinite(firstStart) &&
    Number.isFinite(secondStart) &&
    Number.isFinite(firstEnd) &&
    Number.isFinite(secondEnd) &&
    Math.abs(firstStart - secondStart) <= 1000 &&
    Math.abs(firstEnd - secondEnd) <= 1000 &&
    Math.abs((Number(first.durationSeconds) || 0) - (Number(second.durationSeconds) || 0)) <= 1 &&
    Math.abs((Number(first.totalHoldSeconds) || 0) - (Number(second.totalHoldSeconds) || 0)) <= 1
  );
}

function dedupeCallRows(rows = []) {
  const accepted = [];

  rows.forEach((candidate) => {
    if (accepted.some((existing) => isNearDuplicateCall(existing, candidate))) {
      return;
    }
    accepted.push(candidate);
  });

  return accepted;
}

function dedupeEmailRows(rows = []) {
  const seen = new Set();
  const accepted = [];

  rows.forEach((row) => {
    const sourceRecordId = normalizeComparable(row.sourceRecordId);
    const key = sourceRecordId
      ? `id|${sourceRecordId}`
      : [
          row.employeeUid,
          normalizeDateTime(row.modifiedDateTime),
          normalizeComparable(row.sourceAgentName),
        ].join("|");

    if (seen.has(key)) return;
    seen.add(key);
    accepted.push(row);
  });

  return accepted;
}

export function calculateHourlySummaries({
  productionDates = [],
  employees = [],
  activityRows = [],
  callRows = [],
  emailRows = [],
} = {}) {
  const employeeByUid = new Map(
    employees
      .map((employee) => ({
        employeeUid: cleanText(
          employee.employeeUid || employee.employee_uid,
          100,
        ),
        employeeName: cleanText(
          employee.employeeName || employee.employee_name,
          255,
        ),
      }))
      .filter((employee) => employee.employeeUid && employee.employeeName)
      .map((employee) => [employee.employeeUid, employee]),
  );

  const allowedDates = new Set(productionDates.filter(Boolean));
  const eventsByKey = new Map();

  function getBucket(employeeUid, productionDate) {
    if (!employeeByUid.has(employeeUid) || !productionDate) return null;
    if (allowedDates.size > 0 && !allowedDates.has(productionDate)) return null;

    const key = `${employeeUid}|${productionDate}`;

    if (!eventsByKey.has(key)) {
      eventsByKey.set(key, {
        employee: employeeByUid.get(employeeUid),
        productionDate,
        activity: [],
        calls: [],
        emails: [],
      });
    }

    return eventsByKey.get(key);
  }

  prepareActivityRows(activityRows).forEach((row) => {
    getBucket(row.employeeUid, row.activityDate)?.activity.push(row);
  });
  dedupeCallRows(callRows).forEach((row) => {
    getBucket(row.employeeUid, row.activityDate)?.calls.push(row);
  });
  dedupeEmailRows(emailRows).forEach((row) => {
    getBucket(
      row.employeeUid,
      normalizeDate(row.modifiedDateTime),
    )?.emails.push(row);
  });

  const summaries = [];

  for (const bucket of eventsByKey.values()) {
    for (
      let intervalHour = REPORT_START_HOUR;
      intervalHour <= REPORT_END_HOUR;
      intervalHour += 1
    ) {
      const hourStart = getHourStartEpoch(bucket.productionDate, intervalHour);
      const hourEnd = hourStart + 3_600_000;

      const actualLoggedSeconds = Math.min(
        3600,
        bucket.activity.reduce((total, row) => {
          const status = normalizeComparable(row.status);
          if (!LOGGED_ACTIVITY_STATUSES.has(status)) return total;

          return total + overlapSeconds(
            row.startDateTime,
            resolveActivityEndDateTime(row),
            hourStart,
            hourEnd,
          );
        }, 0),
      );

      const productionSeconds = Math.min(
        3600,
        bucket.activity.reduce((total, row) => {
          const status = normalizeComparable(row.status);
          if (!AVAILABLE_ACTIVITY_STATUSES.has(status)) return total;

          return total + overlapSeconds(
            row.startDateTime,
            resolveActivityEndDateTime(row),
            hourStart,
            hourEnd,
          );
        }, 0),
      );

      const hourCalls = bucket.calls.filter(
        (row) =>
          overlapSeconds(
            row.answerDateTime,
            row.endDateTime,
            hourStart,
            hourEnd,
          ) > 0,
      );
      const handledCalls = hourCalls.length;
      const totalHoldSeconds = hourCalls.reduce(
        (total, row) =>
          total + Math.max(0, Number(row.totalHoldSeconds) || 0),
        0,
      );
      const totalTalkSeconds = hourCalls.reduce(
        (total, row) =>
          total + Math.max(
            0,
            (Number(row.durationSeconds) || 0) -
              (Number(row.totalHoldSeconds) || 0),
          ),
        0,
      );
      const trueHandlingSeconds = hourCalls.reduce(
        (total, row) =>
          total + overlapSeconds(
            row.answerDateTime,
            row.endDateTime,
            hourStart,
            hourEnd,
          ),
        0,
      );

      const avgTalkSeconds = handledCalls
        ? Math.round(totalTalkSeconds / handledCalls)
        : 0;
      const avgHoldSeconds = handledCalls
        ? Math.round(totalHoldSeconds / handledCalls)
        : 0;
      const availableSeconds = Math.max(
        0,
        productionSeconds - trueHandlingSeconds,
      );

      // Excel: ((AVG Talk * Calls) + (AVG Hold * Calls)) /
      //        (((AVG Talk * Calls) + (AVG Hold * Calls)) + Avail Time)
      const callHandlingSeconds = totalTalkSeconds + totalHoldSeconds;
      const occupancyDenominator = callHandlingSeconds + availableSeconds;
      const phoneOccupancyFraction =
        handledCalls > 0 && occupancyDenominator > 0
          ? callHandlingSeconds / occupancyDenominator
          : 0;
      const phoneOccupancyPct = round(phoneOccupancyFraction * 100);

      // Excel columns J and K:
      // Available Email Capacity = Actual Logged Time * (1 - Phone Occupancy)
      // Target Emails = Available Email Capacity / 240
      const emailCapacityExact = Math.max(
        0,
        actualLoggedSeconds * (1 - phoneOccupancyFraction),
      );
      const targetEmailsExact =
        emailCapacityExact / EMAIL_SECONDS_PER_TARGET;

      const actualEmails = bucket.emails.filter((row) => {
        const modifiedEpoch = dateTimeToEpoch(row.modifiedDateTime);
        return modifiedEpoch >= hourStart && modifiedEpoch < hourEnd;
      }).length;
      const emailUtilizationFraction = targetEmailsExact > 0
        ? actualEmails / targetEmailsExact
        : 0;
      const emailUtilizationPct = round(emailUtilizationFraction * 100);

      // Excel Actual Efficiency:
      // ((Actual Logged Time * Phone Occupancy) +
      //  (Email Utilization * Available Email Capacity)) /
      // Expected Hours(sec)
      //
      // Keep the unrounded fractions for the calculation. The table can round
      // Phone Occupancy, Email Capacity, and Target Emails for display only.
      const expectedSeconds = actualLoggedSeconds > 0 ? 3600 : 0;
      const phoneProductiveSeconds =
        actualLoggedSeconds * phoneOccupancyFraction;
      const emailProductiveSeconds =
        emailUtilizationFraction * emailCapacityExact;
      const totalProductiveSeconds =
        phoneProductiveSeconds + emailProductiveSeconds;
      const actualEfficiencyPct = expectedSeconds > 0
        ? round(
            Math.max(
              0,
              Math.min(1, totalProductiveSeconds / expectedSeconds),
            ) * 100,
          )
        : 0;

      if (
        actualLoggedSeconds === 0 &&
        handledCalls === 0 &&
        actualEmails === 0
      ) {
        continue;
      }

      summaries.push({
        productionDate: bucket.productionDate,
        employeeUid: bucket.employee.employeeUid,
        employeeName: bucket.employee.employeeName,
        intervalHour,
        expectedSeconds,
        actualLoggedSeconds,
        handledCalls,
        avgTalkSeconds,
        avgHoldSeconds,
        availableSeconds,
        phoneOccupancyPct,
        emailCapacity: Math.round(emailCapacityExact),
        targetEmails: Math.round(targetEmailsExact),
        actualEmails,
        emailUtilizationPct,
        actualEfficiencyPct,
      });
    }
  }

  return summaries.sort((a, b) =>
    a.productionDate.localeCompare(b.productionDate) ||
    a.employeeName.localeCompare(b.employeeName, undefined, {
      sensitivity: "base",
    }) ||
    a.intervalHour - b.intervalHour,
  );
}

async function loadEmployeeMatcher(connection) {
  const [employees] = await connection.query(
    `
      SELECT
        employee_uid,
        employee_id,
        employee_number,
        employee_name,
        herodash,
        msd
      FROM ${TABLES.employees}
      WHERE LOWER(TRIM(account_name)) = 'us visa'
        AND LOWER(TRIM(status)) NOT IN ('inactive', 'resigned', 'terminated', 'separated', 'awol')
        AND LOWER(TRIM(employment_status)) NOT IN ('inactive', 'resigned', 'terminated', 'separated', 'awol')
        AND NULLIF(TRIM(employee_uid), '') IS NOT NULL
    `,
  );

  const [aliases] = await connection.query(
    `
      SELECT employee_uid, source_system, source_agent_name, source_agent_key
      FROM ${TABLES.aliases}
      WHERE is_active = 1
    `,
  );

  return buildEmployeeMatcher(employees, aliases);
}

function buildMatchSummary(parsedFile, matcher) {
  const sourceSummaries = [];
  const unmatchedByKey = new Map();

  for (const section of parsedFile.sections) {
    let matchedRows = 0;
    let unmatchedRows = 0;

    section.records.forEach((record) => {
      const employee = matcher.match(
        section.sourceType,
        record.sourceAgentName,
      );

      if (employee) {
        matchedRows += 1;
      } else {
        unmatchedRows += 1;
        const name = cleanText(record.sourceAgentName, 255) || "(blank name)";
        const key = `${section.sourceType}|${normalizeComparable(name)}`;
        const current = unmatchedByKey.get(key) || {
          sourceType: section.sourceType,
          sourceLabel: SOURCE_LABELS[section.sourceType],
          name,
          rows: 0,
        };
        current.rows += 1;
        unmatchedByKey.set(key, current);
      }
    });

    sourceSummaries.push({
      sourceType: section.sourceType,
      sourceLabel: SOURCE_LABELS[section.sourceType],
      sheetName: section.sheetName,
      detectedRows: section.records.length,
      matchedRows,
      unmatchedRows,
    });
  }

  return {
    sourceSummaries,
    unmatchedNames: [...unmatchedByKey.values()]
      .sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name))
      .slice(0, 100),
  };
}

async function findExistingHashes(connection, tableName, hashes) {
  const existing = new Set();

  for (let index = 0; index < hashes.length; index += HASH_LOOKUP_CHUNK_SIZE) {
    const chunk = hashes.slice(index, index + HASH_LOOKUP_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    const [rows] = await connection.query(
      `SELECT row_hash FROM ${tableName} WHERE row_hash IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );

    rows.forEach((row) => existing.add(row.row_hash));
  }

  return existing;
}

async function insertRawRows(
  connection,
  tableName,
  batchId,
  columns,
  records,
) {
  if (records.length === 0) {
    return { inserted: 0, duplicates: 0 };
  }

  const hashes = [...new Set(records.map((record) => record.sql.row_hash))];
  const existingHashes = await findExistingHashes(
    connection,
    tableName,
    hashes,
  );
  const seenInFile = new Set();
  const newRecords = records.filter((record) => {
    const hash = record.sql.row_hash;

    if (existingHashes.has(hash) || seenInFile.has(hash)) return false;
    seenInFile.add(hash);
    return true;
  });

  for (let index = 0; index < newRecords.length; index += INSERT_CHUNK_SIZE) {
    const chunk = newRecords.slice(index, index + INSERT_CHUNK_SIZE);
    const allColumns = ["batch_id", ...columns];
    const rowPlaceholder = `(${allColumns.map(() => "?").join(",")})`;
    const values = [];

    chunk.forEach((record) => {
      values.push(batchId);
      columns.forEach((column) => {
        const value = record.sql[column];
        values.push(
          column === "row_json"
            ? JSON.stringify(value || {})
            : typeof value === "number" && !Number.isFinite(value)
              ? 0
              : value === "" || value === null || value === undefined
                ? null
                : value,
        );
      });
    });

    await connection.query(
      `
        INSERT INTO ${tableName} (${allColumns.join(",")})
        VALUES ${chunk.map(() => rowPlaceholder).join(",")}
      `,
      values,
    );
  }

  return {
    inserted: newRecords.length,
    duplicates: records.length - newRecords.length,
  };
}

function sourceTableConfig(sourceType) {
  switch (sourceType) {
    case SOURCE_TYPES.MSD:
      return {
        table: TABLES.emails,
        columns: [
          "timestamp_raw",
          "agent_raw",
          "case_number",
          "created_on_raw",
          "modified_on_raw",
          "resolution_date_raw",
          "created_by",
          "modified_by",
          "case_status",
          "status",
          "case_country",
          "owner",
          "origin",
          "applicant",
          "description",
          "row_json",
          "row_hash",
        ],
      };
    case SOURCE_TYPES.HD_CALLS:
      return {
        table: TABLES.calls,
        columns: [
          "timestamp_raw",
          "agent_raw",
          "talk_seconds",
          "activity_date",
          "call_id",
          "direction",
          "arrival_time_raw",
          "arrival_queue_time_raw",
          "answer_time_raw",
          "end_time_raw",
          "agent_name",
          "skill",
          "disconnect_indicator",
          "duration_seconds",
          "total_hold_seconds",
          "total_hold_count",
          "row_json",
          "row_hash",
        ],
      };
    case SOURCE_TYPES.HD_ACTIVITY:
      return {
        table: TABLES.activity,
        columns: [
          "timestamp_raw",
          "agent_raw",
          "duration_seconds",
          "activity_date",
          "agent_name",
          "start_time_raw",
          "end_time_raw",
          "duration_text",
          "status",
          "row_json",
          "row_hash",
        ],
      };
    default:
      throw new TypeError(`Unsupported source type: ${sourceType}`);
  }
}

function normalizeDatabaseActivityRows(rows, matcher, targetDates) {
  return rows.flatMap((row) => {
    const activityDate = normalizeDate(row.activity_date || row.start_time_raw);
    if (!targetDates.has(activityDate)) return [];

    const employee = matcher.match(
      SOURCE_TYPES.HD_ACTIVITY,
      row.agent_name || row.agent_raw,
    );
    if (!employee) return [];

    return [{
      employeeUid: employee.employeeUid,
      activityDate,
      startDateTime: normalizeDateTime(row.start_time_raw, activityDate),
      endDateTime: normalizeDateTime(row.end_time_raw, activityDate),
      durationSeconds: Math.max(0, Number(row.duration_seconds) || 0),
      status: cleanText(row.status, 100),
      sourceRowId: Number(row.id || 0),
      sourceBatchId: Number(row.batch_id || 0),
      rowJson: row.row_json,
      sourcePrecision: getActivitySourcePrecision({
        rowJson: row.row_json,
        row_json: row.row_json,
        timestamp_raw: row.timestamp_raw,
      }),
    }];
  });
}

function normalizeDatabaseCallRows(rows, matcher, targetDates) {
  return rows.flatMap((row) => {
    const activityDate = normalizeDate(row.activity_date || row.answer_time_raw);
    if (!targetDates.has(activityDate)) return [];

    const employee = matcher.match(
      SOURCE_TYPES.HD_CALLS,
      row.agent_name || row.agent_raw,
    );
    if (!employee) return [];

    const answerDateTime = normalizeDateTime(row.answer_time_raw, activityDate);
    const endDateTime = addDayIfBefore(
      normalizeDateTime(row.end_time_raw, activityDate),
      answerDateTime,
    );

    return [{
      employeeUid: employee.employeeUid,
      activityDate,
      answerDateTime,
      endDateTime,
      durationSeconds: Number(row.duration_seconds) || 0,
      totalHoldSeconds: Number(row.total_hold_seconds) || 0,
      sourceRowId: Number(row.id || 0),
      sourceBatchId: Number(row.batch_id || 0),
      sourceRecordId: cleanText(row.call_id, 150),
    }];
  });
}

function resolveMsdEventDateTime(row = {}) {
  const timestampDateTime = normalizeDateTime(row.timestamp_raw);
  const modifiedOnDateTime = normalizeDateTime(row.modified_on_raw);
  const resolutionDateTime = normalizeDateTime(row.resolution_date_raw);
  const createdOnDateTime = normalizeDateTime(row.created_on_raw);
  const selectedSourceDateTime =
    normalizeComparable(row.status) === "resolved"
      ? resolutionDateTime || modifiedOnDateTime
      : modifiedOnDateTime || resolutionDateTime;

  return timestampDateTime || selectedSourceDateTime || createdOnDateTime;
}

function normalizeDatabaseEmailRows(rows, matcher, targetDates) {
  return rows.flatMap((row) => {
    const modifiedDateTime = resolveMsdEventDateTime(row);
    const productionDate = normalizeDate(modifiedDateTime);
    if (!targetDates.has(productionDate)) return [];

    const employee = matcher.match(
      SOURCE_TYPES.MSD,
      row.agent_raw || row.modified_by,
    );
    if (!employee) return [];

    return [{
      employeeUid: employee.employeeUid,
      modifiedDateTime,
      sourceRowId: Number(row.id || 0),
      sourceBatchId: Number(row.batch_id || 0),
      sourceRecordId: cleanText(row.case_number, 150),
      sourceAgentName: cleanText(row.agent_raw || row.modified_by, 255),
    }];
  });
}

async function rebuildHourlySummary(
  connection,
  productionDates,
  batchId,
  matcher,
) {
  const dates = [...new Set(productionDates.filter(Boolean))].sort();
  if (dates.length === 0) return 0;

  const placeholders = dates.map(() => "?").join(",");
  const [activityRows] = await connection.query(
    `
      SELECT id, batch_id, timestamp_raw, row_json,
             activity_date, agent_name, agent_raw, start_time_raw, end_time_raw,
             duration_seconds, status
      FROM ${TABLES.activity}
      WHERE activity_date IN (${placeholders})
    `,
    dates,
  );
  const [callRows] = await connection.query(
    `
      SELECT id, batch_id, call_id, row_json,
             activity_date, agent_name, agent_raw, answer_time_raw, end_time_raw,
             duration_seconds, total_hold_seconds
      FROM ${TABLES.calls}
      WHERE activity_date IN (${placeholders})
    `,
    dates,
  );
  const [emailRows] = await connection.query(
    `
      SELECT id, batch_id, case_number, row_json,
             agent_raw, modified_by, modified_on_raw, resolution_date_raw,
             timestamp_raw, created_on_raw, status
      FROM ${TABLES.emails}
    `,
  );

  const targetDates = new Set(dates);
  const normalizedActivityRows = normalizeDatabaseActivityRows(
    activityRows,
    matcher,
    targetDates,
  );
  const normalizedCallRows = normalizeDatabaseCallRows(
    callRows,
    matcher,
    targetDates,
  );
  const normalizedEmailRows = normalizeDatabaseEmailRows(
    emailRows,
    matcher,
    targetDates,
  );
  const usedEmployeeUids = new Set([
    ...normalizedActivityRows.map((row) => row.employeeUid),
    ...normalizedCallRows.map((row) => row.employeeUid),
    ...normalizedEmailRows.map((row) => row.employeeUid),
  ]);
  const employees = matcher.employees.filter((employee) =>
    usedEmployeeUids.has(employee.employeeUid),
  );
  const summaries = calculateHourlySummaries({
    productionDates: dates,
    employees,
    activityRows: normalizedActivityRows,
    callRows: normalizedCallRows,
    emailRows: normalizedEmailRows,
  });

  await connection.query(
    `DELETE FROM ${TABLES.summary} WHERE production_date IN (${placeholders})`,
    dates,
  );

  for (let index = 0; index < summaries.length; index += INSERT_CHUNK_SIZE) {
    const chunk = summaries.slice(index, index + INSERT_CHUNK_SIZE);
    const values = [];
    const rowPlaceholder = "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

    chunk.forEach((row) => {
      values.push(
        batchId,
        row.productionDate,
        row.employeeUid,
        row.employeeName,
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
        new Date(),
      );
    });

    await connection.query(
      `
        INSERT INTO ${TABLES.summary} (
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
          actual_efficiency_pct,
          updated_at
        ) VALUES ${chunk.map(() => rowPlaceholder).join(",")}
      `,
      values,
    );
  }

  return summaries.length;
}

function buildBatchCode() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `USVKPI-${timestamp}-${suffix}`;
}

function normalizeBatchRow(row = {}) {
  return {
    id: Number(row.id || 0),
    batchCode: cleanText(row.batch_code, 80),
    sourceFilename: cleanText(row.source_filename, 255),
    productionDate: row.production_date || null,
    status: cleanText(row.status, 30),
    agentActivityRows: Number(row.agent_activity_rows || 0),
    callsAnsweredRows: Number(row.calls_answered_rows || 0),
    emailCaseRows: Number(row.email_case_rows || 0),
    summaryRows: Number(row.summary_rows || 0),
    errorMessage: row.error_message || null,
    createdAt: row.created_at || null,
    completedAt: row.completed_at || null,
  };
}

export async function listKpiImportHistory(limit = 10, connection = db) {
  const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 10));
  const [rows] = await connection.query(
    `
      SELECT
        id,
        batch_code,
        source_filename,
        DATE_FORMAT(production_date, '%Y-%m-%d') AS production_date,
        status,
        agent_activity_rows,
        calls_answered_rows,
        email_case_rows,
        summary_rows,
        error_message,
        created_at,
        completed_at
      FROM ${TABLES.batches}
      ORDER BY id DESC
      LIMIT ?
    `,
    [safeLimit],
  );

  return rows.map(normalizeBatchRow);
}


export function collectBatchProductionDates({
  batch = {},
  activityRows = [],
  callRows = [],
  emailRows = [],
  summaryRows = [],
} = {}) {
  const dates = new Set();

  function addDate(value) {
    const normalized = normalizeDate(value);
    if (normalized) dates.add(normalized);
  }

  addDate(batch.production_date || batch.productionDate);
  activityRows.forEach((row) => addDate(row.activity_date));
  callRows.forEach((row) => addDate(row.activity_date));
  summaryRows.forEach((row) => addDate(row.production_date));
  emailRows.forEach((row) => {
    addDate(resolveMsdEventDateTime(row));
  });

  return [...dates].sort();
}

async function collectOperationalProductionDates(connection) {
  const [[activityRows], [callRows]] = await Promise.all([
    connection.query(
      `SELECT DISTINCT activity_date FROM ${TABLES.activity} WHERE activity_date IS NOT NULL`,
    ),
    connection.query(
      `SELECT DISTINCT activity_date FROM ${TABLES.calls} WHERE activity_date IS NOT NULL`,
    ),
  ]);

  return collectBatchProductionDates({ activityRows, callRows });
}

function intersectProductionDates(requestedDates, availableDates) {
  const requested = new Set(
    (Array.isArray(requestedDates) ? requestedDates : [])
      .map((value) => normalizeDate(value))
      .filter(Boolean),
  );

  if (requested.size === 0) return [...availableDates];
  return availableDates.filter((date) => requested.has(date));
}

export async function rebuildKpiSummaries(
  productionDates = [],
  pool = db,
) {
  const requestedDates = Array.isArray(productionDates)
    ? productionDates.map((value) => normalizeDate(value)).filter(Boolean)
    : [];
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const operationalDates = await collectOperationalProductionDates(connection);
    const dates = requestedDates.length > 0
      ? intersectProductionDates(requestedDates, operationalDates)
      : operationalDates;

    if (requestedDates.length === 0) {
      // A full rebuild removes stale email-only or previously misdated summaries.
      await connection.query(`DELETE FROM ${TABLES.summary}`);
    }

    if (dates.length === 0) {
      await connection.commit();
      return { productionDates: [], summaryRows: 0 };
    }

    const matcher = await loadEmployeeMatcher(connection);
    const [batchRows] = await connection.query(
      `
        SELECT id
        FROM ${TABLES.batches}
        WHERE status = 'completed'
        ORDER BY id DESC
        LIMIT 1
      `,
    );
    const latestBatchId = Number(batchRows?.[0]?.id) || null;
    const summaryRows = await rebuildHourlySummary(
      connection,
      dates,
      latestBatchId,
      matcher,
    );

    await connection.commit();

    return {
      productionDates: dates,
      summaryRows,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // Preserve the original rebuild error.
    }

    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteKpiImportBatch(batchId, pool = db) {
  const safeBatchId = Number.parseInt(batchId, 10);

  if (!Number.isInteger(safeBatchId) || safeBatchId <= 0) {
    throw new TypeError("A valid KPI import batch ID is required.");
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [batchRows] = await connection.query(
      `
        SELECT
          id,
          batch_code,
          source_filename,
          production_date,
          status,
          agent_activity_rows,
          calls_answered_rows,
          email_case_rows,
          summary_rows,
          error_message,
          created_at,
          completed_at
        FROM ${TABLES.batches}
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [safeBatchId],
    );

    const batch = batchRows?.[0];

    if (!batch) {
      const error = new Error("The selected KPI import was not found.");
      error.code = "KPI_IMPORT_NOT_FOUND";
      throw error;
    }

    const [[activityRows], [callRows], [emailRows], [summaryRows]] =
      await Promise.all([
        connection.query(
          `SELECT activity_date FROM ${TABLES.activity} WHERE batch_id = ?`,
          [safeBatchId],
        ),
        connection.query(
          `SELECT activity_date FROM ${TABLES.calls} WHERE batch_id = ?`,
          [safeBatchId],
        ),
        connection.query(
          `
            SELECT modified_on_raw, resolution_date_raw, timestamp_raw,
                   created_on_raw, status
            FROM ${TABLES.emails}
            WHERE batch_id = ?
          `,
          [safeBatchId],
        ),
        connection.query(
          `SELECT production_date FROM ${TABLES.summary} WHERE batch_id = ?`,
          [safeBatchId],
        ),
      ]);

    const productionDates = collectBatchProductionDates({
      batch,
      activityRows,
      callRows,
      emailRows,
      summaryRows,
    });

    await connection.query(
      `DELETE FROM ${TABLES.batches} WHERE id = ? LIMIT 1`,
      [safeBatchId],
    );

    let regeneratedSummaryRows = 0;

    if (productionDates.length > 0) {
      const matcher = await loadEmployeeMatcher(connection);
      regeneratedSummaryRows = await rebuildHourlySummary(
        connection,
        productionDates,
        null,
        matcher,
      );
    }

    await connection.commit();

    const deletedActivityRows = activityRows.length;
    const deletedCallRows = callRows.length;
    const deletedEmailRows = emailRows.length;

    return {
      batch: normalizeBatchRow(batch),
      productionDates,
      deletedRows: {
        agentActivityRows: deletedActivityRows,
        callsAnsweredRows: deletedCallRows,
        emailCaseRows: deletedEmailRows,
        total:
          deletedActivityRows + deletedCallRows + deletedEmailRows,
      },
      regeneratedSummaryRows,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // Preserve the original deletion error.
    }

    throw error;
  } finally {
    connection.release();
  }
}

export async function importKpiRawFile({
  buffer,
  fileName,
  sourceType = SOURCE_TYPES.AUTO,
  uploadedBy = null,
} = {}) {
  const parsedFile = parseRawWorkbook(buffer, fileName, sourceType);
  const batchCode = buildBatchCode();
  const singleProductionDate =
    parsedFile.productionDates.length === 1
      ? parsedFile.productionDates[0]
      : null;
  const [batchResult] = await db.query(
    `
      INSERT INTO ${TABLES.batches} (
        batch_code,
        source_filename,
        production_date,
        uploaded_by,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'processing', NOW(), NOW())
    `,
    [
      batchCode,
      parsedFile.fileName,
      singleProductionDate,
      Number(uploadedBy) || null,
    ],
  );
  const batchId = batchResult.insertId;
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const matcher = await loadEmployeeMatcher(connection);
    const matchSummary = buildMatchSummary(parsedFile, matcher);
    const insertionBySource = new Map();

    for (const section of parsedFile.sections) {
      const config = sourceTableConfig(section.sourceType);
      const result = await insertRawRows(
        connection,
        config.table,
        batchId,
        config.columns,
        section.records,
      );
      const current = insertionBySource.get(section.sourceType) || {
        inserted: 0,
        duplicates: 0,
      };
      current.inserted += result.inserted;
      current.duplicates += result.duplicates;
      insertionBySource.set(section.sourceType, current);
    }

    const operationalDates = await collectOperationalProductionDates(connection);
    const summaryProductionDates = intersectProductionDates(
      parsedFile.productionDates,
      operationalDates,
    );
    const summaryRows = await rebuildHourlySummary(
      connection,
      summaryProductionDates,
      batchId,
      matcher,
    );
    const activityInserted =
      insertionBySource.get(SOURCE_TYPES.HD_ACTIVITY)?.inserted || 0;
    const callsInserted =
      insertionBySource.get(SOURCE_TYPES.HD_CALLS)?.inserted || 0;
    const emailsInserted = insertionBySource.get(SOURCE_TYPES.MSD)?.inserted || 0;

    await connection.query(
      `
        UPDATE ${TABLES.batches}
        SET
          status = 'completed',
          agent_activity_rows = ?,
          calls_answered_rows = ?,
          email_case_rows = ?,
          summary_rows = ?,
          error_message = NULL,
          completed_at = NOW(),
          updated_at = NOW()
        WHERE id = ?
      `,
      [activityInserted, callsInserted, emailsInserted, summaryRows, batchId],
    );

    await connection.commit();

    const sources = matchSummary.sourceSummaries.map((sourceSummary) => ({
      ...sourceSummary,
      insertedRows:
        insertionBySource.get(sourceSummary.sourceType)?.inserted || 0,
      duplicateRows:
        insertionBySource.get(sourceSummary.sourceType)?.duplicates || 0,
    }));

    return {
      batch: {
        id: batchId,
        batchCode,
        sourceFilename: parsedFile.fileName,
        productionDate: singleProductionDate,
        status: "completed",
        summaryRows,
      },
      productionDates: parsedFile.productionDates,
      detectedRows: parsedFile.totalRows,
      sources,
      unmatchedNames: matchSummary.unmatchedNames,
      summaryRows,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // Keep the original import error.
    }

    if (batchId) {
      try {
        await db.query(
          `
            UPDATE ${TABLES.batches}
            SET status = 'failed', error_message = ?, completed_at = NOW(), updated_at = NOW()
            WHERE id = ?
          `,
          [cleanText(error.message, 60_000), batchId],
        );
      } catch (batchError) {
        console.error("Unable to mark failed KPI import batch:", batchError);
      }
    }

    throw error;
  } finally {
    connection.release();
  }
}
