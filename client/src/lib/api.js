// // client/src/lib/api.js
// import axios from "axios";

// const envBase = import.meta.env.VITE_API_URL;

// // ✅ If env not set OR env points to localhost but user is on phone,
// // use current hostname (192.168.xx.xx) automatically.
// function getBaseURL() {
//   if (envBase) return envBase;

//   const host = window.location.hostname; // localhost OR 192.168.xx.xx
//   return `http://${host}:5002/api`;
// }

// export const api = axios.create({
//   baseURL: getBaseURL(),
//   withCredentials: true,
// });


// client/src/lib/api.js
import axios from "axios";

const envBase = import.meta.env.VITE_API_URL;

// ✅ If env has localhost but user is on phone/LAN, replace localhost with current hostname.
// ✅ Also handles https production automatically.
function getBaseURL() {
  const currentHost = window.location.hostname; // localhost OR 192.168.xx.xx OR domain
  const currentProtocol = window.location.protocol; // http: or https:

  // 1) If env exists, try to smart-fix it for phone/LAN
  if (envBase) {
    try {
      const u = new URL(envBase);

      // If env is http://localhost:5002/api but device is accessing via 192.168.xx.xx
      const envHost = u.hostname; // localhost / domain / ip
      const envPort = u.port || (u.protocol === "https:" ? "443" : "80");
      const envPath = u.pathname || "/api";

      const isEnvLocalhost =
        envHost === "localhost" || envHost === "127.0.0.1";

      const isCurrentLocalhost =
        currentHost === "localhost" || currentHost === "127.0.0.1";

      // ✅ phone/LAN case: env says localhost but current host isn't localhost
      if (isEnvLocalhost && !isCurrentLocalhost) {
        return `${currentProtocol}//${currentHost}:${envPort}${envPath}`;
      }

      // Otherwise use env as-is
      return envBase;
    } catch {
      // If envBase isn't a valid URL (rare), fallback below
    }
  }

  // 2) No env => build from current device host
  // Default server port 5002 and /api
  return `${currentProtocol}//${currentHost}:5002/api`;
}

// ✅ iOS Fix: Detect iOS device
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

export const api = axios.create({
  baseURL: getBaseURL(),
  withCredentials: true,
  timeout: 60000, // 60 seconds timeout (iOS needs more time for large uploads)
  maxContentLength: 50 * 1024 * 1024, // 50MB max content length
  maxBodyLength: 50 * 1024 * 1024, // 50MB max body length
});

// ✅ iOS Fix: Add response interceptor for better error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error("🔴 API Error:", {
      url: error.config?.url,
      method: error.config?.method,
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      code: error.code,
      isIOS,
      userAgent: navigator.userAgent,
    });

    // iOS Safari specific: handle network errors better
    if (isIOS && error.code === 'ECONNABORTED') {
      error.message = "Upload timed out on iOS. Please check your connection and try again.";
    }

    if (isIOS && error.code === 'ERR_NETWORK') {
      error.message = "Network error on iOS. Please try again or use WiFi.";
    }

    return Promise.reject(error);
  }
);

