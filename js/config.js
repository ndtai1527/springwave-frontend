export const API_BASE_URL =
  import.meta.env?.VITE_API_URL || "https://api.springwave.io.vn";
export const WORKER_BASE_URL =
  import.meta.env?.VITE_WORKER_URL || "https://worker.springwave.io.vn";
export const CDN_DOMAIN =
  import.meta.env?.VITE_CDN_DOMAIN || "https://cdn.springwave.io.vn";
export const GOOGLE_CLIENT_ID =
  import.meta.env?.VITE_GOOGLE_CLIENT_ID ||
  "438615062762-pmds797uuu9ufi19jvjnmkiach521p1p.apps.googleusercontent.com";
export const MICROSOFT_CLIENT_ID =
  import.meta.env?.VITE_MICROSOFT_CLIENT_ID || "";
const envTurnstileKey = import.meta.env?.VITE_TURNSTILE_SITE_KEY;
export const TURNSTILE_SITE_KEY =
  (envTurnstileKey && envTurnstileKey.trim()) ? envTurnstileKey.trim() : "0x4AAAAAADnOtMcYHV27A0IZ";
