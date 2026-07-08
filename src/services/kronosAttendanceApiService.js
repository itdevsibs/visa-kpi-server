import axios from "axios";

const DEFAULT_LIMIT = Number(
  process.env.KRONOS_ATTENDANCE_PAGE_LIMIT ||
    process.env.KRONOS_DATAS_PAGE_LIMIT ||
    15,
);

const MAX_LIMIT = 100;

const KRONOS_ATTENDANCE_API_URL = (
  process.env.KRONOS_ATTENDANCE_API_URL ||
  process.env.KRONOS_DATAS_API_URL ||
  "https://krns.mysibs.info/service/publisheddtrs"
).trim();

const KRONOS_ATTENDANCE_API_KEY = (
  process.env.KRONOS_ATTENDANCE_API_KEY ||
  process.env.KRONOS_DATAS_API_KEY ||
  ""
).trim();

const KRONOS_ATTENDANCE_AUTH_MODE = (
  process.env.KRONOS_ATTENDANCE_AUTH_MODE ||
  process.env.KRONOS_DATAS_AUTH_MODE ||
  "bearer"
)
  .trim()
  .toLowerCase();

const KRONOS_ATTENDANCE_API_METHOD = (
  process.env.KRONOS_ATTENDANCE_API_METHOD ||
  process.env.KRONOS_DATAS_API_METHOD ||
  "get"
)
  .trim()
  .toLowerCase();

/* =========================================
   BASIC HELPERS
========================================= */

function cleanString(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeRole(value) {
  return cleanString(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function getAccessValue(user) {
  return Number(
    user?.admin_access ??
      user?.adminAccess ??
      user?.access ??
      user?.gy_user_access ??
      user?.gyUserAccess ??
      0,
  );
}

function getLoggedInSibsId(user) {
  return cleanString(
    user?.username ||
      user?.sibs_id ||
      user?.sibsId ||
      user?.gy_user_code ||
      user?.employeeCode ||
      user?.code ||
      "",
  );
}

function isHrAdminUser(user) {
  const roles = [
    user?.tokenType,
    user?.role,
    user?.userRole,
    user?.accountType,
    user?.user_type,
    user?.gy_user_type,
  ].map(normalizeRole);

  return roles.includes("hr_admin") || roles.includes("hradmin");
}

function isSuperAdminUser(user) {
  const roles = [
    user?.tokenType,
    user?.role,
    user?.userRole,
    user?.accountType,
    user?.user_type,
    user?.gy_user_type,
  ].map(normalizeRole);

  return roles.some((role) =>
    ["super_admin", "superadmin", "super_administrator"].includes(role),
  );
}

function isAdminUser(user) {
  const roles = [
    user?.tokenType,
    user?.role,
    user?.userRole,
    user?.accountType,
  ].map(normalizeRole);

  return roles.some((role) =>
    ["admin", "administrator", "super_admin", "superadmin"].includes(role),
  );
}

function isTalentAcquisitionUser(user) {
  const roles = [
    user?.tokenType,
    user?.role,
    user?.userRole,
    user?.accountType,
    user?.user_type,
    user?.gy_user_type,
  ].map(normalizeRole);

  return roles.some((role) =>
    [
      "ta",
      "talent_acquisition",
      "talent_acquisition_admin",
      "ta_admin",
      "recruitment",
      "recruitment_admin",
      "recruiter",
      "sourcing",
      "sourcing_admin",
    ].includes(role),
  );
}

function isManagerUser(user) {
  const roles = [
    user?.tokenType,
    user?.role,
    user?.userRole,
    user?.accountType,
  ].map(normalizeRole);

  return (
    getAccessValue(user) === 5 ||
    roles.some((role) =>
      ["manager", "om", "operations_manager", "team_manager"].includes(role),
    )
  );
}

function canUseAttendanceFilters(user) {
  return (
    isAdminUser(user) ||
    isHrAdminUser(user) ||
    isSuperAdminUser(user) ||
    isTalentAcquisitionUser(user)
  );
}

function canViewMultipleAttendance(user) {
  return canUseAttendanceFilters(user) || isManagerUser(user);
}

function toPositiveInteger(value, fallback) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue) || numberValue < 1) {
    return fallback;
  }

  return Math.floor(numberValue);
}

function pickValue(row, keys = []) {
  if (!row || typeof row !== "object") return "";

  for (const key of keys) {
    const value = row?.[key];

    if (value !== undefined && value !== null && cleanString(value) !== "") {
      return value;
    }
  }

  const rowKeys = Object.keys(row);
  const normalizedMap = new Map();

  rowKeys.forEach((key) => {
    normalizedMap.set(normalizeKey(key), key);
  });

  for (const key of keys) {
    const realKey = normalizedMap.get(normalizeKey(key));

    if (!realKey) continue;

    const value = row?.[realKey];

    if (value !== undefined && value !== null && cleanString(value) !== "") {
      return value;
    }
  }

  return "";
}

function mapAssignedLocation(value) {
  const raw = cleanString(value);

  if (!raw) return "—";
  if (raw === "0") return "Tagum";
  if (raw === "1") return "Davao";
  if (raw === "2") return "Both Tagum and Davao";
  if (raw === "3") return "Hybrid";

  return raw;
}

/* =========================================
   API HEADERS
========================================= */

function buildHeaders() {
  if (!KRONOS_ATTENDANCE_API_KEY) {
    throw new Error(
      "KRONOS_ATTENDANCE_API_KEY or KRONOS_DATAS_API_KEY is missing in .env.",
    );
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Expires: "0",
  };

  if (KRONOS_ATTENDANCE_AUTH_MODE === "bearer") {
    headers.Authorization = `Bearer ${KRONOS_ATTENDANCE_API_KEY}`;
  } else if (KRONOS_ATTENDANCE_AUTH_MODE === "authorization") {
    headers.Authorization = KRONOS_ATTENDANCE_API_KEY;
  } else if (KRONOS_ATTENDANCE_AUTH_MODE === "x-api-key") {
    headers["x-api-key"] = KRONOS_ATTENDANCE_API_KEY;
  } else if (KRONOS_ATTENDANCE_AUTH_MODE === "api-key-header") {
    headers["api-key"] = KRONOS_ATTENDANCE_API_KEY;
  } else if (KRONOS_ATTENDANCE_AUTH_MODE === "apikey-header") {
    headers.apikey = KRONOS_ATTENDANCE_API_KEY;
  } else {
    headers.Authorization = `Bearer ${KRONOS_ATTENDANCE_API_KEY}`;
  }

  return headers;
}

/* =========================================
   DATE / TIME HELPERS
========================================= */

function parseDateMs(value) {
  const raw = cleanString(value);

  if (!raw || raw === "0000-00-00" || raw === "0000-00-00 00:00:00") {
    return 0;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }

  return parsed.getTime();
}

function dateOnlyMs(value) {
  const ms = parseDateMs(value);

  if (!ms) return 0;

  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);

  return date.getTime();
}

function getTrackerDateValue(row) {
  return pickValue(row, [
    "gy_tracker_date",
    "trackerDate",
    "tracker_date",
    "attendanceDate",
    "attendance_date",
    "dtrDate",
    "dtr_date",
    "publishedDate",
    "published_date",
    "workDate",
    "work_date",
    "shiftDate",
    "shift_date",
    "logDate",
    "log_date",
    "date",
  ]);
}

function getLoginDateValue(row) {
  return pickValue(row, [
    "gy_tracker_login",

    // production timelogs / published DTR fields
    "startWork",
    "start_work",
    "workStart",
    "work_start",

    "trackerLogin",
    "tracker_login",
    "login",
    "loginTime",
    "login_time",
    "timeIn",
    "time_in",
    "clockIn",
    "clock_in",
    "actualTimeIn",
    "actual_time_in",
    "firstIn",
    "first_in",
    "dtrTimeIn",
    "dtr_time_in",
    "dtr_timein",
    "timelogIn",
    "timelog_in",
  ]);
}

function getBreakOutValue(row) {
  return pickValue(row, [
    "gy_tracker_breakout",
    "startBreak",
    "start_break",
    "breakout",
    "breakOut",
    "break_out",
    "breakStart",
    "break_start",
  ]);
}

function getBreakInValue(row) {
  return pickValue(row, [
    "gy_tracker_breakin",
    "endBreak",
    "end_break",
    "breakin",
    "breakIn",
    "break_in",
    "breakEnd",
    "break_end",
  ]);
}

function getLogoutValue(row) {
  return pickValue(row, [
    "gy_tracker_logout",

    // production timelogs / published DTR fields
    "endWork",
    "end_work",
    "workEnd",
    "work_end",

    "trackerLogout",
    "tracker_logout",
    "logout",
    "logoutTime",
    "logout_time",
    "timeOut",
    "time_out",
    "timeout",
    "clockOut",
    "clock_out",
    "actualTimeOut",
    "actual_time_out",
    "lastOut",
    "last_out",
    "dtrTimeOut",
    "dtr_time_out",
    "dtr_timeout",
    "timelogOut",
    "timelog_out",
  ]);
}

function getRawLogTimeValue(row) {
  return pickValue(row, [
    "logTime",
    "log_time",
    "timeLog",
    "time_log",
    "timelog",
    "timestamp",
    "dateTime",
    "date_time",
    "datetime",
    "punchTime",
    "punch_time",
    "eventTime",
    "event_time",
    "scanTime",
    "scan_time",
    "time",
  ]);
}

function getRawLogTypeValue(row) {
  return pickValue(row, [
    "logType",
    "log_type",
    "timeLogType",
    "time_log_type",
    "punchType",
    "punch_type",
    "eventType",
    "event_type",
    "type",
    "mode",
    "direction",
    "state",
    "kind",
  ]);
}

function normalizeRawLogType(value) {
  const raw = cleanString(value).toLowerCase().replace(/[^a-z0-9]/g, "");

  if (
    [
      "in",
      "timein",
      "clockin",
      "login",
      "signin",
      "checkin",
      "start",
      "1",
    ].includes(raw)
  ) {
    return "login";
  }

  if (
    [
      "breakout",
      "breakstart",
      "startbreak",
      "lunchout",
      "outbreak",
      "2",
    ].includes(raw)
  ) {
    return "breakout";
  }

  if (
    [
      "breakin",
      "breakend",
      "endbreak",
      "lunchin",
      "inbreak",
      "3",
    ].includes(raw)
  ) {
    return "breakin";
  }

  if (
    [
      "out",
      "timeout",
      "clockout",
      "logout",
      "signout",
      "checkout",
      "end",
      "4",
    ].includes(raw)
  ) {
    return "logout";
  }

  return "";
}

function sortByLatestAttendanceDate(rows = []) {
  return [...rows].sort((a, b) => {
    const dateA =
      parseDateMs(a?.gy_tracker_date) || parseDateMs(getTrackerDateValue(a));
    const dateB =
      parseDateMs(b?.gy_tracker_date) || parseDateMs(getTrackerDateValue(b));

    if (dateB !== dateA) return dateB - dateA;

    const loginA =
      parseDateMs(a?.gy_tracker_login) || parseDateMs(getLoginDateValue(a));
    const loginB =
      parseDateMs(b?.gy_tracker_login) || parseDateMs(getLoginDateValue(b));

    if (loginB !== loginA) return loginB - loginA;

    return cleanString(b?.gy_tracker_id || b?.id).localeCompare(
      cleanString(a?.gy_tracker_id || a?.id),
      undefined,
      {
        numeric: true,
        sensitivity: "base",
      },
    );
  });
}

/* =========================================
   NORMALIZER
========================================= */

function normalizeTrackerStatus(value) {
  const raw = cleanString(value);

  if (raw === "0") return "Pending";
  if (raw === "1") return "Approved";
  if (raw === "2") return "Rejected";

  if (!raw) return "—";

  const normalized = raw.toLowerCase();

  if (normalized === "approved") return "Approved";
  if (normalized === "pending") return "Pending";
  if (normalized === "rejected" || normalized === "declined") return "Rejected";

  return raw;
}

function normalizeAttendanceRow(row, index = 0) {
  const gyEmpCode = pickValue(row, [
    "gy_emp_code",
    "sibsId",
    "sibs_id",
    "employeeCode",
    "employee_code",
    "empCode",
    "emp_code",
    "empId",
    "emp_id",
    "employeeId",
    "employee_id",
    "userId",
    "user_id",
    "idNumber",
    "id_number",
  ]);

  const lastName = pickValue(row, [
    "gy_emp_lname",
    "lastName",
    "last_name",
    "lname",
    "surname",
  ]);

  const firstName = pickValue(row, [
    "gy_emp_fname",
    "firstName",
    "first_name",
    "fname",
    "givenName",
    "given_name",
  ]);

  const middleName = pickValue(row, [
    "gy_emp_mname",
    "middleName",
    "middle_name",
    "mname",
  ]);

  const fullName = pickValue(row, [
    "gy_emp_fullname",
    "fullName",
    "full_name",
    "employeeName",
    "employee_name",
    "name",
  ]);

  const account = pickValue(row, [
    "gy_emp_account",
    "account",
    "accountName",
    "account_name",
    "client",
    "clientName",
    "client_name",
    "gy_acc_name",
    "gy_acc_ghl_name",
  ]);

  const department = pickValue(row, [
    "department",
    "departmentName",
    "department_name",
    "dept",
    "deptName",
    "dept_name",
    "name_department",
    "gy_department_name",
  ]);

  const siteValue = pickValue(row, [
    "site",
    "assignedSite",
    "assigned_site",
    "gy_assignedloc",
    "assignedLocation",
    "assigned_location",
    "location",
    "workSite",
    "work_site",
  ]);

  const rawLogTime = getRawLogTimeValue(row);
  const rawLogType = normalizeRawLogType(getRawLogTypeValue(row));

  return {
    ...row,

    _rowNumber: row?._rowNumber || index + 1,

    gy_emp_id: row?.gy_emp_id ?? row?.employeeId ?? row?.employee_id ?? "",
    gy_emp_code: cleanString(gyEmpCode),
    gy_emp_lname: cleanString(lastName),
    gy_emp_fname: cleanString(firstName),
    gy_emp_mname: cleanString(middleName),
    gy_emp_fullname: cleanString(fullName),

    gy_acc_id: row?.gy_acc_id ?? row?.accountId ?? row?.account_id ?? "",
    gy_emp_account: cleanString(account),

    departmentId:
      row?.departmentId ??
      row?.department_id ??
      row?.gy_dept_id ??
      row?.id_department ??
      "",
    department: cleanString(department),

    gy_assignedloc: cleanString(siteValue),
    site: mapAssignedLocation(siteValue),

    gy_tracker_id:
      row?.gy_tracker_id ?? row?.trackerId ?? row?.tracker_id ?? row?.id ?? "",

    gy_tracker_date: getTrackerDateValue(row),
    gy_tracker_login: getLoginDateValue(row),
    gy_tracker_breakout: getBreakOutValue(row),
    gy_tracker_breakin: getBreakInValue(row),
    gy_tracker_logout: getLogoutValue(row),

    gy_tracker_wh:
        row?.gy_tracker_wh ??
        pickValue(row, [
            "workHours",
            "work_hours",
            "workingHours",
            "working_hours",
            "regularHours",
            "regular_hours",
            "renderedHours",
            "rendered_hours",
            "totalHours",
            "total_hours",
            "hoursWorked",
            "hours_worked",
            "paidHours",
            "paid_hours",
            "wh",
            "WH",
        ]) ??
        "",

    gy_tracker_bh:
      row?.gy_tracker_bh ??
      pickValue(row, [
        "breakHours",
        "break_hours",
        "breakHour",
        "break_hour",
        "bh",
        "BH",
      ]) ??
      "",

    gy_tracker_ot:
      row?.gy_tracker_ot ??
      pickValue(row, [
        "overtime",
        "overtimeHours",
        "overtime_hours",
        "otHours",
        "ot_hours",
        "ot",
        "OT",
      ]) ??
      "",

    gy_tracker_ath:
      row?.gy_tracker_ath ??
      pickValue(row, [
        "approvedTotalHours",
        "approved_total_hours",
        "approvedHours",
        "approved_hours",
        "ath",
        "ATH",
      ]) ??
      "",

    gy_tracker_status: normalizeTrackerStatus(
      row?.gy_tracker_status ??
        pickValue(row, [
          "trackerStatus",
          "tracker_status",
          "attendanceStatus",
          "attendance_status",
          "dtrStatus",
          "dtr_status",
          "status",
        ]),
    ),

    gy_tracker_request:
      row?.gy_tracker_request ?? row?.trackerRequest ?? row?.request ?? "",

    gy_tracker_reason:
      row?.gy_tracker_reason ?? row?.trackerReason ?? row?.reason ?? "",

    schedule_start:
      row?.schedule_start ??
      row?.scheduleStart ??
      row?.gy_sched_login ??
      row?.shift_start ??
      "",

    schedule_end:
      row?.schedule_end ??
      row?.scheduleEnd ??
      row?.gy_sched_logout ??
      row?.shift_end ??
      "",

    login_status: row?.login_status ?? row?.loginStatus ?? "",
    breakin_status: row?.breakin_status ?? row?.breakinStatus ?? "",
    logout_status: row?.logout_status ?? row?.logoutStatus ?? "",

    _rawLogTime: rawLogTime,
    _rawLogType: rawLogType,

    raw: row,
  };
}

/* =========================================
   RAW TIMELOG PIVOT
========================================= */

function hasDirectAttendanceValues(row) {
  return Boolean(
    row.gy_tracker_login ||
      row.gy_tracker_breakout ||
      row.gy_tracker_breakin ||
      row.gy_tracker_logout ||
      row.gy_tracker_wh ||
      row.gy_tracker_bh ||
      row.gy_tracker_ot ||
      row.gy_tracker_ath,
  );
}

function buildDateKey(value) {
  const raw = cleanString(value);

  if (!raw) return "";

  const parsed = new Date(raw);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return raw.slice(0, 10);
}

function pivotRawTimelogs(rows = []) {
  const hasRawLogs = rows.some((row) => row._rawLogTime && row._rawLogType);
  const hasDirectValues = rows.some(hasDirectAttendanceValues);

  if (!hasRawLogs || hasDirectValues) {
    return rows;
  }

  const groupMap = new Map();

  rows.forEach((row) => {
    const employeeCode = cleanString(row.gy_emp_code);
    const dateKey = buildDateKey(row.gy_tracker_date || row._rawLogTime);

    if (!employeeCode || !dateKey) return;

    const key = `${employeeCode}__${dateKey}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        ...row,
        gy_tracker_date: dateKey,
        gy_tracker_login: "",
        gy_tracker_breakout: "",
        gy_tracker_breakin: "",
        gy_tracker_logout: "",
      });
    }

    const existing = groupMap.get(key);
    const timeValue = row._rawLogTime;

    if (row._rawLogType === "login") {
      if (
        !existing.gy_tracker_login ||
        parseDateMs(timeValue) < parseDateMs(existing.gy_tracker_login)
      ) {
        existing.gy_tracker_login = timeValue;
      }
    }

    if (row._rawLogType === "breakout") {
      existing.gy_tracker_breakout = timeValue;
    }

    if (row._rawLogType === "breakin") {
      existing.gy_tracker_breakin = timeValue;
    }

    if (row._rawLogType === "logout") {
      if (
        !existing.gy_tracker_logout ||
        parseDateMs(timeValue) > parseDateMs(existing.gy_tracker_logout)
      ) {
        existing.gy_tracker_logout = timeValue;
      }
    }
  });

  return [...groupMap.values()];
}

/* =========================================
   ARRAY FINDER
========================================= */

function normalizeArrayItem(item, index) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return {
      _rowNumber: index + 1,
      ...item,
    };
  }

  if (Array.isArray(item)) {
    return item.reduce(
      (acc, value, itemIndex) => {
        acc[`column_${itemIndex + 1}`] = value;
        return acc;
      },
      {
        _rowNumber: index + 1,
      },
    );
  }

  return {
    _rowNumber: index + 1,
    value: item,
  };
}

function findFirstArray(value, path = "root", depth = 0) {
  if (!value || depth > 8) {
    return {
      rows: [],
      path: "",
    };
  }

  if (Array.isArray(value)) {
    return {
      rows: value.map(normalizeArrayItem),
      path,
    };
  }

  if (typeof value !== "object") {
    return {
      rows: [],
      path: "",
    };
  }

  const priorityKeys = [
    "data",
    "attendance",
    "attendances",
    "dtrs",
    "dtr",
    "publisheddtrs",
    "publishedDtrs",
    "timelogs",
    "timeLogs",
    "tracker",
    "trackers",
    "records",
    "rows",
    "items",
    "results",
    "result",
    "list",
    "payload",
    "datas",
  ];

  for (const key of priorityKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = findFirstArray(value[key], `${path}.${key}`, depth + 1);

      if (found.rows.length > 0 || Array.isArray(value[key])) {
        return found;
      }
    }
  }

  for (const key of Object.keys(value)) {
    if (priorityKeys.includes(key)) continue;

    const found = findFirstArray(value[key], `${path}.${key}`, depth + 1);

    if (found.rows.length > 0) {
      return found;
    }
  }

  return {
    rows: [],
    path: "",
  };
}

/* =========================================
   LOCAL FILTERS
========================================= */

function searchRows(rows = [], search = "") {
  const keyword = cleanString(search).toLowerCase();

  if (!keyword) return rows;

  return rows.filter((row) =>
    JSON.stringify(row).toLowerCase().includes(keyword),
  );
}

function filterRows(rows = [], query = {}, user = null) {
  const search = cleanString(query.search);
  const dateFrom = cleanString(query.dateFrom);
  const dateTo = cleanString(query.dateTo);
  const department = cleanString(query.department || "All");
  const account = cleanString(query.account || "All");

  const canFilter = canUseAttendanceFilters(user);
  const canViewMultiple = canViewMultipleAttendance(user);
  const loggedInSibsId = getLoggedInSibsId(user);

  const fromMs = dateOnlyMs(dateFrom);
  const toMs = dateOnlyMs(dateTo);

  let nextRows = rows;

  if (!canViewMultiple && loggedInSibsId) {
    nextRows = nextRows.filter(
      (row) => cleanString(row.gy_emp_code) === loggedInSibsId,
    );
  }

  if (search) {
    nextRows = searchRows(nextRows, search);
  }

  if (fromMs) {
    nextRows = nextRows.filter(
      (row) => dateOnlyMs(row.gy_tracker_date) >= fromMs,
    );
  }

  if (toMs) {
    nextRows = nextRows.filter((row) => dateOnlyMs(row.gy_tracker_date) <= toMs);
  }

  if (canFilter && department && department !== "All") {
    const cleanDepartment = department.toLowerCase();

    nextRows = nextRows.filter(
      (row) =>
        cleanString(row.departmentId).toLowerCase() === cleanDepartment ||
        cleanString(row.department).toLowerCase() === cleanDepartment,
    );
  }

  if (canFilter && account && account !== "All") {
    const cleanAccount = account.toLowerCase();

    nextRows = nextRows.filter(
      (row) => cleanString(row.gy_emp_account).toLowerCase() === cleanAccount,
    );
  }

  return nextRows;
}

function paginateRows(rows = [], query = {}) {
  const page = toPositiveInteger(query.page, 1);
  const requestedLimit = toPositiveInteger(query.limit, DEFAULT_LIMIT);
  const limit = Math.min(requestedLimit, MAX_LIMIT);

  const total = rows.length;
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  const currentPage = Math.min(page, totalPages);

  const offset = (currentPage - 1) * limit;
  const endIndex = offset + limit;

  return {
    data: rows.slice(offset, endIndex),
    pagination: {
      currentPage,
      totalPages,
      total,
      limit,
      hasPreviousPage: currentPage > 1,
      hasNextPage: currentPage < totalPages,
    },
  };
}

function buildDepartmentOptions(rows = []) {
  const map = new Map();

  rows.forEach((row) => {
    const label = cleanString(row.department);
    const value = cleanString(row.departmentId || row.department);

    if (label && value && !map.has(value)) {
      map.set(value, {
        label,
        value,
      });
    }
  });

  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function buildAccountOptions(rows = [], department = "All") {
  const cleanDepartment = cleanString(department).toLowerCase();

  const set = new Set();

  rows.forEach((row) => {
    const departmentMatches =
      !cleanDepartment ||
      cleanDepartment === "all" ||
      cleanString(row.departmentId).toLowerCase() === cleanDepartment ||
      cleanString(row.department).toLowerCase() === cleanDepartment;

    if (!departmentMatches) return;

    const account = cleanString(row.gy_emp_account);

    if (account) {
      set.add(account);
    }
  });

  return [...set].sort((a, b) => a.localeCompare(b));
}

/* =========================================
   API CALL
========================================= */

function buildApiParams(query = {}) {
  const page = toPositiveInteger(query.page, 1);
  const requestedLimit = toPositiveInteger(query.limit, DEFAULT_LIMIT);
  const limit = Math.min(requestedLimit, MAX_LIMIT);

  return {
    page,
    search: query.search || "",
    dateFrom: query.dateFrom || "",
    dateTo: query.dateTo || "",
    department: query.department || "All",
    account: query.account || "All",
    includeDepartments: query.includeDepartments || 0,
    includeAccounts: query.includeAccounts || 0,
    limit,

    module: "attendance",
    dataType: "attendance",
    table: "tracker",

    sortBy: "gy_tracker_date",
    sortOrder: "desc",
    orderBy: "gy_tracker_date",
    order: "desc",

    _fresh: 1,
    _ts: Date.now(),
  };
}

async function fetchKronosAttendance(query = {}) {
  const params = buildApiParams(query);
  const headers = buildHeaders();

  if (KRONOS_ATTENDANCE_API_METHOD === "post") {
    const response = await axios.post(KRONOS_ATTENDANCE_API_URL, params, {
      headers,
      timeout: 30000,
    });

    return response.data;
  }

  const response = await axios.get(KRONOS_ATTENDANCE_API_URL, {
    headers,
    params,
    timeout: 30000,
  });

  return response.data;
}

/* =========================================
   MAIN SERVICE
========================================= */

export async function getKronosAttendanceFromApi(query = {}, user = null) {
  const rawData = await fetchKronosAttendance(query);

  const canFilterAttendance = canUseAttendanceFilters(user);

  const found = Array.isArray(rawData?.data)
    ? {
        rows: rawData.data.map(normalizeArrayItem),
        path: "root.data",
      }
    : findFirstArray(rawData);

  const normalizedRows = sortByLatestAttendanceDate(
    pivotRawTimelogs(found.rows.map(normalizeAttendanceRow)),
  );

  const filteredRows = filterRows(normalizedRows, query, user);
  const paginated = paginateRows(filteredRows, query);

  const includeDepartments = String(query.includeDepartments || "") === "1";
  const includeAccounts = String(query.includeAccounts || "") === "1";

  return {
    success: rawData?.success ?? true,
    data: paginated.data,
    departmentOptions:
      canFilterAttendance && includeDepartments
        ? Array.isArray(rawData?.departmentOptions)
          ? rawData.departmentOptions
          : buildDepartmentOptions(normalizedRows)
        : [],
    accountOptions:
      canFilterAttendance && includeAccounts
        ? Array.isArray(rawData?.accountOptions)
          ? rawData.accountOptions
          : buildAccountOptions(normalizedRows, query.department || "All")
        : [],
    selectedDateFrom: query.dateFrom || "",
    selectedDateTo: query.dateTo || "",
    selectedDepartment: canFilterAttendance ? query.department || "All" : "All",
    selectedAccount: canFilterAttendance ? query.account || "All" : "All",
    source: "kronos-attendance-production-api",
    recordsPath: found.path,
    rawSample: found.rows?.[0] || null,
    pagination: paginated.pagination,
    access: {
      isAdmin: isAdminUser(user),
      isManager: isManagerUser(user),
      isHrAdmin: isHrAdminUser(user),
      isSuperAdmin: isSuperAdminUser(user),
      isTalentAcquisition: isTalentAcquisitionUser(user),
      canFilterAttendance,
      sibsId: getLoggedInSibsId(user),
      tokenType: user?.tokenType || "employee",
      role: user?.role || "employee",
      adminAccess: getAccessValue(user),
    },
    message: rawData?.message || "",
  };
}