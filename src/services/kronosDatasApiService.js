import axios from "axios";

const DEFAULT_LIMIT = Number(process.env.KRONOS_DATAS_PAGE_LIMIT || 25);
const MAX_LIMIT = 100;

const KRONOS_DATAS_API_URL = (
  process.env.KRONOS_DATAS_API_URL ||
  "https://krns.mysibs.info/service/employeelist"
).trim();

const KRONOS_DATAS_API_KEY = (process.env.KRONOS_DATAS_API_KEY || "").trim();

const KRONOS_DATAS_AUTH_MODE = (process.env.KRONOS_DATAS_AUTH_MODE || "bearer")
  .trim()
  .toLowerCase();

const KRONOS_DATAS_API_METHOD = (
  process.env.KRONOS_DATAS_API_METHOD || "get"
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

function canUseKronosDataFilters(user) {
  const roles = [
    user?.role,
    user?.tokenType,
    user?.userRole,
    user?.accountType,
    user?.user_type,
    user?.gy_user_type,
  ].map(normalizeRole);

  const access = getAccessValue(user);

  return (
    access === 1 ||
    roles.some((role) =>
      [
        "hr_admin",
        "hradmin",
        "super_admin",
        "superadmin",
        "super_administrator",
      ].includes(role),
    )
  );
}

function toPositiveInteger(value, fallback) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue) || numberValue < 1) {
    return fallback;
  }

  return Math.floor(numberValue);
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

/* =========================================
   FORMATTERS
========================================= */

function formatFullName(row) {
  const directName = pickValue(row, [
    "fullName",
    "full_name",
    "employeeName",
    "employee_name",
    "name",
    "empName",
    "emp_name",
    "gy_full_name",
  ]);

  if (directName) return cleanString(directName);

  const firstName = pickValue(row, [
    "firstName",
    "first_name",
    "fname",
    "gy_emp_fname",
  ]);

  const middleName = pickValue(row, [
    "middleName",
    "middle_name",
    "mname",
    "gy_emp_mname",
  ]);

  const lastName = pickValue(row, [
    "lastName",
    "last_name",
    "lname",
    "gy_emp_lname",
  ]);

  return [firstName, middleName, lastName]
    .map(cleanString)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function getHireDateValue(row) {
  return pickValue(row, [
    "dateHired",
    "date_hired",
    "hireDate",
    "hire_date",
    "gy_emp_hiredate",
  ]);
}

function parseHireDateForSort(value) {
  const raw = cleanString(value);

  if (!raw || raw === "0000-00-00") {
    return 0;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }

  return parsed.getTime();
}

function sortByLatestHireDate(rows = []) {
  return [...rows].sort((a, b) => {
    const dateA = parseHireDateForSort(a?.hireDate || getHireDateValue(a));
    const dateB = parseHireDateForSort(b?.hireDate || getHireDateValue(b));

    if (dateB !== dateA) {
      return dateB - dateA;
    }

    const sibsA = cleanString(a?.sibsId || a?.sibs_id || a?.gy_emp_code);
    const sibsB = cleanString(b?.sibsId || b?.sibs_id || b?.gy_emp_code);

    return sibsB.localeCompare(sibsA, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/* =========================================
   API AUTH HEADERS
========================================= */

function buildHeaders() {
  if (!KRONOS_DATAS_API_KEY) {
    throw new Error("KRONOS_DATAS_API_KEY is missing in .env.");
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Expires: "0",
  };

  if (KRONOS_DATAS_AUTH_MODE === "bearer") {
    headers.Authorization = `Bearer ${KRONOS_DATAS_API_KEY}`;
  } else if (KRONOS_DATAS_AUTH_MODE === "authorization") {
    headers.Authorization = KRONOS_DATAS_API_KEY;
  } else if (KRONOS_DATAS_AUTH_MODE === "x-api-key") {
    headers["x-api-key"] = KRONOS_DATAS_API_KEY;
  } else if (KRONOS_DATAS_AUTH_MODE === "api-key-header") {
    headers["api-key"] = KRONOS_DATAS_API_KEY;
  } else if (KRONOS_DATAS_AUTH_MODE === "apikey-header") {
    headers.apikey = KRONOS_DATAS_API_KEY;
  } else {
    headers.Authorization = `Bearer ${KRONOS_DATAS_API_KEY}`;
  }

  return headers;
}

/* =========================================
   NORMALIZER
========================================= */

function normalizeEmployee(row, index = 0) {
  const sibsId = pickValue(row, [
    "sibsId",
    "sibs_id",
    "employeeId",
    "employee_id",
    "employeeCode",
    "employee_code",
    "empCode",
    "emp_code",
    "empId",
    "emp_id",
    "gy_emp_code",
    "gy_user_code",
    "userid",
    "userId",
    "user_id",
    "id",
  ]);

  const firstName = pickValue(row, [
    "firstName",
    "first_name",
    "fname",
    "gy_emp_fname",
  ]);

  const middleName = pickValue(row, [
    "middleName",
    "middle_name",
    "mname",
    "gy_emp_mname",
  ]);

  const lastName = pickValue(row, [
    "lastName",
    "last_name",
    "lname",
    "gy_emp_lname",
  ]);

  const assignedLocation = pickValue(row, [
    "assignedLoc",
    "assigned_loc",
    "assignedLocation",
    "assigned_location",
    "gy_assignedloc",
    "siteId",
    "site_id",
    "site",
    "location",
    "workSite",
    "work_site",
  ]);

  const site = pickValue(row, [
    "site",
    "location",
    "workSite",
    "work_site",
    "assignedLoc",
    "assigned_loc",
  ]);

  const account = pickValue(row, [
    "account",
    "accountName",
    "account_name",
    "client",
    "clientName",
    "client_name",
    "gy_acc_name",
    "gy_emp_account",
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

  return {
    ...row,

    _rowNumber: row?._rowNumber || index + 1,

    sibsId: cleanString(sibsId),
    firstName: cleanString(firstName),
    middleName: cleanString(middleName),
    lastName: cleanString(lastName),
    fullName: formatFullName(row),

    email: cleanString(
      pickValue(row, [
        "workEmail",
        "work_email",
        "companyEmail",
        "company_email",
        "officialEmail",
        "official_email",

        "email",
        "Email",
        "EMAIL",

        "personalEmail",
        "personal_email",

        "emailAddress",
        "email_address",
        "EmailAddress",

        "employeeEmail",
        "employee_email",
        "empEmail",
        "emp_email",

        "gy_emp_email",
        "gy_email",
        "gy_user_email",
        "gy_user_emailadd",
        "gy_emp_emailadd",

        "user_email",
        "username",
        "userEmail",
      ]),
    ),

    personalEmail: cleanString(
      pickValue(row, ["personalEmail", "personal_email"]),
    ),

    workEmail: cleanString(
      pickValue(row, [
        "workEmail",
        "work_email",
        "companyEmail",
        "company_email",
        "officialEmail",
        "official_email",
      ]),
    ),

    gender: cleanString(pickValue(row, ["gender", "gy_gender"])),

    birthdate: pickValue(row, [
      "birthdate",
      "birthDate",
      "dob",
      "gy_dob",
    ]),

    civilStatus: cleanString(
      pickValue(row, [
        "civilStatus",
        "civil_status",
        "gy_civilstatus",
      ]),
    ),

    contact: cleanString(
      pickValue(row, [
        "contactNumber",
        "contact_number",
        "contact",
        "phone",
        "mobile",
        "mobileNumber",
        "mobile_number",
        "gy_contact_num",
      ]),
    ),

    contactNumber: cleanString(
      pickValue(row, [
        "contactNumber",
        "contact_number",
        "contact",
        "phone",
        "mobile",
        "mobileNumber",
        "mobile_number",
        "gy_contact_num",
      ]),
    ),

    hireDate: getHireDateValue(row),

    dateHired: getHireDateValue(row),

    nhodate: pickValue(row, [
      "nho",
      "nhodate",
      "nhoDate",
      "nho_date",
      "gy_nhodate",
    ]),

    nho: pickValue(row, [
      "nho",
      "nhodate",
      "nhoDate",
      "nho_date",
      "gy_nhodate",
    ]),

    account: cleanString(account),

    accountId: cleanString(
      pickValue(row, [
        "accountId",
        "account_id",
        "gy_acc_id",
        "accountID",
      ]),
    ),

    department: cleanString(department),

    departmentId: cleanString(
      pickValue(row, [
        "departmentId",
        "department_id",
        "gy_dept_id",
        "id_department",
      ]),
    ),

    gy_assignedloc: cleanString(assignedLocation),
    assignedLoc: cleanString(assignedLocation),
    site: cleanString(site) || mapAssignedLocation(assignedLocation),
    location: cleanString(site) || mapAssignedLocation(assignedLocation),

    status: cleanString(pickValue(row, ["status", "employeeStatus"])),

    accountManager: cleanString(
      pickValue(row, ["accountManager", "account_manager", "managerName"]),
    ),

    accountManagerSibsId: cleanString(
      pickValue(row, [
        "accountManagerSibsId",
        "account_manager_sibs_id",
        "managerSibsId",
      ]),
    ),

    supervisor: cleanString(pickValue(row, ["supervisor", "manager"])),

    regularEmp: pickValue(row, ["regularEmp", "regular_emp"]),
    probationaryEmp: pickValue(row, ["probationaryEmp", "probationary_emp"]),

    sss: cleanString(pickValue(row, ["sss", "SSS"])),
    phic: cleanString(pickValue(row, ["phic", "PHIC", "philhealth"])),
    hdmf: cleanString(pickValue(row, ["hdmf", "HDMF", "pagibig"])),
    tin: cleanString(pickValue(row, ["tin", "TIN"])),

    raw: row,
  };
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
    "Employees",
    "employees",
    "Employee",
    "employee",

    "data",
    "Data",
    "datas",
    "Datas",

    "records",
    "Records",
    "rows",
    "Rows",
    "items",
    "Items",
    "results",
    "Results",
    "result",
    "Result",
    "list",
    "List",
    "payload",
    "Payload",
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
   LOCAL FILTER HELPERS
========================================= */

function searchRows(rows = [], search = "") {
  const keyword = cleanString(search).toLowerCase();

  if (!keyword) return rows;

  return rows.filter((row) =>
    JSON.stringify(row).toLowerCase().includes(keyword),
  );
}

function filterRows(rows = [], { department = "All", account = "All" } = {}) {
  const cleanDepartment = cleanString(department).toLowerCase();
  const cleanAccount = cleanString(account).toLowerCase();

  return rows.filter((row) => {
    const departmentMatches =
      !cleanDepartment ||
      cleanDepartment === "all" ||
      cleanString(row.departmentId).toLowerCase() === cleanDepartment ||
      cleanString(row.department).toLowerCase() === cleanDepartment;

    const accountMatches =
      !cleanAccount ||
      cleanAccount === "all" ||
      cleanString(row.account).toLowerCase() === cleanAccount ||
      cleanString(row.accountId).toLowerCase() === cleanAccount;

    return departmentMatches && accountMatches;
  });
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
    },
  };
}

function buildDepartmentOptions(rows = []) {
  const map = new Map();

  rows.forEach((row) => {
    const label = cleanString(row.department);
    const value = cleanString(row.department || row.departmentId);

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
  const filteredRows = filterRows(rows, {
    department,
    account: "All",
  });

  const set = new Set();

  filteredRows.forEach((row) => {
    const account = cleanString(row.account);

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
    department: query.department || "All",
    account: query.account || "All",
    includeDepartments: query.includeDepartments || 0,
    includeAccounts: query.includeAccounts || 0,
    limit,

    sortBy: "dateHired",
    sortOrder: "desc",
    orderBy: "dateHired",
    order: "desc",

    _fresh: 1,
    _ts: Date.now(),
  };
}

async function fetchKronosDatasFromEmployeeEndpoint(query = {}) {
  const params = buildApiParams(query);
  const headers = buildHeaders();

  if (KRONOS_DATAS_API_METHOD === "post") {
    const response = await axios.post(KRONOS_DATAS_API_URL, params, {
      headers,
      timeout: 30000,
    });

    return response.data;
  }

  const response = await axios.get(KRONOS_DATAS_API_URL, {
    headers,
    params,
    timeout: 30000,
  });

  return response.data;
}

/* =========================================
   MAIN SERVICE
========================================= */

export async function getKronosDatasFromApi(query = {}, user = null) {
  const rawData = await fetchKronosDatasFromEmployeeEndpoint(query);

  const canFilterEmployees = canUseKronosDataFilters(user);

  const found = Array.isArray(rawData?.data)
    ? {
        rows: rawData.data.map(normalizeArrayItem),
        path: "root.data",
      }
    : findFirstArray(rawData);

  const normalizedRows = sortByLatestHireDate(
    found.rows.map(normalizeEmployee),
  );

  const searchedRows = searchRows(normalizedRows, query.search);

  const filteredRows = canFilterEmployees
    ? filterRows(searchedRows, {
        department: query.department || "All",
        account: query.account || "All",
      })
    : searchedRows;

  const paginated = paginateRows(filteredRows, query);

  const includeDepartments = String(query.includeDepartments || "") === "1";
  const includeAccounts = String(query.includeAccounts || "") === "1";

  return {
    success: rawData?.success ?? true,
    data: paginated.data,
    departmentOptions:
      canFilterEmployees && includeDepartments
        ? Array.isArray(rawData?.departmentOptions)
          ? rawData.departmentOptions
          : buildDepartmentOptions(normalizedRows)
        : [],
    accountOptions:
      canFilterEmployees && includeAccounts
        ? Array.isArray(rawData?.accountOptions)
          ? rawData.accountOptions
          : buildAccountOptions(normalizedRows, query.department || "All")
        : [],
    selectedDepartment: canFilterEmployees ? query.department || "All" : "All",
    selectedAccount: canFilterEmployees ? query.account || "All" : "All",
    access: {
      canFilterEmployees,
      role: user?.role || "",
      tokenType: user?.tokenType || "",
      adminAccess: getAccessValue(user),
    },
    recordsPath: found.path,
    raw: rawData,
    rawSample: found.rows?.[0] || null,
    source: "kronos-production-employeelist-api",
    pagination: paginated.pagination,
    message: rawData?.message || "",
  };
}

export async function getKronosDataByIdFromApi(sibsId) {
  const cleanSibsId = cleanString(sibsId);

  if (!cleanSibsId) {
    throw new Error("SIBS ID is required.");
  }

  const rawData = await fetchKronosDatasFromEmployeeEndpoint({
    page: 1,
    search: cleanSibsId,
    department: "All",
    account: "All",
    includeDepartments: 0,
    includeAccounts: 0,
    limit: MAX_LIMIT,
  });

  const found = Array.isArray(rawData?.data)
    ? {
        rows: rawData.data.map(normalizeArrayItem),
        path: "root.data",
      }
    : findFirstArray(rawData);

  const normalizedRows = found.rows.map(normalizeEmployee);

  const employee = normalizedRows.find((row) => {
    const possibleIds = [
      row.sibsId,
      row.raw?.sibsId,
      row.raw?.sibs_id,
      row.raw?.gy_emp_code,
      row.raw?.gy_user_code,
      row.raw?.employee_id,
      row.raw?.employeeId,
      row.raw?.emp_id,
      row.raw?.empId,
      row.raw?.empCode,
      row.raw?.id,
    ]
      .map(cleanString)
      .filter(Boolean);

    return possibleIds.includes(cleanSibsId);
  });

  return {
    success: true,
    data: employee || null,
    message: employee ? "" : "Kronos data not found.",
    source: "kronos-production-employeelist-api",
  };
}