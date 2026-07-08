import axios from "axios";

const KRONOS_DATAS_API_URL = (
  process.env.KRONOS_DATAS_API_URL ||
  "https://krns.mysibs.info/service/datas"
).trim();

const KRONOS_DATAS_API_KEY = (process.env.KRONOS_DATAS_API_KEY || "").trim();

const KRONOS_DATAS_AUTH_MODE = (
  process.env.KRONOS_DATAS_AUTH_MODE || "authorization"
).trim();

function maskKey(value = "") {
  if (!value) return "";
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function buildKronosAuthConfig(queryParams = {}, mode = KRONOS_DATAS_AUTH_MODE) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const params = { ...queryParams };

  if (!KRONOS_DATAS_API_KEY) {
    throw new Error("KRONOS_DATAS_API_KEY is missing in .env.");
  }

  switch (mode) {
    case "authorization":
      headers.Authorization = KRONOS_DATAS_API_KEY;
      break;

    case "bearer":
      headers.Authorization = `Bearer ${KRONOS_DATAS_API_KEY}`;
      break;

    case "token":
      headers.Authorization = `Token ${KRONOS_DATAS_API_KEY}`;
      break;

    case "apikey-auth":
      headers.Authorization = `ApiKey ${KRONOS_DATAS_API_KEY}`;
      break;

    case "api-key-auth":
      headers.Authorization = `Api-Key ${KRONOS_DATAS_API_KEY}`;
      break;

    case "api_key-auth":
      headers.Authorization = `Api_Key ${KRONOS_DATAS_API_KEY}`;
      break;

    case "x-api-key":
      headers["x-api-key"] = KRONOS_DATAS_API_KEY;
      break;

    case "X-API-KEY":
      headers["X-API-KEY"] = KRONOS_DATAS_API_KEY;
      break;

    case "api-key-header":
      headers["api-key"] = KRONOS_DATAS_API_KEY;
      break;

    case "apikey-header":
      headers.apikey = KRONOS_DATAS_API_KEY;
      break;

    case "apiKey-header":
      headers.apiKey = KRONOS_DATAS_API_KEY;
      break;

    case "x-access-token":
      headers["x-access-token"] = KRONOS_DATAS_API_KEY;
      break;

    case "access-token":
      headers["access-token"] = KRONOS_DATAS_API_KEY;
      break;

    case "key-query":
      params.key = KRONOS_DATAS_API_KEY;
      break;

    case "api-key-query":
      params.api_key = KRONOS_DATAS_API_KEY;
      break;

    case "apikey-query":
      params.apikey = KRONOS_DATAS_API_KEY;
      break;

    case "apiKey-query":
      params.apiKey = KRONOS_DATAS_API_KEY;
      break;

    case "token-query":
      params.token = KRONOS_DATAS_API_KEY;
      break;

    case "access-token-query":
      params.access_token = KRONOS_DATAS_API_KEY;
      break;

    default:
      headers.Authorization = KRONOS_DATAS_API_KEY;
      break;
  }

  return { headers, params };
}

export async function getKronosDatas(query = {}) {
  if (!KRONOS_DATAS_API_URL) {
    throw new Error("KRONOS_DATAS_API_URL is missing in .env.");
  }

  const { headers, params } = buildKronosAuthConfig(query);

  console.log("[KRONOS DATAS] Request:", {
    url: KRONOS_DATAS_API_URL,
    authMode: KRONOS_DATAS_AUTH_MODE,
    apiKey: maskKey(KRONOS_DATAS_API_KEY),
    headerNames: Object.keys(headers),
  });

  const response = await axios.get(KRONOS_DATAS_API_URL, {
    headers,
    params,
    timeout: 30000,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  return response.data;
}

export async function postKronosDatas(payload = {}, query = {}) {
  if (!KRONOS_DATAS_API_URL) {
    throw new Error("KRONOS_DATAS_API_URL is missing in .env.");
  }

  const { headers, params } = buildKronosAuthConfig(query);

  const response = await axios.post(KRONOS_DATAS_API_URL, payload, {
    headers,
    params,
    timeout: 30000,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  return response.data;
}

export async function testKronosAuthModes(query = {}) {
  if (!KRONOS_DATAS_API_URL) {
    throw new Error("KRONOS_DATAS_API_URL is missing in .env.");
  }

  if (!KRONOS_DATAS_API_KEY) {
    throw new Error("KRONOS_DATAS_API_KEY is missing in .env.");
  }

  const modes = [
    "authorization",
    "bearer",
    "token",
    "apikey-auth",
    "api-key-auth",
    "api_key-auth",
    "x-api-key",
    "X-API-KEY",
    "api-key-header",
    "apikey-header",
    "apiKey-header",
    "x-access-token",
    "access-token",
    "key-query",
    "api-key-query",
    "apikey-query",
    "apiKey-query",
    "token-query",
    "access-token-query",
  ];

  const results = [];

  for (const mode of modes) {
    const { headers, params } = buildKronosAuthConfig(query, mode);

    try {
      const response = await axios.get(KRONOS_DATAS_API_URL, {
        headers,
        params,
        timeout: 15000,
        validateStatus: () => true,
      });

      results.push({
        method: "GET",
        mode,
        status: response.status,
        success: response.status >= 200 && response.status < 300,
        message:
          response?.data?.message ||
          response?.data?.error ||
          response.statusText ||
          "No message",
      });
    } catch (error) {
      results.push({
        method: "GET",
        mode,
        status: null,
        success: false,
        message: error?.message || "Request failed.",
      });
    }
  }

  for (const mode of modes) {
    const { headers, params } = buildKronosAuthConfig(query, mode);

    try {
      const response = await axios.post(
        KRONOS_DATAS_API_URL,
        {},
        {
          headers,
          params,
          timeout: 15000,
          validateStatus: () => true,
        },
      );

      results.push({
        method: "POST",
        mode,
        status: response.status,
        success: response.status >= 200 && response.status < 300,
        message:
          response?.data?.message ||
          response?.data?.error ||
          response.statusText ||
          "No message",
      });
    } catch (error) {
      results.push({
        method: "POST",
        mode,
        status: null,
        success: false,
        message: error?.message || "Request failed.",
      });
    }
  }

  const workingResult = results.find((item) => item.success);

  return {
    apiUrl: KRONOS_DATAS_API_URL,
    apiKey: maskKey(KRONOS_DATAS_API_KEY),
    workingMethod: workingResult?.method || null,
    workingMode: workingResult?.mode || null,
    results,
  };
}