import db from "../config/db.js";
import { cleanString } from "./usVisaKpiParserService.js";

function toBoolDb(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback ? 1 : 0;
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

function fromBoolDb(value) {
  return value === true || value === 1 || value === "1";
}

export function normalizeAgentKey(value) {
  return cleanString(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
}

function makeEmployeeUid(payload = {}) {
  const existing = cleanString(payload.employee_uid || payload.id);
  if (existing) return existing;

  const employeeId = cleanString(payload.employee_id || payload.employee_number);
  if (employeeId) return normalizeAgentKey(employeeId);

  const name = cleanString(payload.employee_name || payload.agent_name);
  if (name) return normalizeAgentKey(name);

  return `emp_${Date.now()}`;
}

function nullIfEmpty(value) {
  const cleaned = cleanString(value);
  return cleaned || null;
}

function toDateTimeOrNull(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function mapEmployeeRow(row = {}) {
  return {
    id: row.employee_uid,
    employee_uid: row.employee_uid,
    employee_id: row.employee_id || "",
    employee_number: row.employee_number || "",
    employee_name: row.employee_name || "",
    agent_name: row.employee_name || "",
    email: row.email || "",
    position: row.position || "",
    department: row.department || "",
    team: row.team || "",
    supervisor: row.supervisor || "",
    account_name: row.account_name || "US Visa",
    status: row.status || "Active",
    employment_status: row.employment_status || row.status || "Active",
    task_order: row.task_order || "",
    assigned_sub_account: row.assigned_sub_account || row.task_order || "",
    herodash: row.herodash || "",
    msd: row.msd || "",
    include_dashboard: fromBoolDb(row.include_dashboard),
    include_reports: fromBoolDb(row.include_reports),
    kpi_tracking_enabled: fromBoolDb(row.kpi_tracking_enabled),
    task_order_assigned_at: row.task_order_assigned_at,
    sub_account_assigned_at: row.sub_account_assigned_at,
    last_synced_at: row.last_synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildEmployeeValues(payload = {}) {
  const employeeUid = makeEmployeeUid(payload);
  const status = cleanString(payload.status) || "Active";
  const employmentStatus = cleanString(payload.employment_status) || status;
  const employeeId = nullIfEmpty(payload.employee_id || payload.employee_number);
  const taskOrder = nullIfEmpty(payload.task_order || payload.assigned_sub_account);
  const timestamp = toDateTimeOrNull(new Date());

  return {
    employee_uid: employeeUid,
    employee_id: employeeId,
    employee_number: nullIfEmpty(payload.employee_number || payload.employee_id),
    employee_name: cleanString(payload.employee_name || payload.agent_name),
    email: nullIfEmpty(payload.email),
    position: nullIfEmpty(payload.position),
    department: nullIfEmpty(payload.department) || "US Visa Operations",
    team: nullIfEmpty(payload.team),
    supervisor: nullIfEmpty(payload.supervisor),
    account_name: nullIfEmpty(payload.account_name) || "US Visa",
    status,
    employment_status: employmentStatus,
    task_order: taskOrder,
    assigned_sub_account: taskOrder,
    herodash: nullIfEmpty(payload.herodash || payload.heroDash || payload.hero_dash),
    msd: nullIfEmpty(payload.msd || payload.MSD),
    include_dashboard: toBoolDb(payload.include_dashboard, true),
    include_reports: toBoolDb(payload.include_reports, true),
    kpi_tracking_enabled: toBoolDb(payload.kpi_tracking_enabled, true),
    task_order_assigned_at: taskOrder
      ? toDateTimeOrNull(payload.task_order_assigned_at || timestamp)
      : null,
    sub_account_assigned_at: taskOrder
      ? toDateTimeOrNull(payload.sub_account_assigned_at || timestamp)
      : null,
    last_synced_at: toDateTimeOrNull(payload.last_synced_at),
  };
}

function buildAliasesFromEmployee(employee = {}, extraAliases = []) {
  const aliases = [];

  const addAlias = (sourceSystem, value) => {
    const name = cleanString(value);
    const key = normalizeAgentKey(name);

    if (!name || !key) return;

    aliases.push({
      employee_uid: employee.employee_uid,
      source_system: sourceSystem,
      source_agent_name: name,
      source_agent_key: key,
    });
  };

  addAlias("official_name", employee.employee_name);
  addAlias("employee_id", employee.employee_id);
  addAlias("employee_number", employee.employee_number);
  addAlias("herodash", employee.herodash);
  addAlias("msd", employee.msd);

  extraAliases.forEach((alias) => {
    if (typeof alias === "string") {
      addAlias("manual", alias);
      return;
    }

    addAlias(alias.source_system || "manual", alias.source_agent_name || alias.name || alias.value);
  });

  const seen = new Set();
  return aliases.filter((alias) => {
    if (seen.has(alias.source_agent_key)) return false;
    seen.add(alias.source_agent_key);
    return true;
  });
}

async function replaceEmployeeAliases(employee, aliases = []) {
  await db.query(
    `
    DELETE FROM us_visa_kpi_employee_aliases
    WHERE employee_uid = ?
    `,
    [employee.employee_uid]
  );

  const normalizedAliases = buildAliasesFromEmployee(employee, aliases);

  if (normalizedAliases.length === 0) return;

  const values = normalizedAliases.map((alias) => [
    alias.employee_uid,
    alias.source_system,
    alias.source_agent_name,
    alias.source_agent_key,
    1,
  ]);

  await db.query(
    `
    INSERT INTO us_visa_kpi_employee_aliases (
      employee_uid,
      source_system,
      source_agent_name,
      source_agent_key,
      is_active
    )
    VALUES ?
    ON DUPLICATE KEY UPDATE
      employee_uid = VALUES(employee_uid),
      source_system = VALUES(source_system),
      source_agent_name = VALUES(source_agent_name),
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP
    `,
    [values]
  );
}


async function upsertEmployeeAliases(employeeUid, aliases = []) {
  const normalizedAliases = [];

  aliases.forEach((alias) => {
    const sourceSystem = cleanString(alias.source_system || "manual") || "manual";
    const sourceAgentName = cleanString(
      alias.source_agent_name || alias.name || alias.value
    );
    const sourceAgentKey = normalizeAgentKey(
      alias.source_agent_key || sourceAgentName
    );

    if (!employeeUid || !sourceAgentName || !sourceAgentKey) return;

    normalizedAliases.push({
      employee_uid: employeeUid,
      source_system: sourceSystem,
      source_agent_name: sourceAgentName,
      source_agent_key: sourceAgentKey,
    });
  });

  const seen = new Set();
  const uniqueAliases = normalizedAliases.filter((alias) => {
    const key = `${alias.employee_uid}__${alias.source_agent_key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (uniqueAliases.length === 0) return 0;

  const values = uniqueAliases.map((alias) => [
    alias.employee_uid,
    alias.source_system,
    alias.source_agent_name,
    alias.source_agent_key,
    1,
  ]);

  await db.query(
    `
    INSERT INTO us_visa_kpi_employee_aliases (
      employee_uid,
      source_system,
      source_agent_name,
      source_agent_key,
      is_active
    )
    VALUES ?
    ON DUPLICATE KEY UPDATE
      employee_uid = VALUES(employee_uid),
      source_system = VALUES(source_system),
      source_agent_name = VALUES(source_agent_name),
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP
    `,
    [values]
  );

  return uniqueAliases.length;
}


function getRosterValue(row = {}, keys = []) {
  if (!row || typeof row !== "object") return "";

  const normalized = new Map();

  Object.keys(row).forEach((key) => {
    normalized.set(normalizeAgentKey(key), key);
  });

  for (const key of keys) {
    const realKey = normalized.get(normalizeAgentKey(key));

    if (!realKey) continue;

    const value = row[realKey];

    if (value !== undefined && value !== null && cleanString(value) !== "") {
      return cleanString(value);
    }
  }

  return "";
}

function splitNameTokens(value) {
  return cleanString(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function generateOfficialNameAliasValues(employeeName) {
  const aliases = new Set();
  const cleanName = cleanString(employeeName);
  const tokens = splitNameTokens(cleanName);

  if (cleanName) aliases.add(cleanName);

  if (tokens.length >= 2) {
    aliases.add(`${tokens[0]} ${tokens[tokens.length - 1]}`);
  }

  if (tokens.length >= 3) {
    aliases.add(`${tokens[0]} ${tokens[1]} ${tokens[tokens.length - 1]}`);
    aliases.add(`${tokens[0]}${tokens[1]} ${tokens[tokens.length - 1]}`);
  }

  return [...aliases].filter((alias) => normalizeAgentKey(alias));
}

function levenshteinDistance(a = "", b = "") {
  const left = String(a);
  const right = String(b);

  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array(right.length + 1).fill(0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[right.length];
}

function similarityScore(a = "", b = "") {
  const left = normalizeAgentKey(a);
  const right = normalizeAgentKey(b);

  if (!left || !right) return 0;
  if (left === right) return 1;

  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 0;

  return 1 - levenshteinDistance(left, right) / maxLength;
}

function getFirstLastKey(value) {
  const tokens = splitNameTokens(value);

  if (tokens.length < 2) return "";

  return normalizeAgentKey(`${tokens[0]} ${tokens[tokens.length - 1]}`);
}

function buildOfficialRosterAliases(employeeName, employeeId, extraAliases = []) {
  const aliases = [];

  generateOfficialNameAliasValues(employeeName).forEach((aliasName) => {
    aliases.push({
      source_system: "official_roster_name",
      source_agent_name: aliasName,
      source_agent_key: normalizeAgentKey(aliasName),
    });
  });

  if (employeeId) {
    aliases.push({
      source_system: "official_roster_sib_id",
      source_agent_name: employeeId,
      source_agent_key: normalizeAgentKey(employeeId),
    });
  }

  extraAliases.forEach((aliasName) => {
    const cleanAlias = cleanString(aliasName);

    if (!cleanAlias) return;

    aliases.push({
      source_system: "official_roster_auto_alias",
      source_agent_name: cleanAlias,
      source_agent_key: normalizeAgentKey(cleanAlias),
    });
  });

  const seen = new Set();

  return aliases.filter((alias) => {
    if (!alias.source_agent_key || seen.has(alias.source_agent_key)) return false;
    seen.add(alias.source_agent_key);
    return true;
  });
}

async function loadLatestKpiSourceAgents() {
  const latestDate = await getLatestKpiSummaryDate();

  if (!latestDate) return [];

  const [rows] = await db.query(
    `
    SELECT DISTINCT agent_key, agent_name
    FROM us_visa_kpi_hourly_summary
    WHERE production_date = ?
    ORDER BY agent_name ASC
    `,
    [latestDate]
  );

  return rows.map((row) => ({
    agent_key: normalizeAgentKey(row.agent_key || row.agent_name),
    agent_name: cleanString(row.agent_name),
  }));
}

async function getLatestKpiSummaryDate() {
  const [rows] = await db.query(
    `
    SELECT production_date
    FROM us_visa_kpi_hourly_summary
    ORDER BY production_date DESC
    LIMIT 1
    `
  );

  if (!rows[0]?.production_date) return "";

  const value = rows[0].production_date;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const raw = cleanString(value);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
}

export async function listUsVisaKpiEmployees({
  activeOnly = false,
  includeDashboardOnly = false,
  search = "",
} = {}) {
  const conditions = ["account_name LIKE ?"];
  const params = ["%US Visa%"];

  if (activeOnly) {
    conditions.push("status = 'Active'");
    conditions.push("employment_status = 'Active'");
  }

  if (includeDashboardOnly) {
    conditions.push("include_dashboard = 1");
    conditions.push("kpi_tracking_enabled = 1");
  }

  const cleanSearch = cleanString(search);
  if (cleanSearch) {
    conditions.push(`(
      employee_name LIKE ? OR
      employee_id LIKE ? OR
      employee_number LIKE ? OR
      email LIKE ? OR
      task_order LIKE ? OR
      herodash LIKE ? OR
      msd LIKE ?
    )`);
    const like = `%${cleanSearch}%`;
    params.push(like, like, like, like, like, like, like);
  }

  const [rows] = await db.query(
    `
    SELECT *
    FROM us_visa_kpi_employees
    WHERE ${conditions.join(" AND ")}
    ORDER BY employee_name ASC
    `,
    params
  );

  return rows.map(mapEmployeeRow);
}

export async function getUsVisaKpiEmployeeByUid(employeeUid) {
  const [rows] = await db.query(
    `
    SELECT *
    FROM us_visa_kpi_employees
    WHERE employee_uid = ?
    LIMIT 1
    `,
    [employeeUid]
  );

  return rows[0] ? mapEmployeeRow(rows[0]) : null;
}

export async function createUsVisaKpiEmployee(payload = {}) {
  const employee = buildEmployeeValues(payload);

  if (!employee.employee_name) {
    throw new Error("Employee name is required.");
  }

  if (!employee.employee_id && !employee.employee_number) {
    throw new Error("SIB ID or employee number is required.");
  }

  if (employee.employee_id) {
    const [duplicates] = await db.query(
      `
      SELECT employee_uid
      FROM us_visa_kpi_employees
      WHERE employee_id = ? OR employee_number = ?
      LIMIT 1
      `,
      [employee.employee_id, employee.employee_id]
    );

    if (duplicates.length > 0) {
      throw new Error("Employee already exists based on SIB ID.");
    }
  }

  if (employee.email) {
    const [duplicates] = await db.query(
      `
      SELECT employee_uid
      FROM us_visa_kpi_employees
      WHERE email = ?
      LIMIT 1
      `,
      [employee.email]
    );

    if (duplicates.length > 0) {
      throw new Error("Employee already exists based on email.");
    }
  }

  await db.query(
    `
    INSERT INTO us_visa_kpi_employees (
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
      kpi_tracking_enabled,
      task_order_assigned_at,
      sub_account_assigned_at,
      last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      employee.employee_uid,
      employee.employee_id,
      employee.employee_number,
      employee.employee_name,
      employee.email,
      employee.position,
      employee.department,
      employee.team,
      employee.supervisor,
      employee.account_name,
      employee.status,
      employee.employment_status,
      employee.task_order,
      employee.assigned_sub_account,
      employee.herodash,
      employee.msd,
      employee.include_dashboard,
      employee.include_reports,
      employee.kpi_tracking_enabled,
      employee.task_order_assigned_at,
      employee.sub_account_assigned_at,
      employee.last_synced_at,
    ]
  );

  await replaceEmployeeAliases(employee, payload.aliases || []);

  return getUsVisaKpiEmployeeByUid(employee.employee_uid);
}

export async function upsertUsVisaKpiEmployee(payload = {}) {
  const employee = buildEmployeeValues(payload);

  if (!employee.employee_name) {
    throw new Error("Employee name is required.");
  }

  await db.query(
    `
    INSERT INTO us_visa_kpi_employees (
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
      kpi_tracking_enabled,
      task_order_assigned_at,
      sub_account_assigned_at,
      last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      employee_id = VALUES(employee_id),
      employee_number = VALUES(employee_number),
      employee_name = VALUES(employee_name),
      email = VALUES(email),
      position = VALUES(position),
      department = VALUES(department),
      team = VALUES(team),
      supervisor = VALUES(supervisor),
      account_name = VALUES(account_name),
      status = VALUES(status),
      employment_status = VALUES(employment_status),
      task_order = VALUES(task_order),
      assigned_sub_account = VALUES(assigned_sub_account),
      herodash = VALUES(herodash),
      msd = VALUES(msd),
      include_dashboard = VALUES(include_dashboard),
      include_reports = VALUES(include_reports),
      kpi_tracking_enabled = VALUES(kpi_tracking_enabled),
      task_order_assigned_at = VALUES(task_order_assigned_at),
      sub_account_assigned_at = VALUES(sub_account_assigned_at),
      last_synced_at = VALUES(last_synced_at),
      updated_at = CURRENT_TIMESTAMP
    `,
    [
      employee.employee_uid,
      employee.employee_id,
      employee.employee_number,
      employee.employee_name,
      employee.email,
      employee.position,
      employee.department,
      employee.team,
      employee.supervisor,
      employee.account_name,
      employee.status,
      employee.employment_status,
      employee.task_order,
      employee.assigned_sub_account,
      employee.herodash,
      employee.msd,
      employee.include_dashboard,
      employee.include_reports,
      employee.kpi_tracking_enabled,
      employee.task_order_assigned_at,
      employee.sub_account_assigned_at,
      employee.last_synced_at,
    ]
  );

  await replaceEmployeeAliases(employee, payload.aliases || []);

  return getUsVisaKpiEmployeeByUid(employee.employee_uid);
}

export async function updateUsVisaKpiEmployee(employeeUid, payload = {}) {
  const existing = await getUsVisaKpiEmployeeByUid(employeeUid);

  if (!existing) {
    throw new Error("Employee not found.");
  }

  const merged = {
    ...existing,
    ...payload,
    employee_uid: employeeUid,
    id: employeeUid,
  };

  await upsertUsVisaKpiEmployee(merged);

  return getUsVisaKpiEmployeeByUid(employeeUid);
}

export async function bulkUpsertUsVisaKpiEmployees(employees = []) {
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const employee of employees) {
    try {
      const employeeUid = makeEmployeeUid(employee);
      const exists = await getUsVisaKpiEmployeeByUid(employeeUid);
      await upsertUsVisaKpiEmployee({ ...employee, employee_uid: employeeUid, id: employeeUid });

      if (exists) updated += 1;
      else added += 1;
    } catch (error) {
      console.error("[US VISA KPI EMPLOYEE BULK UPSERT SKIPPED]", error.message);
      skipped += 1;
    }
  }

  return {
    added,
    updated,
    skipped,
    total: employees.length,
    employees: await listUsVisaKpiEmployees(),
  };
}


export async function syncUsVisaKpiEmployeesFromSummary({
  date = "",
  batchId = null,
} = {}) {
  const selectedDate = cleanString(date) || (await getLatestKpiSummaryDate());

  if (!selectedDate) {
    throw new Error("No KPI summary date found. Generate KPI summary first.");
  }

  const conditions = ["production_date = ?"];
  const params = [selectedDate];

  if (batchId) {
    conditions.push("batch_id = ?");
    params.push(Number(batchId));
  }

  const [sourceRows] = await db.query(
    `
    SELECT
      agent_key,
      agent_name,
      COUNT(*) AS summary_rows,
      SUM(handled_calls) AS handled_calls,
      SUM(actual_emails) AS actual_emails
    FROM us_visa_kpi_hourly_summary
    WHERE ${conditions.join(" AND ")}
    GROUP BY agent_key, agent_name
    ORDER BY agent_name ASC
    `,
    params
  );

  const existingEmployees = await listUsVisaKpiEmployees();

  const [aliasRows] = await db.query(
    `
    SELECT employee_uid, source_agent_key
    FROM us_visa_kpi_employee_aliases
    WHERE is_active = 1
    `
  );

  const employeeByUid = new Map();
  const employeeByKey = new Map();
  const aliasToEmployeeUid = new Map();

  existingEmployees.forEach((employee) => {
    employeeByUid.set(employee.employee_uid, employee);

    [
      employee.employee_uid,
      employee.employee_id,
      employee.employee_number,
      employee.employee_name,
      employee.herodash,
      employee.msd,
      ...generateOfficialNameAliasValues(employee.employee_name),
    ].forEach((value) => {
      const key = normalizeAgentKey(value);
      if (key) employeeByKey.set(key, employee);
    });
  });

  aliasRows.forEach((alias) => {
    const key = normalizeAgentKey(alias.source_agent_key);
    if (key) aliasToEmployeeUid.set(key, alias.employee_uid);
  });

  let matched = 0;
  let aliasesCreated = 0;
  let skipped = 0;
  const unmatched = [];

  for (const sourceRow of sourceRows) {
    const sourceName = cleanString(sourceRow.agent_name);
    const sourceKey = normalizeAgentKey(sourceRow.agent_key || sourceName);

    if (!sourceName || !sourceKey) {
      skipped += 1;
      continue;
    }

    const aliasEmployeeUid = aliasToEmployeeUid.get(sourceKey);
    const existingEmployee =
      (aliasEmployeeUid && employeeByUid.get(aliasEmployeeUid)) ||
      employeeByKey.get(sourceKey) ||
      employeeByKey.get(getFirstLastKey(sourceName));

    if (existingEmployee) {
      const createdCount = await upsertEmployeeAliases(existingEmployee.employee_uid, [
        {
          source_system: "kpi_summary",
          source_agent_name: sourceName,
          source_agent_key: sourceKey,
        },
      ]);

      aliasesCreated += createdCount;
      matched += 1;
      continue;
    }

    unmatched.push({
      source_agent_key: sourceKey,
      source_agent_name: sourceName,
      summary_rows: Number(sourceRow.summary_rows || 0),
      handled_calls: Number(sourceRow.handled_calls || 0),
      actual_emails: Number(sourceRow.actual_emails || 0),
    });
    skipped += 1;
  }

  const employees = await listUsVisaKpiEmployees({
    activeOnly: true,
    includeDashboardOnly: true,
  });

  return {
    selectedDate,
    batchId: batchId ? Number(batchId) : null,
    sourceAgents: sourceRows.length,
    added: 0,
    matched,
    aliasesCreated,
    skipped,
    unmatched,
    employees,
  };
}

export async function importOfficialUsVisaRoster({
  rows = [],
  deactivateMissing = true,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Official roster rows are required.");
  }

  const existingEmployees = await listUsVisaKpiEmployees();
  const [aliasRows] = await db.query(
    `
    SELECT employee_uid, source_agent_key, source_agent_name, source_system
    FROM us_visa_kpi_employee_aliases
    WHERE is_active = 1
    `
  );

  const employeeByUid = new Map();
  const employeeById = new Map();
  const employeeByKey = new Map();
  const existingAliasesByUid = new Map();

  existingEmployees.forEach((employee) => {
    employeeByUid.set(employee.employee_uid, employee);

    [employee.employee_id, employee.employee_number].forEach((value) => {
      const key = normalizeAgentKey(value);
      if (key) employeeById.set(key, employee);
    });

    [
      employee.employee_uid,
      employee.employee_name,
      employee.herodash,
      employee.msd,
      ...generateOfficialNameAliasValues(employee.employee_name),
    ].forEach((value) => {
      const key = normalizeAgentKey(value);
      if (key) employeeByKey.set(key, employee);
    });
  });

  aliasRows.forEach((alias) => {
    const key = normalizeAgentKey(alias.source_agent_key || alias.source_agent_name);
    const employee = employeeByUid.get(alias.employee_uid);

    if (key && employee) {
      employeeByKey.set(key, employee);
    }

    if (!existingAliasesByUid.has(alias.employee_uid)) {
      existingAliasesByUid.set(alias.employee_uid, []);
    }

    existingAliasesByUid.get(alias.employee_uid).push({
      source_system: alias.source_system || "existing_alias",
      source_agent_name: alias.source_agent_name || alias.source_agent_key,
      source_agent_key: alias.source_agent_key,
    });
  });

  const kpiSourceAgents = await loadLatestKpiSourceAgents();
  const officialRows = [];
  const importedUids = new Set();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  rows.forEach((row, index) => {
    const employeeId = getRosterValue(row, [
      "SIB-ID",
      "SIB ID",
      "SIB_ID",
      "SIBID",
      "Employee ID",
      "employee_id",
      "employee number",
      "employee_number",
      "ID",
    ]);

    const employeeName = getRosterValue(row, [
      "Agent Name",
      "Agent",
      "Employee Name",
      "employee_name",
      "Name",
      "Full Name",
      "full_name",
    ]);

    if (!employeeId || !employeeName) {
      skipped += 1;
      return;
    }

    officialRows.push({
      rowNumber: index + 1,
      employeeId,
      employeeName,
      email: getRosterValue(row, ["Email", "email", "Email Address"]),
      position: getRosterValue(row, ["Position", "position", "Job Title"]),
      supervisor: getRosterValue(row, ["Supervisor", "supervisor"]),
      taskOrder: getRosterValue(row, ["Task Order", "task_order", "Assigned Sub Account"]),
      herodash: getRosterValue(row, ["HeroDash", "hero_dash", "Hero Dash"]),
      msd: getRosterValue(row, ["MSD", "msd", "MSD Name"]),
    });
  });

  for (const officialRow of officialRows) {
    const employeeIdKey = normalizeAgentKey(officialRow.employeeId);
    const officialNameKey = normalizeAgentKey(officialRow.employeeName);
    const firstLastKey = getFirstLastKey(officialRow.employeeName);

    const existingEmployee =
      employeeById.get(employeeIdKey) ||
      employeeByKey.get(officialNameKey) ||
      employeeByKey.get(firstLastKey);

    const employeeUid = existingEmployee?.employee_uid || employeeIdKey;
    const existingAliases = existingAliasesByUid.get(employeeUid) || [];
    const autoAliasNames = [];
    const officialAliasKeys = new Set(
      generateOfficialNameAliasValues(officialRow.employeeName).map((value) =>
        normalizeAgentKey(value)
      )
    );
    officialAliasKeys.add(employeeIdKey);

    kpiSourceAgents.forEach((sourceAgent) => {
      if (!sourceAgent.agent_key || !sourceAgent.agent_name) return;

      const sourceFirstLastKey = getFirstLastKey(sourceAgent.agent_name);
      const sourceMatchesKnownVariant = officialAliasKeys.has(sourceAgent.agent_key);
      const sourceMatchesFirstLast =
        firstLastKey && sourceFirstLastKey && firstLastKey === sourceFirstLastKey;
      const sourceLooksSimilar =
        officialNameKey[0] === sourceAgent.agent_key[0] &&
        similarityScore(officialNameKey, sourceAgent.agent_key) >= 0.88;

      if (sourceMatchesKnownVariant || sourceMatchesFirstLast || sourceLooksSimilar) {
        autoAliasNames.push(sourceAgent.agent_name);
      }
    });

    const aliases = [
      ...buildOfficialRosterAliases(
        officialRow.employeeName,
        officialRow.employeeId,
        autoAliasNames
      ),
      ...existingAliases,
    ];

    await upsertUsVisaKpiEmployee({
      employee_uid: employeeUid,
      id: employeeUid,
      employee_id: officialRow.employeeId,
      employee_number: officialRow.employeeId,
      employee_name: officialRow.employeeName,
      email: officialRow.email || existingEmployee?.email || "",
      position: officialRow.position || existingEmployee?.position || "Agent",
      department: existingEmployee?.department || "US Visa Operations",
      team: "",
      supervisor: officialRow.supervisor || existingEmployee?.supervisor || "",
      account_name: "US Visa",
      status: "Active",
      employment_status: "Active",
      task_order: officialRow.taskOrder || existingEmployee?.task_order || "",
      assigned_sub_account: officialRow.taskOrder || existingEmployee?.assigned_sub_account || "",
      herodash: officialRow.herodash || existingEmployee?.herodash || officialRow.employeeName,
      msd: officialRow.msd || existingEmployee?.msd || officialRow.employeeName,
      include_dashboard: true,
      include_reports: true,
      kpi_tracking_enabled: true,
      last_synced_at: new Date().toISOString(),
      aliases,
    });

    await upsertEmployeeAliases(employeeUid, aliases);

    importedUids.add(employeeUid);

    if (existingEmployee) updated += 1;
    else added += 1;
  }

  let deactivated = 0;

  if (deactivateMissing && importedUids.size > 0) {
    const importedUidList = [...importedUids];
    const placeholders = importedUidList.map(() => "?").join(",");

    const [result] = await db.query(
      `
      UPDATE us_visa_kpi_employees
      SET
        status = 'Inactive',
        employment_status = 'Inactive',
        include_dashboard = 0,
        kpi_tracking_enabled = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE account_name LIKE '%US Visa%'
        AND employee_uid NOT IN (${placeholders})
      `,
      importedUidList
    );

    deactivated = result.affectedRows || 0;
  }

  const employees = await listUsVisaKpiEmployees({
    activeOnly: true,
    includeDashboardOnly: true,
  });

  return {
    employees,
    summary: {
      totalRows: rows.length,
      officialRows: officialRows.length,
      added,
      updated,
      skipped,
      deactivated,
      aliasesCreated: officialRows.length,
    },
  };
}

export async function getUsVisaKpiEmployeeLookupForDashboard() {
  const employees = await listUsVisaKpiEmployees({
    activeOnly: true,
    includeDashboardOnly: true,
  });

  const [aliasRows] = await db.query(
    `
    SELECT a.*, e.employee_name, e.status, e.employment_status, e.include_dashboard, e.kpi_tracking_enabled
    FROM us_visa_kpi_employee_aliases a
    INNER JOIN us_visa_kpi_employees e ON e.employee_uid = a.employee_uid
    WHERE a.is_active = 1
      AND e.status = 'Active'
      AND e.employment_status = 'Active'
      AND e.include_dashboard = 1
      AND e.kpi_tracking_enabled = 1
    `
  );

  const employeeByUid = new Map();
  const aliasToEmployee = new Map();

  employees.forEach((employee) => {
    employeeByUid.set(employee.employee_uid, employee);

    [
      employee.employee_uid,
      employee.employee_id,
      employee.employee_number,
      employee.employee_name,
      employee.herodash,
      employee.msd,
    ].forEach((value) => {
      const key = normalizeAgentKey(value);
      if (key) aliasToEmployee.set(key, employee);
    });
  });

  aliasRows.forEach((row) => {
    const employee = employeeByUid.get(row.employee_uid);
    if (!employee) return;

    const key = normalizeAgentKey(row.source_agent_key || row.source_agent_name);
    if (key) aliasToEmployee.set(key, employee);
  });

  return {
    employees,
    employeeByUid,
    aliasToEmployee,
  };
}
