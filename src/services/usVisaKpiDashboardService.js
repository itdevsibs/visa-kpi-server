import db from "../config/db.js";
import { cleanString } from "./usVisaKpiParserService.js";

const CALL_TARGET_PER_HOUR = Number(
  process.env.US_VISA_CALL_TARGET_PER_HOUR || 5
);

const TALK_TARGET_SECONDS = Number(
  process.env.US_VISA_TALK_TARGET_SECONDS || 180
);

const HOLD_TARGET_SECONDS = Number(
  process.env.US_VISA_HOLD_TARGET_SECONDS || 30
);

const HOURS = [
  { value: 8, label: "08:00 AM" },
  { value: 9, label: "09:00 AM" },
  { value: 10, label: "10:00 AM" },
  { value: 11, label: "11:00 AM" },
  { value: 12, label: "12:00 PM" },
  { value: 13, label: "01:00 PM" },
  { value: 14, label: "02:00 PM" },
  { value: 15, label: "03:00 PM" },
  { value: 16, label: "04:00 PM" },
  { value: 17, label: "05:00 PM" },
];

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

function formatLoggedTime(totalSeconds) {
  const safeSeconds = Math.max(Number(totalSeconds || 0), 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.round((safeSeconds % 3600) / 60);

  return `${hours}h ${minutes}m`;
}

function roundNumber(value, decimals = 0) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) return 0;

  const factor = 10 ** decimals;

  return Math.round(numberValue * factor) / factor;
}

function getHourLabel(hour) {
  const found = HOURS.find((item) => item.value === Number(hour));

  return found ? found.label : `${String(hour).padStart(2, "0")}:00`;
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

async function getLatestProductionDate() {
  const [rows] = await db.query(`
    SELECT production_date
    FROM us_visa_kpi_hourly_summary
    GROUP BY production_date
    ORDER BY production_date DESC
    LIMIT 1
  `);

  return toSqlDateOnly(rows[0]?.production_date);
}

async function getPreviousProductionDate(selectedDate) {
  const [rows] = await db.query(
    `
    SELECT production_date
    FROM us_visa_kpi_hourly_summary
    WHERE production_date < ?
    GROUP BY production_date
    ORDER BY production_date DESC
    LIMIT 1
    `,
    [selectedDate]
  );

  return toSqlDateOnly(rows[0]?.production_date);
}

function calculateTrendPercent(currentValue, previousValue, inverse = false) {
  const current = Number(currentValue || 0);
  const previous = Number(previousValue || 0);

  if (previous <= 0 && current <= 0) return 0;
  if (previous <= 0 && current > 0) return 100;

  const rawTrend = ((current - previous) / previous) * 100;
  const roundedTrend = Math.round(rawTrend);

  return inverse ? roundedTrend * -1 : roundedTrend;
}

function getEmptyTrends() {
  return {
    loggedTime: 0,
    handledCalls: 0,
    avgTalkTime: 0,
    avgHoldTime: 0,
    phoneOccupancy: 0,
    emailCapacity: 0,
    emailUtilization: 0,
    efficiency: 0,
  };
}

function buildMetricTrends(currentMetrics, previousMetrics) {
  if (!previousMetrics) {
    return getEmptyTrends();
  }

  return {
    loggedTime: calculateTrendPercent(
      currentMetrics.loggedTime,
      previousMetrics.loggedTime
    ),

    handledCalls: calculateTrendPercent(
      currentMetrics.handledCalls,
      previousMetrics.handledCalls
    ),

    // Lower talk time is better.
    avgTalkTime: calculateTrendPercent(
      currentMetrics.avgTalkTime,
      previousMetrics.avgTalkTime,
      true
    ),

    // Lower hold time is better.
    avgHoldTime: calculateTrendPercent(
      currentMetrics.avgHoldTime,
      previousMetrics.avgHoldTime,
      true
    ),

    phoneOccupancy: calculateTrendPercent(
      currentMetrics.phoneOccupancy,
      previousMetrics.phoneOccupancy
    ),

    emailCapacity: calculateTrendPercent(
      currentMetrics.availableEmailCapacity,
      previousMetrics.availableEmailCapacity
    ),

    emailUtilization: calculateTrendPercent(
      currentMetrics.emailUtilization,
      previousMetrics.emailUtilization
    ),

    efficiency: calculateTrendPercent(
      currentMetrics.actualEfficiency,
      previousMetrics.actualEfficiency
    ),
  };
}

function buildSameDayTrendFromHourlyRows(rows = [], fromHour = 8, toHour = 17) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return getEmptyTrends();
  }

  const availableHours = [
    ...new Set(
      rows
        .map((row) => Number(row.interval_hour))
        .filter((hour) => Number.isFinite(hour))
        .filter((hour) => hour >= Number(fromHour) && hour <= Number(toHour))
    ),
  ].sort((a, b) => a - b);

  if (availableHours.length < 2) {
    return getEmptyTrends();
  }

  const firstHour = availableHours[0];
  const lastHour = availableHours[availableHours.length - 1];

  const firstHourRows = rows.filter(
    (row) => Number(row.interval_hour) === firstHour
  );

  const lastHourRows = rows.filter(
    (row) => Number(row.interval_hour) === lastHour
  );

  const firstHourMetrics = buildSummaryMetrics(firstHourRows);
  const lastHourMetrics = buildSummaryMetrics(lastHourRows);

  return buildMetricTrends(lastHourMetrics, firstHourMetrics);
}

async function loadOfficialEmployees() {
  const [rows] = await db.query(`
    SELECT
      employee_uid,
      employee_id,
      employee_number,
      employee_name,
      email,
      position,
      department,
      team,
      supervisor,
      account_name,
      status,
      employment_status,
      task_order,
      assigned_sub_account,
      herodash,
      msd,
      include_dashboard,
      include_reports,
      kpi_tracking_enabled
    FROM us_visa_kpi_employees
    WHERE
      COALESCE(include_dashboard, 1) = 1
      AND COALESCE(kpi_tracking_enabled, 1) = 1
      AND COALESCE(status, 'Active') = 'Active'
      AND COALESCE(employment_status, 'Active') = 'Active'
    ORDER BY employee_name ASC
  `);

  return rows.map((row) => ({
    employee_uid: row.employee_uid,
    id: row.employee_uid,
    agent_key: row.employee_uid,

    employee_id: row.employee_id || "",
    employee_number: row.employee_number || row.employee_id || "",
    employee_name: row.employee_name || "",
    agent_name: row.employee_name || "",

    email: row.email || "",
    position: row.position || "Agent",
    department: row.department || "",
    team: row.team || "",
    supervisor: row.supervisor || "",
    account_name: row.account_name || "US Visa",

    status: row.status || "Active",
    employment_status: row.employment_status || "Active",

    task_order: row.task_order || row.assigned_sub_account || "",
    assigned_sub_account: row.assigned_sub_account || row.task_order || "",
    herodash: row.herodash || "",
    msd: row.msd || "",

    include_dashboard: Number(row.include_dashboard ?? 1),
    include_reports: Number(row.include_reports ?? 1),
    kpi_tracking_enabled: Number(row.kpi_tracking_enabled ?? 1),
  }));
}

async function loadEmployeeAliases() {
  const [rows] = await db.query(`
    SELECT
      employee_uid,
      source_system,
      source_agent_name,
      source_agent_key,
      is_active
    FROM us_visa_kpi_employee_aliases
    WHERE COALESCE(is_active, 1) = 1
  `);

  return rows;
}

async function buildEmployeeLookup() {
  const employees = await loadOfficialEmployees();
  const aliases = await loadEmployeeAliases();

  const employeeByUid = new Map();
  const sourceKeyToEmployeeUid = new Map();

  employees.forEach((employee) => {
    if (!employee.employee_uid) return;

    employeeByUid.set(employee.employee_uid, employee);

    const possibleAliases = [
      employee.employee_uid,
      employee.employee_id,
      employee.employee_number,
      employee.employee_name,
      employee.agent_name,
      employee.herodash,
      employee.msd,
    ];

    possibleAliases.forEach((value) => {
      const key = normalizeAgentKey(value);

      if (key) {
        sourceKeyToEmployeeUid.set(key, employee.employee_uid);
      }
    });
  });

  aliases.forEach((alias) => {
    const employeeUid = cleanString(alias.employee_uid);

    if (!employeeUid || !employeeByUid.has(employeeUid)) return;

    const possibleAliases = [alias.source_agent_key, alias.source_agent_name];

    possibleAliases.forEach((value) => {
      const key = normalizeAgentKey(value);

      if (key) {
        sourceKeyToEmployeeUid.set(key, employeeUid);
      }
    });
  });

  return {
    employees,
    employeeByUid,
    sourceKeyToEmployeeUid,
  };
}

function resolveOfficialEmployee(row, lookup) {
  const possibleKeys = [
    row.agent_key,
    row.agent_name,
    row.employee_uid,
    row.employee_id,
  ];

  for (const value of possibleKeys) {
    const key = normalizeAgentKey(value);

    if (!key) continue;

    const employeeUid = lookup.sourceKeyToEmployeeUid.get(key);

    if (employeeUid && lookup.employeeByUid.has(employeeUid)) {
      return lookup.employeeByUid.get(employeeUid);
    }
  }

  return null;
}

function combineCanonicalRows(rows = []) {
  const combinedMap = new Map();

  rows.forEach((row) => {
    const key = [
      row.batch_id,
      row.production_date,
      row.employee_uid,
      row.interval_hour,
    ].join("__");

    if (!combinedMap.has(key)) {
      combinedMap.set(key, {
        ...row,

        expected_seconds: Number(row.expected_seconds || 0),
        actual_logged_seconds: Number(row.actual_logged_seconds || 0),

        handled_calls: Number(row.handled_calls || 0),
        talk_seconds_total:
          Number(row.avg_talk_seconds || 0) * Number(row.handled_calls || 0),
        hold_seconds_total:
          Number(row.avg_hold_seconds || 0) * Number(row.handled_calls || 0),

        available_seconds: Number(row.available_seconds || 0),

        occupancy_weighted:
          Number(row.phone_occupancy_pct || 0) *
          Number(row.actual_logged_seconds || 0),

        email_capacity: Number(row.email_capacity || 0),
        target_emails: Number(row.target_emails || 0),
        actual_emails: Number(row.actual_emails || 0),

        efficiency_weighted:
          Number(row.actual_efficiency_pct || 0) *
          Number(row.expected_seconds || 0),
      });

      return;
    }

    const current = combinedMap.get(key);

    current.expected_seconds = Math.max(
      Number(current.expected_seconds || 0),
      Number(row.expected_seconds || 0)
    );

    current.actual_logged_seconds += Number(row.actual_logged_seconds || 0);
    current.handled_calls += Number(row.handled_calls || 0);

    current.talk_seconds_total +=
      Number(row.avg_talk_seconds || 0) * Number(row.handled_calls || 0);

    current.hold_seconds_total +=
      Number(row.avg_hold_seconds || 0) * Number(row.handled_calls || 0);

    current.available_seconds += Number(row.available_seconds || 0);

    current.occupancy_weighted +=
      Number(row.phone_occupancy_pct || 0) *
      Number(row.actual_logged_seconds || 0);

    current.email_capacity += Number(row.email_capacity || 0);
    current.target_emails += Number(row.target_emails || 0);
    current.actual_emails += Number(row.actual_emails || 0);

    current.efficiency_weighted +=
      Number(row.actual_efficiency_pct || 0) * Number(row.expected_seconds || 0);
  });

  return [...combinedMap.values()].map((row) => {
    const handledCalls = Number(row.handled_calls || 0);
    const actualLoggedSeconds = Number(row.actual_logged_seconds || 0);
    const expectedSeconds = Number(row.expected_seconds || 0);
    const targetEmails = Number(row.target_emails || 0);
    const actualEmails = Number(row.actual_emails || 0);

    return {
      ...row,

      avg_talk_seconds:
        handledCalls > 0
          ? Math.round(Number(row.talk_seconds_total || 0) / handledCalls)
          : 0,

      avg_hold_seconds:
        handledCalls > 0
          ? Math.round(Number(row.hold_seconds_total || 0) / handledCalls)
          : 0,

      phone_occupancy_pct:
        actualLoggedSeconds > 0
          ? roundNumber(
              Number(row.occupancy_weighted || 0) / actualLoggedSeconds,
              1
            )
          : 0,

      email_utilization_pct:
        targetEmails > 0
          ? roundNumber((actualEmails / targetEmails) * 100, 1)
          : actualEmails > 0
            ? 100
            : 0,

      actual_efficiency_pct:
        expectedSeconds > 0
          ? roundNumber(Number(row.efficiency_weighted || 0) / expectedSeconds, 1)
          : 0,
    };
  });
}

function canonicalizeSummaryRows(rows = [], lookup, employeeIds = []) {
  const allowedEmployeeIds = new Set(employeeIds);

  const canonicalRows = rows
    .map((row) => {
      const officialEmployee = resolveOfficialEmployee(row, lookup);

      if (!officialEmployee) return null;

      if (
        allowedEmployeeIds.size > 0 &&
        !allowedEmployeeIds.has(officialEmployee.employee_uid)
      ) {
        return null;
      }

      return {
        ...row,
        employee_uid: officialEmployee.employee_uid,
        employee_id: officialEmployee.employee_id,
        employee_number: officialEmployee.employee_number,
        employee_name: officialEmployee.employee_name,

        agent_key: officialEmployee.employee_uid,
        agent_name: officialEmployee.employee_name,

        email: officialEmployee.email,
        position: officialEmployee.position || "Agent",
        team: officialEmployee.team || "",
        supervisor: officialEmployee.supervisor || "",
      };
    })
    .filter(Boolean);

  return combineCanonicalRows(canonicalRows);
}

async function getSummaryRows({
  date,
  fromHour = 8,
  toHour = 17,
  employeeIds = [],
  batchId = null,
  lookup,
}) {
  const conditions = ["production_date = ?"];
  const params = [date];

  conditions.push("interval_hour BETWEEN ? AND ?");
  params.push(Number(fromHour), Number(toHour));

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

  return canonicalizeSummaryRows(rows, lookup, employeeIds);
}

function buildSummaryMetrics(rows = []) {
  if (rows.length === 0) {
    return {
      loggedTime: 0,
      expectedHours: 0,
      loggedFormatted: "0h 0m",
      loggedAchievement: 0,

      handledCalls: 0,
      callsTarget: 0,
      callsAchievement: 0,

      avgTalkTime: 0,
      talkTarget: TALK_TARGET_SECONDS,

      avgHoldTime: 0,
      holdTarget: HOLD_TARGET_SECONDS,

      phoneOccupancy: 0,

      availableEmailCapacity: 0,
      targetEmails: 0,
      actualEmails: 0,
      emailUtilization: 0,

      actualEfficiency: 0,
    };
  }

  const totalExpectedSeconds = rows.reduce(
    (sum, row) => sum + Number(row.expected_seconds || 0),
    0
  );

  const totalLoggedSeconds = rows.reduce(
    (sum, row) => sum + Number(row.actual_logged_seconds || 0),
    0
  );

  const totalHandledCalls = rows.reduce(
    (sum, row) => sum + Number(row.handled_calls || 0),
    0
  );

  const totalTalkSeconds = rows.reduce(
    (sum, row) =>
      sum + Number(row.avg_talk_seconds || 0) * Number(row.handled_calls || 0),
    0
  );

  const totalHoldSeconds = rows.reduce(
    (sum, row) =>
      sum + Number(row.avg_hold_seconds || 0) * Number(row.handled_calls || 0),
    0
  );

  const totalPhoneOccupancyWeighted = rows.reduce(
    (sum, row) =>
      sum +
      Number(row.phone_occupancy_pct || 0) *
        Number(row.actual_logged_seconds || 0),
    0
  );

  const totalEmailCapacity = rows.reduce(
    (sum, row) => sum + Number(row.email_capacity || 0),
    0
  );

  const totalTargetEmails = rows.reduce(
    (sum, row) => sum + Number(row.target_emails || 0),
    0
  );

  const totalActualEmails = rows.reduce(
    (sum, row) => sum + Number(row.actual_emails || 0),
    0
  );

  const totalEfficiencyWeighted = rows.reduce(
    (sum, row) =>
      sum +
      Number(row.actual_efficiency_pct || 0) * Number(row.expected_seconds || 0),
    0
  );

  const callsTarget = rows.length * CALL_TARGET_PER_HOUR;

  const avgTalkTime =
    totalHandledCalls > 0
      ? Math.round(totalTalkSeconds / totalHandledCalls)
      : 0;

  const avgHoldTime =
    totalHandledCalls > 0
      ? Math.round(totalHoldSeconds / totalHandledCalls)
      : 0;

  const phoneOccupancy =
    totalLoggedSeconds > 0
      ? Math.round(totalPhoneOccupancyWeighted / totalLoggedSeconds)
      : 0;

  const actualEfficiency =
    totalExpectedSeconds > 0
      ? roundNumber(totalEfficiencyWeighted / totalExpectedSeconds, 1)
      : 0;

  return {
    loggedTime: totalLoggedSeconds,
    expectedHours: roundNumber(totalExpectedSeconds / 3600, 1),
    loggedFormatted: formatLoggedTime(totalLoggedSeconds),
    loggedAchievement:
      totalExpectedSeconds > 0
        ? Math.round((totalLoggedSeconds / totalExpectedSeconds) * 100)
        : 0,

    handledCalls: totalHandledCalls,
    callsTarget,
    callsAchievement:
      callsTarget > 0
        ? Math.min(100, Math.round((totalHandledCalls / callsTarget) * 100))
        : 0,

    avgTalkTime,
    talkTarget: TALK_TARGET_SECONDS,

    avgHoldTime,
    holdTarget: HOLD_TARGET_SECONDS,

    phoneOccupancy,

    availableEmailCapacity: totalEmailCapacity,
    targetEmails: totalTargetEmails,
    actualEmails: totalActualEmails,
    emailUtilization:
      totalTargetEmails > 0
        ? Math.round((totalActualEmails / totalTargetEmails) * 100)
        : totalActualEmails > 0
          ? 100
          : 0,

    actualEfficiency,
  };
}

function buildHourlyChartData(rows = [], fromHour = 8, toHour = 17) {
  const data = [];

  for (let hour = Number(fromHour); hour <= Number(toHour); hour += 1) {
    const hourRows = rows.filter((row) => Number(row.interval_hour) === hour);

    const totalExpectedSeconds = hourRows.reduce(
      (sum, row) => sum + Number(row.expected_seconds || 0),
      0
    );

    const totalLoggedSeconds = hourRows.reduce(
      (sum, row) => sum + Number(row.actual_logged_seconds || 0),
      0
    );

    const totalCalls = hourRows.reduce(
      (sum, row) => sum + Number(row.handled_calls || 0),
      0
    );

    const totalTalkSeconds = hourRows.reduce(
      (sum, row) =>
        sum +
        Number(row.avg_talk_seconds || 0) * Number(row.handled_calls || 0),
      0
    );

    const totalHoldSeconds = hourRows.reduce(
      (sum, row) =>
        sum +
        Number(row.avg_hold_seconds || 0) * Number(row.handled_calls || 0),
      0
    );

    const totalPhoneOccupancyWeighted = hourRows.reduce(
      (sum, row) =>
        sum +
        Number(row.phone_occupancy_pct || 0) *
          Number(row.actual_logged_seconds || 0),
      0
    );

    const totalTargetEmails = hourRows.reduce(
      (sum, row) => sum + Number(row.target_emails || 0),
      0
    );

    const totalActualEmails = hourRows.reduce(
      (sum, row) => sum + Number(row.actual_emails || 0),
      0
    );

    const totalEmailCapacity = hourRows.reduce(
      (sum, row) => sum + Number(row.email_capacity || 0),
      0
    );

    const totalEfficiencyWeighted = hourRows.reduce(
      (sum, row) =>
        sum +
        Number(row.actual_efficiency_pct || 0) *
          Number(row.expected_seconds || 0),
      0
    );

    const avgTalkTime =
      totalCalls > 0 ? Math.round(totalTalkSeconds / totalCalls) : 0;

    const avgHoldTime =
      totalCalls > 0 ? Math.round(totalHoldSeconds / totalCalls) : 0;

    const occupiedPercent =
      totalLoggedSeconds > 0
        ? Math.round(totalPhoneOccupancyWeighted / totalLoggedSeconds)
        : 0;

    const efficiency =
      totalExpectedSeconds > 0
        ? Math.round(totalEfficiencyWeighted / totalExpectedSeconds)
        : 0;

    data.push({
      hour: getHourLabel(hour),

      "Expected Hours": roundNumber(totalExpectedSeconds / 3600, 1),
      "Logged Time": roundNumber(totalLoggedSeconds / 3600, 1),

      "Calls Actual": totalCalls,
      "Calls Target": hourRows.length * CALL_TARGET_PER_HOUR,

      "Avg Talk Time (s)": avgTalkTime,
      "Avg Hold Time (s)": avgHoldTime,

      "Occupied %": occupiedPercent,
      "Available %": Math.max(0, 100 - occupiedPercent),

      "Actual Emails": totalActualEmails,
      "Target Emails": totalTargetEmails,
      "Email Capacity": totalEmailCapacity,

      "Efficiency %": efficiency,
    });
  }

  return data;
}

function buildTeamInsights(rows = []) {
  if (rows.length === 0) return null;

  const agentMap = new Map();

  rows.forEach((row) => {
    const key = row.agent_key;
    const agentName = row.agent_name;

    if (!agentMap.has(key)) {
      agentMap.set(key, {
        agentName,
        expectedSeconds: 0,
        handledCalls: 0,
        occupancyWeighted: 0,
        loggedSeconds: 0,
        efficiencyWeighted: 0,
      });
    }

    const agent = agentMap.get(key);

    agent.expectedSeconds += Number(row.expected_seconds || 0);
    agent.handledCalls += Number(row.handled_calls || 0);
    agent.loggedSeconds += Number(row.actual_logged_seconds || 0);

    agent.occupancyWeighted +=
      Number(row.phone_occupancy_pct || 0) *
      Number(row.actual_logged_seconds || 0);

    agent.efficiencyWeighted +=
      Number(row.actual_efficiency_pct || 0) * Number(row.expected_seconds || 0);
  });

  const agents = [...agentMap.values()].map((agent) => {
    const efficiency =
      agent.expectedSeconds > 0
        ? roundNumber(agent.efficiencyWeighted / agent.expectedSeconds, 1)
        : 0;

    const occupancy =
      agent.loggedSeconds > 0
        ? roundNumber(agent.occupancyWeighted / agent.loggedSeconds, 1)
        : 0;

    return {
      ...agent,
      efficiency,
      occupancy,
    };
  });

  const highestEff = [...agents].sort((a, b) => b.efficiency - a.efficiency)[0];
  const mostCalls = [...agents].sort((a, b) => b.handledCalls - a.handledCalls)[0];
  const highestOcc = [...agents].sort((a, b) => b.occupancy - a.occupancy)[0];
  const lowestEff = [...agents].sort((a, b) => a.efficiency - b.efficiency)[0];

  const teamAverage =
    agents.length > 0
      ? Math.round(
          agents.reduce((sum, agent) => sum + agent.efficiency, 0) /
            agents.length
        )
      : 0;

  return {
    highestEffName: highestEff?.agentName || "N/A",
    highestEffVal: highestEff?.efficiency || 0,

    mostCallsName: mostCalls?.agentName || "N/A",
    mostCallsVal: mostCalls?.handledCalls || 0,

    highestOccupancy: highestOcc?.occupancy || 0,

    lowestEfficiency: lowestEff?.efficiency || 0,

    teamAverage,
  };
}

export async function getUsVisaKpiAgents() {
  const lookup = await buildEmployeeLookup();

  return {
    success: true,
    data: lookup.employees.map((employee) => ({
      id: employee.employee_uid,
      agent_key: employee.employee_uid,

      employee_uid: employee.employee_uid,
      employee_id: employee.employee_id,
      employee_number: employee.employee_number,

      employee_name: employee.employee_name,
      agent_name: employee.employee_name,

      email: employee.email,
      position: employee.position || "Agent",
      team: employee.team || "",

      status: employee.status || "Active",
      employment_status: employee.employment_status || "Active",
    })),
  };
}

export async function getUsVisaKpiDashboard(query = {}) {
  const selectedDate =
    cleanString(query.date) || (await getLatestProductionDate());

  const lookup = await buildEmployeeLookup();

  if (!selectedDate) {
    const emptyMetrics = buildSummaryMetrics([]);

    return {
      success: true,
      data: {
        selectedDate: "",
        previousDate: "",
        trendBasis: "No KPI data available",
        fromHour: 8,
        toHour: 17,
        selectedEmployees: [],
        summaryMetrics: {
          ...emptyMetrics,
          trends: getEmptyTrends(),
        },
        hourlyChartData: buildHourlyChartData([], 8, 17),
        teamInsights: null,
        agents: lookup.employees,
        rawCount: 0,
      },
    };
  }

  const fromHour = Number(query.fromHour || 8);
  const toHour = Number(query.toHour || 17);
  const employeeIds = parseEmployeeIds(query.employeeIds);
  const batchId = query.batchId ? Number(query.batchId) : null;

  const currentRows = await getSummaryRows({
    date: selectedDate,
    fromHour,
    toHour,
    employeeIds,
    batchId,
    lookup,
  });

  const previousDate = await getPreviousProductionDate(selectedDate);

  let previousRows = [];

  if (previousDate) {
    previousRows = await getSummaryRows({
      date: previousDate,
      fromHour,
      toHour,
      employeeIds,
      batchId: null,
      lookup,
    });
  }

  const currentMetrics = buildSummaryMetrics(currentRows);
  const previousMetrics =
    previousRows.length > 0 ? buildSummaryMetrics(previousRows) : null;

  const trends = previousMetrics
    ? buildMetricTrends(currentMetrics, previousMetrics)
    : buildSameDayTrendFromHourlyRows(currentRows, fromHour, toHour);

  const summaryMetrics = {
    ...currentMetrics,
    trends,
  };

  const agentsResult = await getUsVisaKpiAgents();

  return {
    success: true,
    data: {
      selectedDate,
      previousDate: previousDate || "",
      trendBasis: previousMetrics
        ? `Compared with previous production date ${previousDate}`
        : "Compared first available hour vs last available hour on selected date",
      fromHour,
      toHour,
      selectedEmployees: employeeIds.length > 0 ? employeeIds : ["all"],

      summaryMetrics,
      hourlyChartData: buildHourlyChartData(currentRows, fromHour, toHour),
      teamInsights: buildTeamInsights(currentRows),

      agents: agentsResult.data,
      rawCount: currentRows.length,
    },
  };
}
