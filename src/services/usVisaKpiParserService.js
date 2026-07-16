import crypto from "crypto";

export function cleanString(value) {
  return String(value ?? "").trim();
}

export function normalizeKey(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function pickValue(row = {}, keys = []) {
  if (!row || typeof row !== "object") return "";

  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && cleanString(row[key]) !== "") {
      return row[key];
    }
  }

  const normalizedMap = new Map();

  Object.keys(row).forEach((key) => {
    normalizedMap.set(normalizeKey(key), key);
  });

  for (const key of keys) {
    const realKey = normalizedMap.get(normalizeKey(key));

    if (!realKey) continue;

    const value = row[realKey];

    if (value !== undefined && value !== null && cleanString(value) !== "") {
      return value;
    }
  }

  return "";
}

export function createRowHash(row = {}) {
  const stableValue = JSON.stringify(row, Object.keys(row).sort());

  return crypto.createHash("sha256").update(stableValue).digest("hex");
}

export function toJson(row = {}) {
  return JSON.stringify(row ?? {});
}

export function excelSerialToDate(value) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) return null;

  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  const date = new Date(excelEpoch.getTime() + numberValue * 24 * 60 * 60 * 1000);

  if (Number.isNaN(date.getTime())) return null;

  return date;
}

export function toSqlDate(value) {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number") {
    const date = excelSerialToDate(value);
    return date ? date.toISOString().slice(0, 10) : null;
  }

  const raw = cleanString(value);

  if (!raw || raw === "###########" || raw === "#VALUE!" || raw === "#NAME?") {
    return null;
  }

  const parsed = new Date(raw);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  const mmddyyyy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);

  if (mmddyyyy) {
    const month = mmddyyyy[1].padStart(2, "0");
    const day = mmddyyyy[2].padStart(2, "0");
    const year =
      mmddyyyy[3].length === 2 ? `20${mmddyyyy[3]}` : mmddyyyy[3];

    return `${year}-${month}-${day}`;
  }

  return null;
}

export function toSeconds(value) {
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number") {
    // Excel duration is usually stored as fraction of a day.
    if (value > 0 && value < 1) {
      return Math.round(value * 24 * 60 * 60);
    }

    return Math.round(value);
  }

  const raw = cleanString(value);

  if (!raw || raw === "###########" || raw === "#VALUE!" || raw === "#NAME?") {
    return 0;
  }

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const numberValue = Number(raw);

    if (numberValue > 0 && numberValue < 1) {
      return Math.round(numberValue * 24 * 60 * 60);
    }

    return Math.round(numberValue);
  }

  const hms = raw.match(/^(\d+):([0-5]?\d):([0-5]?\d)$/);

  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }

  const ms = raw.match(/^([0-5]?\d):([0-5]?\d)$/);

  if (ms) {
    return Number(ms[1]) * 60 + Number(ms[2]);
  }

  let total = 0;

  const hours = raw.match(/(\d+(?:\.\d+)?)\s*h/i);
  const minutes = raw.match(/(\d+(?:\.\d+)?)\s*m/i);
  const seconds = raw.match(/(\d+(?:\.\d+)?)\s*s/i);

  if (hours) total += Number(hours[1]) * 3600;
  if (minutes) total += Number(minutes[1]) * 60;
  if (seconds) total += Number(seconds[1]);

  return Math.round(total);
}

export function getFirstValidProductionDate(rows = []) {
  for (const row of rows) {
    const dateValue = pickValue(row, [
      "Date",
      "date",
      "Activity Date",
      "activity_date",
      "Created On",
      "created_on",
      "Resolution Date",
      "resolution_date",
    ]);

    const sqlDate = toSqlDate(dateValue);

    if (sqlDate) return sqlDate;
  }

  return null;
}

export function normalizeAgentActivityRow(row = {}) {
  const durationValue = pickValue(row, [
    "Duration",
    "duration",
    "Duration Time",
    "duration_time",
  ]);

  return {
    timestamp_raw: cleanString(
      pickValue(row, ["Timestamp", "timestamp", "Time Stamp"])
    ),
    agent_raw: cleanString(pickValue(row, ["Agent", "agent"])),
    duration_seconds: toSeconds(durationValue),
    activity_date: toSqlDate(pickValue(row, ["Date", "date"])),
    agent_name: cleanString(
      pickValue(row, ["Agent name", "Agent Name", "agent_name", "Name"])
    ),
    start_time_raw: cleanString(
      pickValue(row, ["Start time", "Start Time", "start_time"])
    ),
    end_time_raw: cleanString(
      pickValue(row, ["End time", "End Time", "end_time"])
    ),
    duration_text: cleanString(durationValue),
    status: cleanString(pickValue(row, ["Status", "status"])),
    row_json: toJson(row),
    row_hash: createRowHash(row),
  };
}

export function normalizeCallsAnsweredRow(row = {}) {
  return {
    timestamp_raw: cleanString(
      pickValue(row, ["Timestamp", "timestamp", "Time Stamp"])
    ),
    agent_raw: cleanString(pickValue(row, ["Agent", "agent"])),
    talk_seconds: toSeconds(
      pickValue(row, ["Talk Time", "talk_time", "TalkTime"])
    ),
    activity_date: toSqlDate(pickValue(row, ["Date", "date"])),

    call_id: cleanString(
      pickValue(row, ["Call ID", "Call Id", "call_id", "callId"])
    ),
    direction: cleanString(pickValue(row, ["Direction", "direction"])),

    arrival_time_raw: cleanString(
      pickValue(row, ["Arrival time", "Arrival Time", "arrival_time"])
    ),
    arrival_queue_time_raw: cleanString(
      pickValue(row, [
        "Arrival Queue time",
        "Arrival Queue Time",
        "arrival_queue_time",
      ])
    ),
    answer_time_raw: cleanString(
      pickValue(row, ["Answer time", "Answer Time", "answer_time"])
    ),
    end_time_raw: cleanString(
      pickValue(row, ["End time", "End Time", "end_time"])
    ),

    agent_name: cleanString(
      pickValue(row, ["Agent name", "Agent Name", "agent_name", "Name"])
    ),
    skill: cleanString(pickValue(row, ["Skill", "skill"])),
    disconnect_indicator: cleanString(
      pickValue(row, [
        "Disconnect Indicator",
        "disconnect_indicator",
        "Disconnect",
      ])
    ),

    duration_seconds: toSeconds(pickValue(row, ["Duration", "duration"])),
    total_hold_seconds: toSeconds(
  pickValue(row, [
    "Total hold time (sec)",
    "total_hold_time_sec",
    "total hold time sec",
    "total hold time (sec)",

    "total_hold_seconds",
    "total hold seconds",
    "hold_seconds",
    "hold seconds",

    "hold_time",
    "hold time",
    "total_hold_time",
    "total hold time",
    "total hold",
    "hold duration",
    "hold_duration",

    "customer_hold_time",
    "customer hold time",
    "customer_hold_duration",
    "customer hold duration",

    "avg_hold_time",
    "avg hold time",
    "average_hold_time",
    "average hold time",

    "agent_hold_time",
    "agent hold time",
    "acd_hold_time",
    "acd hold time",
  ])
),
    total_hold_count:
      Number(
        cleanString(
          pickValue(row, [
            "Total hold count",
            "Total Hold Count",
            "total_hold_count",
          ])
        )
      ) || 0,

    row_json: toJson(row),
    row_hash: createRowHash(row),
  };
}

export function normalizeEmailCaseRow(row = {}) {
  return {
    timestamp_raw: cleanString(
      pickValue(row, ["Timestamp", "timestamp", "Time Stamp"])
    ),
    agent_raw: cleanString(pickValue(row, ["Agent", "agent"])),

    case_number: cleanString(
      pickValue(row, ["Case Number", "case_number", "Case No", "Case"])
    ),
    created_on_raw: cleanString(
      pickValue(row, ["Created On", "created_on", "Created"])
    ),
    modified_on_raw: cleanString(
      pickValue(row, ["Modified On", "modified_on", "Modified"])
    ),
    resolution_date_raw: cleanString(
      pickValue(row, [
        "Resolution Date",
        "resolution_date",
        "Resolved On",
        "Resolved",
      ])
    ),

    created_by: cleanString(
      pickValue(row, ["Created By", "created_by", "Creator"])
    ),
    modified_by: cleanString(
      pickValue(row, ["Modified By", "modified_by", "Modifier"])
    ),

    case_status: cleanString(
      pickValue(row, ["Case Status", "case_status"])
    ),
    status: cleanString(pickValue(row, ["Status", "status"])),
    case_country: cleanString(
      pickValue(row, ["Country", "country", "Case Country"])
    ),
    owner: cleanString(pickValue(row, ["Owner", "owner"])),
    origin: cleanString(pickValue(row, ["Origin", "origin"])),
    applicant: cleanString(pickValue(row, ["Applicant", "applicant"])),
    description: cleanString(
      pickValue(row, ["Description", "description"])
    ),

    row_json: toJson(row),
    row_hash: createRowHash(row),
  };
}