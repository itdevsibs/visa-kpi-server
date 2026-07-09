import db from "../config/db.js";
import { cleanString } from "./usVisaKpiParserService.js";

function toSqlDateOnly(value) {
  if (!value) return "";

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const raw = cleanString(value);

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }

  return raw;
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

function parseEmployeeIds(value) {
  const raw = cleanString(value);

  if (!raw || raw === "all") return [];

  return raw
    .split(",")
    .map((item) => cleanString(item))
    .filter(Boolean)
    .filter((item) => item !== "all");
}

function roundNumber(value, decimals = 0) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) return 0;

  const factor = 10 ** decimals;
  return Math.round(numberValue * factor) / factor;
}

async function getLatestProductionDate() {
  const [rows] = await db.query(`
    SELECT production_date
    FROM us_visa_kpi_hourly_summary
    ORDER BY production_date DESC
    LIMIT 1
  `);

  return toSqlDateOnly(rows[0]?.production_date);
}

function getEmployeeUid(row) {
  return cleanString(row.employee_uid || row.uid || row.employee_id || row.id);
}

function toEmployeePayload(row) {
  const employeeUid = getEmployeeUid(row);
  const employeeName = cleanString(row.employee_name);

  return {
    id: employeeUid,
    employee_uid: employeeUid,
    employee_id: row.employee_id || row.employee_number || employeeUid,
    employee_number: row.employee_number || row.employee_id || employeeUid,
    employee_name: employeeName,
    agent_name: employeeName,
    email: row.email || "",
    position: row.position || "",
    department: row.department || "",
    team: row.team || "",
    supervisor: row.supervisor || "",
    account_name: row.account_name || "US Visa",
    status: row.status || "Active",
    employment_status: row.employment_status || "Active",
    task_order: row.task_order || row.assigned_sub_account || "",
    assigned_sub_account: row.assigned_sub_account || row.task_order || "",
    herodash: row.herodash || row.hero_dash || row.heroDash || "",
    msd: row.msd || row.MSD || "",
    include_dashboard: row.include_dashboard ?? true,
    include_reports: row.include_reports ?? true,
    kpi_tracking_enabled: row.kpi_tracking_enabled ?? true,
  };
}

async function loadOfficialEmployees() {
  const [rows] = await db.query(`
    SELECT *
    FROM us_visa_kpi_employees
    WHERE LOWER(COALESCE(account_name, 'US Visa')) LIKE '%us visa%'
      AND COALESCE(status, 'Active') = 'Active'
      AND COALESCE(employment_status, 'Active') = 'Active'
      AND COALESCE(include_dashboard, 1) = 1
    ORDER BY employee_name ASC
  `);

  return rows.map(toEmployeePayload).filter((employee) => employee.id);
}

async function loadAliases() {
  const [rows] = await db.query(`
    SELECT employee_uid, source_system, source_agent_name, source_agent_key
    FROM us_visa_kpi_employee_aliases
    WHERE COALESCE(is_active, 1) = 1
  `);

  return rows;
}

function buildEmployeeMatcher(employees = [], aliases = []) {
  const employeeByUid = new Map();
  const aliasToEmployee = new Map();

  const addAlias = (key, employee) => {
    const normalizedKey = normalizeAgentKey(key);
    if (normalizedKey) {
      aliasToEmployee.set(normalizedKey, employee);
    }
  };

  employees.forEach((employee) => {
    employeeByUid.set(employee.id, employee);

    addAlias(employee.employee_name, employee);
    addAlias(employee.agent_name, employee);
    addAlias(employee.employee_id, employee);
    addAlias(employee.employee_number, employee);
    addAlias(employee.herodash, employee);
    addAlias(employee.msd, employee);
  });

  aliases.forEach((alias) => {
    const employee = employeeByUid.get(cleanString(alias.employee_uid));
    if (!employee) return;

    addAlias(alias.source_agent_key, employee);
    addAlias(alias.source_agent_name, employee);
  });

  return {
    employeeByUid,
    aliasToEmployee,
    resolveEmployee(value) {
      const normalizedKey = normalizeAgentKey(value);
      return aliasToEmployee.get(normalizedKey) || null;
    },
    resolveSelectedEmployeeIds(employeeIds = []) {
      if (!employeeIds.length) return [];

      return employeeIds
        .map((employeeId) => {
          const direct = employeeByUid.get(employeeId);
          if (direct) return direct.id;

          const fromAlias = aliasToEmployee.get(normalizeAgentKey(employeeId));
          if (fromAlias) return fromAlias.id;

          return employeeId;
        })
        .filter(Boolean);
    },
  };
}

async function loadSummaryRows({ date, fromHour, toHour, batchId = null }) {
  const conditions = ["production_date = ?", "interval_hour BETWEEN ? AND ?"];
  const params = [date, Number(fromHour), Number(toHour)];

  if (batchId) {
    conditions.push("batch_id = ?");
    params.push(Number(batchId));
  }

  const [rows] = await db.query(
    `
    SELECT *
    FROM us_visa_kpi_hourly_summary
    WHERE ${conditions.join(" AND ")}
    ORDER BY agent_name ASC, interval_hour ASC
    `,
    params
  );

  return rows;
}

function emptyAccumulator(employee, hour = null) {
  return {
    employee,
    hour,
    expectedSeconds: 0,
    loggedSeconds: 0,
    handledCalls: 0,
    talkSecondsWeighted: 0,
    holdSecondsWeighted: 0,
    availableSeconds: 0,
    occupancyWeighted: 0,
    availableEmailCapacity: 0,
    targetEmails: 0,
    actualEmails: 0,
    efficiencyWeighted: 0,
  };
}

function addSummaryToAccumulator(acc, row) {
  const expectedSeconds = Number(row.expected_seconds || 0);
  const loggedSeconds = Number(row.actual_logged_seconds || 0);
  const handledCalls = Number(row.handled_calls || 0);
  const avgTalkSeconds = Number(row.avg_talk_seconds || 0);
  const avgHoldSeconds = Number(row.avg_hold_seconds || 0);
  const phoneOccupancy = Number(row.phone_occupancy_pct || 0);
  const efficiency = Number(row.actual_efficiency_pct || 0);

  acc.expectedSeconds += expectedSeconds;
  acc.loggedSeconds += loggedSeconds;
  acc.handledCalls += handledCalls;
  acc.talkSecondsWeighted += avgTalkSeconds * handledCalls;
  acc.holdSecondsWeighted += avgHoldSeconds * handledCalls;
  acc.availableSeconds += Number(row.available_seconds || 0);
  acc.occupancyWeighted += phoneOccupancy * loggedSeconds;
  acc.availableEmailCapacity += Number(row.email_capacity || 0);
  acc.targetEmails += Number(row.target_emails || 0);
  acc.actualEmails += Number(row.actual_emails || 0);
  acc.efficiencyWeighted += efficiency * expectedSeconds;
}

function accumulatorToRecord(acc) {
  const avgTalkTime =
    acc.handledCalls > 0
      ? Math.round(acc.talkSecondsWeighted / acc.handledCalls)
      : 0;

  const avgHoldTime =
    acc.handledCalls > 0
      ? Math.round(acc.holdSecondsWeighted / acc.handledCalls)
      : 0;

  const phoneOccupancy =
    acc.loggedSeconds > 0
      ? Math.round(acc.occupancyWeighted / acc.loggedSeconds)
      : 0;

  const emailUtilization =
    acc.targetEmails > 0
      ? Math.round((acc.actualEmails / acc.targetEmails) * 100)
      : acc.actualEmails > 0
        ? 100
        : 0;

  const efficiency =
    acc.expectedSeconds > 0
      ? roundNumber(acc.efficiencyWeighted / acc.expectedSeconds, 1)
      : 0;

  return {
    employeeId: acc.employee.id,
    employeeUid: acc.employee.id,
    employeeName: acc.employee.employee_name,
    employee_name: acc.employee.employee_name,
    position: acc.employee.position || "",
    team: acc.employee.team || "",
    email: acc.employee.email || "",
    taskOrder: acc.employee.task_order || "",
    herodash: acc.employee.herodash || "",
    msd: acc.employee.msd || "",

    ...(acc.hour !== null && acc.hour !== undefined ? { hour: acc.hour } : {}),

    expectedSeconds: Math.round(acc.expectedSeconds),
    loggedSeconds: Math.round(acc.loggedSeconds),
    handledCalls: Math.round(acc.handledCalls),
    avgTalkTime,
    avgHoldTime,
    availableSeconds: Math.round(acc.availableSeconds),
    phoneOccupancy,
    availableEmailCapacity: Math.round(acc.availableEmailCapacity),
    targetEmails: Math.round(acc.targetEmails),
    actualEmails: Math.round(acc.actualEmails),
    emailUtilization,
    efficiency,
  };
}

function buildRecords({ rows = [], matcher, selectedEmployeeIds = [], intervalType }) {
  const hourlyMap = new Map();
  const dailyMap = new Map();
  const selectedSet = new Set(selectedEmployeeIds);

  rows.forEach((row) => {
    const employee =
      matcher.resolveEmployee(row.agent_key) || matcher.resolveEmployee(row.agent_name);

    if (!employee) return;

    if (selectedSet.size > 0 && !selectedSet.has(employee.id)) return;

    const hour = Number(row.interval_hour);
    const hourlyKey = `${employee.id}__${hour}`;
    const dailyKey = employee.id;

    if (!hourlyMap.has(hourlyKey)) {
      hourlyMap.set(hourlyKey, emptyAccumulator(employee, hour));
    }

    if (!dailyMap.has(dailyKey)) {
      dailyMap.set(dailyKey, emptyAccumulator(employee));
    }

    addSummaryToAccumulator(hourlyMap.get(hourlyKey), row);
    addSummaryToAccumulator(dailyMap.get(dailyKey), row);
  });

  const hourlyRecords = [...hourlyMap.values()]
    .map(accumulatorToRecord)
    .sort((a, b) => {
      if (a.employeeName !== b.employeeName) {
        return a.employeeName.localeCompare(b.employeeName);
      }
      return Number(a.hour || 0) - Number(b.hour || 0);
    });

  const dailyRecords = [...dailyMap.values()]
    .map(accumulatorToRecord)
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  return {
    records: intervalType === "Hourly" ? hourlyRecords : dailyRecords,
    hourlyRecords,
    dailyRecords,
  };
}

function buildStatistics(records = [], dailyRecords = []) {
  const source = dailyRecords.length > 0 ? dailyRecords : records;

  if (source.length === 0) {
    return {
      totalEmp: 0,
      avgEff: 0,
      avgOccupancy: 0,
      totalCalls: 0,
      totalEmails: 0,
    };
  }

  const totalCalls = source.reduce(
    (sum, item) => sum + Number(item.handledCalls || 0),
    0
  );

  const totalEmails = source.reduce(
    (sum, item) => sum + Number(item.actualEmails || 0),
    0
  );

  const avgEff = roundNumber(
    source.reduce((sum, item) => sum + Number(item.efficiency || 0), 0) /
      source.length,
    1
  );

  const avgOccupancy = Math.round(
    source.reduce((sum, item) => sum + Number(item.phoneOccupancy || 0), 0) /
      source.length
  );

  return {
    totalEmp: source.length,
    avgEff,
    avgOccupancy,
    totalCalls,
    totalEmails,
  };
}

export async function getUsVisaKpiPerformance(query = {}) {
  const selectedDate = cleanString(query.date) || (await getLatestProductionDate());

  if (!selectedDate) {
    return {
      success: true,
      data: {
        selectedDate: "",
        fromHour: 8,
        toHour: 17,
        intervalType: "Daily",
        agents: [],
        records: [],
        hourlyRecords: [],
        dailyRecords: [],
        statistics: buildStatistics([], []),
      },
    };
  }

  const fromHour = Number(query.fromHour || 8);
  const toHour = Number(query.toHour || 17);
  const intervalType = cleanString(query.intervalType) === "Hourly" ? "Hourly" : "Daily";
  const batchId = query.batchId ? Number(query.batchId) : null;

  const employees = await loadOfficialEmployees();
  const aliases = await loadAliases();
  const matcher = buildEmployeeMatcher(employees, aliases);

  const selectedEmployeeIds = matcher.resolveSelectedEmployeeIds(
    parseEmployeeIds(query.employeeIds)
  );

  const rawRows = await loadSummaryRows({
    date: selectedDate,
    fromHour,
    toHour,
    batchId,
  });

  const { records, hourlyRecords, dailyRecords } = buildRecords({
    rows: rawRows,
    matcher,
    selectedEmployeeIds,
    intervalType,
  });

  return {
    success: true,
    data: {
      selectedDate,
      fromHour,
      toHour,
      intervalType,
      selectedEmployees: selectedEmployeeIds.length > 0 ? selectedEmployeeIds : ["all"],
      agents: employees,
      records,
      hourlyRecords,
      dailyRecords,
      rawCount: rawRows.length,
      statistics: buildStatistics(records, dailyRecords),
    },
  };
}
