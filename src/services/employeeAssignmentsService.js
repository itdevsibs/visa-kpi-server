import db from "../config/db.js";
import { getKronosDatasFromApi } from "./kronosDatasApiService.js";

const EMPLOYEES_TABLE = "us_visa_kpi_employees";
const ALIASES_TABLE = "us_visa_kpi_employee_aliases";
const KRONOS_PAGE_LIMIT = 100;
const MAX_ASSIGNMENTS_PER_REQUEST = 1000;

function cleanText(value, maxLength = 255) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeComparable(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeSibsId(value) {
  const compact = cleanText(value, 100)
    .toUpperCase()
    .replace(/^SIB[\s_-]*/i, "")
    .replace(/[^A-Z0-9]/g, "");

  return compact ? `SIB-${compact}` : "";
}

function getSibsComparisonKey(value) {
  return normalizeSibsId(value).replace(/^SIB-/, "");
}

function getKronosSibsId(employee = {}) {
  return normalizeSibsId(
    employee.sibsId ||
      employee.sibs_id ||
      employee.employeeId ||
      employee.employee_id ||
      employee.employeeNumber ||
      employee.employee_number ||
      employee.gy_emp_code,
  );
}

function getKronosName(employee = {}) {
  const directName = cleanText(
    employee.fullName ||
      employee.full_name ||
      employee.agentName ||
      employee.agent_name ||
      employee.employeeName ||
      employee.employee_name ||
      employee.name,
  );

  if (directName) return directName;

  return [
    employee.firstName || employee.first_name,
    employee.middleName || employee.middle_name,
    employee.lastName || employee.last_name,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function getKronosAccount(employee = {}) {
  return cleanText(
    employee.account ||
      employee.accountName ||
      employee.account_name ||
      employee.gy_acc_name,
    100,
  );
}

function getKronosStatus(employee = {}) {
  return cleanText(
    employee.status ||
      employee.employeeStatus ||
      employee.employee_status ||
      employee.employmentStatus ||
      employee.employment_status,
    50,
  );
}

export function buildEmployeeUid(sibsId) {
  const normalized = cleanText(sibsId, 100)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) {
    throw new Error("A valid SIB-ID is required to build an employee UID.");
  }

  return normalized;
}

export function normalizeKronosEmployee(employee = {}) {
  return {
    sibsId: getKronosSibsId(employee),
    agentName: getKronosName(employee),
    accountName: getKronosAccount(employee),
    status: getKronosStatus(employee),
  };
}

export function isActiveUsVisaEmployee(employee = {}) {
  const normalized = normalizeKronosEmployee(employee);
  const account = normalizeComparable(normalized.accountName);
  const status = normalizeComparable(normalized.status);

  const belongsToUsVisa = account.includes("us visa");
  const inactiveStatuses = new Set([
    "inactive",
    "resigned",
    "terminated",
    "separated",
    "awol",
    "end of contract",
    "retired",
  ]);

  return (
    Boolean(normalized.sibsId) &&
    Boolean(normalized.agentName) &&
    belongsToUsVisa &&
    !inactiveStatuses.has(status)
  );
}

export function mergeKronosEmployeeWithExisting(
  kronosEmployee,
  existingEmployee = null,
) {
  const employee = normalizeKronosEmployee(kronosEmployee);

  return {
    employeeUid:
      cleanText(existingEmployee?.employee_uid, 100) ||
      buildEmployeeUid(employee.sibsId),
    sibsId: employee.sibsId,
    agentName: employee.agentName,
    accountName: employee.accountName || "US Visa",
    taskOrder: cleanText(
      existingEmployee?.task_order || existingEmployee?.assigned_sub_account,
    ),
    heroDash: cleanText(existingEmployee?.herodash),
    msd: cleanText(existingEmployee?.msd),
  };
}

export function normalizeAssignmentRow(row = {}) {
  return {
    id: Number(row.id || 0),
    employeeUid: cleanText(row.employee_uid, 100),
    sibsId: normalizeSibsId(row.employee_id || row.employee_number),
    agentName: cleanText(row.employee_name),
    taskOrder: cleanText(row.task_order || row.assigned_sub_account),
    heroDash: cleanText(row.herodash),
    msd: cleanText(row.msd),
    updatedAt: row.updated_at || null,
  };
}

function normalizeAssignmentInput(assignment = {}) {
  return {
    sibsId: normalizeSibsId(
      assignment.sibsId ||
        assignment.sibs_id ||
        assignment.employeeId ||
        assignment.employee_id,
    ),
    agentName: cleanText(
      assignment.agentName ||
        assignment.agent_name ||
        assignment.employeeName ||
        assignment.employee_name,
    ),
    taskOrder: cleanText(
      assignment.taskOrder || assignment.task_order || assignment.assigned_sub_account,
    ),
    heroDash: cleanText(
      assignment.heroDash || assignment.herodash || assignment.hero_dash,
    ),
    msd: cleanText(assignment.msd || assignment.MSD),
  };
}

function getPaginationTotalPages(result = {}) {
  return Math.max(
    Number(
      result.pagination?.totalPages ||
        result.pagination?.total_pages ||
        result.pagination?.lastPage ||
        result.pagination?.last_page ||
        1,
    ) || 1,
    1,
  );
}

async function fetchAllKronosEmployees(user) {
  const rows = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await getKronosDatasFromApi(
      {
        page,
        limit: KRONOS_PAGE_LIMIT,
        account: "US Visa",
        department: "All",
        includeDepartments: 0,
        includeAccounts: 0,
      },
      user,
    );

    const pageRows = Array.isArray(result?.data) ? result.data : [];
    rows.push(...pageRows);

    totalPages = getPaginationTotalPages(result);
    page += 1;
  } while (page <= totalPages);

  return rows;
}

function deduplicateKronosEmployees(rows = []) {
  const bySibsId = new Map();

  rows.forEach((row) => {
    if (!isActiveUsVisaEmployee(row)) return;

    const normalized = normalizeKronosEmployee(row);
    const key = getSibsComparisonKey(normalized.sibsId);

    if (!bySibsId.has(key)) {
      bySibsId.set(key, normalized);
    }
  });

  return [...bySibsId.values()].sort((a, b) =>
    a.agentName.localeCompare(b.agentName, undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );
}

function getExistingEmployeeScore(row = {}) {
  return [
    row.task_order || row.assigned_sub_account,
    row.herodash,
    row.msd,
  ].filter((value) => cleanText(value)).length * 100 +
    (cleanText(row.employee_id).toUpperCase().startsWith("SIB-") ? 10 : 0) -
    Number(row.id || 0) / 1_000_000;
}

function selectPreferredExistingEmployee(rows = []) {
  return [...rows].sort(
    (a, b) => getExistingEmployeeScore(b) - getExistingEmployeeScore(a),
  )[0] || null;
}

function groupExistingEmployeesBySibsId(rows = []) {
  const groups = new Map();

  rows.forEach((row) => {
    const key = getSibsComparisonKey(row.employee_id || row.employee_number);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  return groups;
}

export function buildKronosAssignmentRows(
  kronosRows = [],
  existingRows = [],
) {
  const kronosEmployees = deduplicateKronosEmployees(kronosRows);
  const existingGroups = groupExistingEmployeesBySibsId(existingRows);

  return kronosEmployees.map((kronosEmployee) => {
    const key = getSibsComparisonKey(kronosEmployee.sibsId);
    const existing = selectPreferredExistingEmployee(
      existingGroups.get(key) || [],
    );
    const merged = mergeKronosEmployeeWithExisting(
      kronosEmployee,
      existing,
    );

    return normalizeAssignmentRow({
      id: existing?.id || 0,
      employee_uid: merged.employeeUid,
      employee_id: merged.sibsId,
      employee_number: merged.sibsId,
      employee_name: merged.agentName,
      task_order: merged.taskOrder,
      assigned_sub_account: merged.taskOrder,
      herodash: merged.heroDash,
      msd: merged.msd,
      updated_at: existing?.updated_at || null,
    });
  });
}

export async function listEmployeeAssignments(user, connection = db) {
  const kronosRows = await fetchAllKronosEmployees(user);
  const [existingRows] = await connection.query(
    `
      SELECT
        id,
        employee_uid,
        employee_id,
        employee_number,
        employee_name,
        task_order,
        assigned_sub_account,
        herodash,
        msd,
        updated_at
      FROM ${EMPLOYEES_TABLE}
      WHERE COALESCE(NULLIF(TRIM(employee_id), ''), NULLIF(TRIM(employee_number), '')) IS NOT NULL
    `,
  );

  return buildKronosAssignmentRows(kronosRows, existingRows);
}

async function mergeDuplicateEmployeeRows(
  connection,
  canonicalSibsId,
  rows,
) {
  const survivor = selectPreferredExistingEmployee(rows);
  if (!survivor) return null;

  const mergedTaskOrder = cleanText(
    rows.find((row) => cleanText(row.task_order || row.assigned_sub_account))
      ?.task_order ||
      rows.find((row) => cleanText(row.assigned_sub_account))
        ?.assigned_sub_account,
  );
  const mergedHeroDash = cleanText(
    rows.find((row) => cleanText(row.herodash))?.herodash,
  );
  const mergedMsd = cleanText(rows.find((row) => cleanText(row.msd))?.msd);

  await connection.query(
    `
      UPDATE ${EMPLOYEES_TABLE}
      SET
        employee_id = ?,
        employee_number = ?,
        task_order = ?,
        assigned_sub_account = ?,
        herodash = ?,
        msd = ?,
        account_name = 'US Visa',
        status = 'Active',
        employment_status = 'Active',
        updated_at = NOW()
      WHERE id = ?
      LIMIT 1
    `,
    [
      canonicalSibsId,
      canonicalSibsId,
      mergedTaskOrder || null,
      mergedTaskOrder || null,
      mergedHeroDash || null,
      mergedMsd || null,
      survivor.id,
    ],
  );

  for (const duplicate of rows) {
    if (duplicate.id === survivor.id) continue;

    await connection.query(
      `
        INSERT IGNORE INTO ${ALIASES_TABLE} (
          employee_uid,
          source_system,
          source_agent_name,
          source_agent_key,
          is_active,
          created_at,
          updated_at
        )
        SELECT
          ?,
          source_system,
          source_agent_name,
          source_agent_key,
          is_active,
          created_at,
          NOW()
        FROM ${ALIASES_TABLE}
        WHERE employee_uid = ?
      `,
      [survivor.employee_uid, duplicate.employee_uid],
    );

    await connection.query(
      `DELETE FROM ${ALIASES_TABLE} WHERE employee_uid = ?`,
      [duplicate.employee_uid],
    );

    await connection.query(
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
          actual_efficiency_pct,
          created_at,
          updated_at
        )
        SELECT
          batch_id,
          production_date,
          ?,
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
          created_at,
          NOW()
        FROM us_visa_kpi_hourly_summary
        WHERE agent_key = ?
        ON DUPLICATE KEY UPDATE
          batch_id = VALUES(batch_id),
          agent_name = VALUES(agent_name),
          expected_seconds = VALUES(expected_seconds),
          actual_logged_seconds = VALUES(actual_logged_seconds),
          handled_calls = VALUES(handled_calls),
          avg_talk_seconds = VALUES(avg_talk_seconds),
          avg_hold_seconds = VALUES(avg_hold_seconds),
          available_seconds = VALUES(available_seconds),
          phone_occupancy_pct = VALUES(phone_occupancy_pct),
          email_capacity = VALUES(email_capacity),
          target_emails = VALUES(target_emails),
          actual_emails = VALUES(actual_emails),
          email_utilization_pct = VALUES(email_utilization_pct),
          actual_efficiency_pct = VALUES(actual_efficiency_pct),
          updated_at = NOW()
      `,
      [survivor.employee_uid, duplicate.employee_uid],
    );

    await connection.query(
      `DELETE FROM us_visa_kpi_hourly_summary WHERE agent_key = ?`,
      [duplicate.employee_uid],
    );

    await connection.query(
      `
        UPDATE ${EMPLOYEES_TABLE}
        SET
          employee_id = NULL,
          employee_number = NULL,
          account_name = 'US Visa Duplicate',
          status = 'Inactive',
          employment_status = 'Inactive',
          include_dashboard = 0,
          include_reports = 0,
          kpi_tracking_enabled = 0,
          updated_at = NOW()
        WHERE id = ?
        LIMIT 1
      `,
      [duplicate.id],
    );
  }

  return {
    ...survivor,
    employee_id: canonicalSibsId,
    employee_number: canonicalSibsId,
    task_order: mergedTaskOrder,
    assigned_sub_account: mergedTaskOrder,
    herodash: mergedHeroDash,
    msd: mergedMsd,
  };
}

export async function syncKronosEmployeeAssignments(user) {
  const fetchedRows = await fetchAllKronosEmployees(user);
  const kronosEmployees = deduplicateKronosEmployees(fetchedRows);

  if (!kronosEmployees.length) {
    throw new Error(
      "Kronos returned no active US Visa employees. Synchronization was stopped to protect the existing roster.",
    );
  }

  const currentKronosKeys = new Set(
    kronosEmployees.map((employee) => getSibsComparisonKey(employee.sibsId)),
  );
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [existingRows] = await connection.query(
      `
        SELECT
          id,
          employee_uid,
          employee_id,
          employee_number,
          employee_name,
          task_order,
          assigned_sub_account,
          herodash,
          msd
        FROM ${EMPLOYEES_TABLE}
        WHERE COALESCE(NULLIF(TRIM(employee_id), ''), NULLIF(TRIM(employee_number), '')) IS NOT NULL
          AND LOWER(TRIM(account_name)) LIKE 'us visa%'
      `,
    );

    const existingGroups = groupExistingEmployeesBySibsId(existingRows);

    const existingBySibsId = new Map();
    let mergedDuplicates = 0;

    for (const [key, rows] of existingGroups.entries()) {
      const canonicalSibsId = normalizeSibsId(key);
      const existing =
        rows.length > 1
          ? await mergeDuplicateEmployeeRows(
              connection,
              canonicalSibsId,
              rows,
            )
          : rows[0];

      if (rows.length > 1) mergedDuplicates += rows.length - 1;
      if (existing) existingBySibsId.set(key, existing);
    }

    let added = 0;
    let updated = 0;

    for (const employee of kronosEmployees) {
      const existing =
        existingBySibsId.get(getSibsComparisonKey(employee.sibsId)) || null;
      const merged = mergeKronosEmployeeWithExisting(employee, existing);

      if (existing?.id) {
        await connection.query(
          `
            UPDATE ${EMPLOYEES_TABLE}
            SET
              employee_id = ?,
              employee_number = ?,
              employee_name = ?,
              account_name = 'US Visa',
              status = 'Active',
              employment_status = 'Active',
              last_synced_at = NOW(),
              updated_at = NOW()
            WHERE id = ?
            LIMIT 1
          `,
          [merged.sibsId, merged.sibsId, merged.agentName, existing.id],
        );
        updated += 1;
      } else {
        await connection.query(
          `
            INSERT INTO ${EMPLOYEES_TABLE} (
              employee_uid,
              employee_id,
              employee_number,
              employee_name,
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
              last_synced_at,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, 'US Visa', 'Active', 'Active', ?, ?, ?, ?, 1, 1, 1, NOW(), NOW(), NOW())
          `,
          [
            merged.employeeUid,
            merged.sibsId,
            merged.sibsId,
            merged.agentName,
            merged.taskOrder || null,
            merged.taskOrder || null,
            merged.heroDash || null,
            merged.msd || null,
          ],
        );
        added += 1;
      }
    }

    let deactivated = 0;

    for (const [key, existing] of existingBySibsId.entries()) {
      if (currentKronosKeys.has(key) || !existing?.id) continue;

      await connection.query(
        `
          UPDATE ${EMPLOYEES_TABLE}
          SET
            status = 'Inactive',
            employment_status = 'Inactive',
            include_dashboard = 0,
            include_reports = 0,
            kpi_tracking_enabled = 0,
            updated_at = NOW()
          WHERE id = ?
          LIMIT 1
        `,
        [existing.id],
      );
      deactivated += 1;
    }

    await connection.commit();

    return {
      employees: await listEmployeeAssignments(user),
      summary: {
        fetched: fetchedRows.length,
        eligible: kronosEmployees.length,
        added,
        updated,
        deactivated,
        mergedDuplicates,
      },
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function buildAliasKey(sourceSystem, sourceValue) {
  const normalized = normalizeComparable(sourceValue).replace(/\s+/g, "_");
  return `${sourceSystem}:${normalized}`.slice(0, 255);
}

async function replaceAdminAlias(
  connection,
  employeeUid,
  sourceSystem,
  sourceValue,
) {
  await connection.query(
    `
      DELETE FROM ${ALIASES_TABLE}
      WHERE employee_uid = ?
        AND source_system = ?
    `,
    [employeeUid, sourceSystem],
  );

  if (!sourceValue) return;

  await connection.query(
    `
      INSERT INTO ${ALIASES_TABLE} (
        employee_uid,
        source_system,
        source_agent_name,
        source_agent_key,
        is_active,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 1, NOW(), NOW())
    `,
    [
      employeeUid,
      sourceSystem,
      sourceValue,
      buildAliasKey(sourceSystem, sourceValue),
    ],
  );
}

export async function saveEmployeeAssignments(assignments = [], user) {
  if (!Array.isArray(assignments)) {
    throw new TypeError("Assignments must be an array.");
  }

  if (assignments.length > MAX_ASSIGNMENTS_PER_REQUEST) {
    throw new Error(
      `A maximum of ${MAX_ASSIGNMENTS_PER_REQUEST} employee assignments can be saved at once.`,
    );
  }

  const normalizedAssignments = assignments
    .map(normalizeAssignmentInput)
    .filter((assignment) => assignment.sibsId);

  const uniqueAssignments = [
    ...new Map(
      normalizedAssignments.map((assignment) => [
        assignment.sibsId.toUpperCase(),
        assignment,
      ]),
    ).values(),
  ];

  if (!uniqueAssignments.length) {
    return {
      employees: await listEmployeeAssignments(user),
      updated: 0,
    };
  }

  const kronosRows = await fetchAllKronosEmployees(user);
  const currentKronosEmployees = deduplicateKronosEmployees(kronosRows);
  const kronosBySibsId = new Map(
    currentKronosEmployees.map((employee) => [
      getSibsComparisonKey(employee.sibsId),
      employee,
    ]),
  );

  for (const assignment of uniqueAssignments) {
    if (!kronosBySibsId.has(getSibsComparisonKey(assignment.sibsId))) {
      throw new Error(
        `Employee ${assignment.sibsId} is not part of the current active US Visa Kronos roster.`,
      );
    }
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [employeeRows] = await connection.query(
      `
        SELECT
          id,
          employee_uid,
          employee_id,
          employee_number,
          employee_name,
          task_order,
          assigned_sub_account,
          herodash,
          msd,
          updated_at
        FROM ${EMPLOYEES_TABLE}
        WHERE COALESCE(NULLIF(TRIM(employee_id), ''), NULLIF(TRIM(employee_number), '')) IS NOT NULL
      `,
    );

    const employeeGroups = groupExistingEmployeesBySibsId(employeeRows);
    const employeeBySibsId = new Map(
      [...employeeGroups.entries()].map(([key, rows]) => [
        key,
        selectPreferredExistingEmployee(rows),
      ]),
    );

    let updated = 0;

    for (const assignment of uniqueAssignments) {
      const key = getSibsComparisonKey(assignment.sibsId);
      const kronosEmployee = kronosBySibsId.get(key);
      let employee = employeeBySibsId.get(key) || null;

      if (!employee) {
        const employeeUid = buildEmployeeUid(kronosEmployee.sibsId);
        const [insertResult] = await connection.query(
          `
            INSERT INTO ${EMPLOYEES_TABLE} (
              employee_uid,
              employee_id,
              employee_number,
              employee_name,
              account_name,
              status,
              employment_status,
              include_dashboard,
              include_reports,
              kpi_tracking_enabled,
              last_synced_at,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, 'US Visa', 'Active', 'Active', 1, 1, 1, NOW(), NOW(), NOW())
          `,
          [
            employeeUid,
            kronosEmployee.sibsId,
            kronosEmployee.sibsId,
            kronosEmployee.agentName,
          ],
        );

        employee = {
          id: insertResult.insertId,
          employee_uid: employeeUid,
          employee_id: kronosEmployee.sibsId,
          employee_number: kronosEmployee.sibsId,
        };
        employeeBySibsId.set(key, employee);
      }

      await connection.query(
        `
          UPDATE ${EMPLOYEES_TABLE}
          SET
            employee_id = ?,
            employee_number = ?,
            employee_name = ?,
            account_name = 'US Visa',
            status = 'Active',
            employment_status = 'Active',
            task_order = ?,
            assigned_sub_account = ?,
            herodash = ?,
            msd = ?,
            include_dashboard = 1,
            include_reports = 1,
            kpi_tracking_enabled = 1,
            last_synced_at = NOW(),
            task_order_assigned_at = CASE
              WHEN ? <> '' THEN COALESCE(task_order_assigned_at, NOW())
              ELSE NULL
            END,
            sub_account_assigned_at = CASE
              WHEN ? <> '' THEN COALESCE(sub_account_assigned_at, NOW())
              ELSE NULL
            END,
            updated_at = NOW()
          WHERE id = ?
          LIMIT 1
        `,
        [
          kronosEmployee.sibsId,
          kronosEmployee.sibsId,
          kronosEmployee.agentName,
          assignment.taskOrder || null,
          assignment.taskOrder || null,
          assignment.heroDash || null,
          assignment.msd || null,
          assignment.taskOrder,
          assignment.taskOrder,
          employee.id,
        ],
      );

      await replaceAdminAlias(
        connection,
        employee.employee_uid,
        "herodash_admin",
        assignment.heroDash,
      );

      await replaceAdminAlias(
        connection,
        employee.employee_uid,
        "msd_admin",
        assignment.msd,
      );

      updated += 1;
    }

    await connection.commit();

    return {
      employees: await listEmployeeAssignments(user),
      updated,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

