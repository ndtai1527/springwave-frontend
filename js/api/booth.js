import { get, post, put, del } from "./client.js";
import { API_BASE_URL, WORKER_BASE_URL } from "../config.js";

/**
 * 1. Lấy danh sách các gian hàng của sự kiện (Host API)
 */
export async function getBoothsByEvent(eventId) {
  return await get(`/api/booths/event/${eventId}`);
}

/**
 * 2. Tạo gian hàng mới
 */
export async function createBooth(eventId, data) {
  return await post(`/api/booths/event/${eventId}`, data);
}

/**
 * 3. Cập nhật thông tin gian hàng
 */
export async function updateBooth(boothId, data) {
  return await put(`/api/booths/${boothId}`, data);
}

/**
 * 4. Xóa gian hàng
 */
export async function deleteBooth(boothId) {
  return await del(`/api/booths/${boothId}`);
}

/**
 * 5. Lưu cấu hình Giao diện Master Kiosk của sự kiện
 */
export async function saveEventKioskConfig(eventId, kioskConfig) {
  return await put(`/api/booths/event/${eventId}/kiosk-config`, { kioskConfig });
}

/**
 * 6. Lưu cấu hình Giao diện Kiosk Tùy biến riêng của từng gian hàng
 */
export async function saveBoothKioskConfig(boothId, kioskConfig) {
  return await put(`/api/booths/${boothId}/kiosk-config`, { kioskConfig });
}

/**
 * 7. Xác thực mã 6 ký tự tại Kiosk (Kiosk Terminal Handshake)
 */
export async function getKioskAuthConfig(code) {
  const cleanCode = (code || '').trim().toUpperCase();
  try {
    const res = await fetch(`${WORKER_BASE_URL}/api/kiosk/auth/${cleanCode}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) return await res.json();
    throw new Error('Worker handshake returned ' + res.status);
  } catch (err) {
    // Fallback qua Backend VPS nếu Worker gặp sự cố
    const res2 = await fetch(`${API_BASE_URL}/api/booths/kiosk-auth/${cleanCode}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res2.ok) {
      const errData = await res2.json().catch(() => ({}));
      throw new Error(errData.error || 'Không thể kết nối đến máy chủ xác thực');
    }
    return await res2.json();
  }
}

/**
 * 8. Lấy cache 5.000 sinh viên để nạp vào IndexedDB
 */
export async function getKioskStudentCache(eventId) {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/api/kiosk/students/${eventId}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) return await res.json();
  } catch (e) {
    console.warn('Worker student cache fallback to backend API');
  }
  const res2 = await fetch(`${API_BASE_URL}/api/booths/kiosk-cache/${eventId}`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res2.ok) throw new Error('Không thể tải dữ liệu sinh viên sự kiện');
  return await res2.json();
}

/**
 * 9. Ký số HMAC-SHA256 và gửi lượt điểm danh lên Cloudflare Worker
 */
export async function submitKioskCheckin({
  eventId,
  boothCode,
  studentId,
  attendanceId,
  photoBase64,
  deviceInfo,
  signingKey
}) {
  const payload = {
    eventId,
    boothCode: (boothCode || '').toUpperCase(),
    studentId,
    attendanceId,
    photoBase64,
    deviceInfo: deviceInfo || 'Kiosk Camera Terminal',
    signingKey
  };

  const rawBody = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const nonce = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2)) + '-' + Date.now();

  const headers = {
    'Content-Type': 'application/json',
    'X-Timestamp': timestamp,
    'X-Nonce': nonce
  };

  // Tính toán chữ ký HMAC-SHA256 nếu có signingKey
  if (signingKey && window.crypto && window.crypto.subtle) {
    try {
      const enc = new TextEncoder();
      const bodyHashBuf = await crypto.subtle.digest('SHA-256', enc.encode(rawBody));
      const bodyHashHex = Array.from(new Uint8Array(bodyHashBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const msg = `POST:/api/kiosk/checkin:${timestamp}:${nonce}:${bodyHashHex}`;
      const keyBytes = new Uint8Array(
        signingKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
      );
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
      const signatureHex = Array.from(new Uint8Array(sigBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      headers['X-Signature'] = signatureHex;
    } catch (sigErr) {
      console.warn('HMAC computation skipped:', sigErr);
    }
  }

  // Gửi tới Worker
  try {
    const res = await fetch(`${WORKER_BASE_URL}/api/kiosk/checkin`, {
      method: 'POST',
      headers,
      body: rawBody
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(result.error || 'Lỗi xử lý điểm danh tại máy chủ Worker');
    }
    return result;
  } catch (workerErr) {
    // Nếu Worker không phản hồi, thử đồng bộ trực tiếp qua Backend API
    const res2 = await fetch(`${API_BASE_URL}/api/booths/manual-checkin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': 'springwave-internal-sync-secret'
      },
      body: JSON.stringify({
        eventId,
        boothCode: payload.boothCode,
        studentId,
        attendanceId,
        photoUrl: '',
        deviceInfo: 'Kiosk Direct Fallback'
      })
    });
    const fallbackRes = await res2.json().catch(() => ({}));
    if (!res2.ok) {
      throw new Error(fallbackRes.error || workerErr.message || 'Checkin thất bại');
    }
    return fallbackRes;
  }
}

/**
 * 10. Điểm danh thủ công 1-click từ Host Dashboard
 */
export async function manualCheckinBooth(eventId, boothCode, attendanceId) {
  return await post('/api/booths/manual-checkin', {
    eventId,
    boothCode: (boothCode || '').toUpperCase(),
    attendanceId
  });
}

/**
 * 11. Lấy thống kê trực tiếp các trạm (Leaderboard & Stats)
 */
export async function getBoothLiveStats(eventId) {
  return await get(`/api/booths/stats/${eventId}`);
}

/**
 * 12. Link tải báo cáo Excel đa trạm
 */
export function getExportMultiStationUrl(eventId) {
  return `${API_BASE_URL}/api/booths/export/${eventId}`;
}
