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
export async function getKioskStudentCache(eventId, kioskToken) {
  const headers = {
    'Accept': 'application/json',
    ...(kioskToken ? { Authorization: `Bearer ${kioskToken}` } : {})
  };
  try {
    const res = await fetch(`${WORKER_BASE_URL}/api/kiosk/students/${eventId}`, {
      headers
    });
    if (res.ok) return await res.json();
  } catch (e) {
    console.warn('Worker student cache fallback to backend API');
  }
  const res2 = await fetch(`${API_BASE_URL}/api/booths/kiosk-cache/${eventId}`, {
    headers
  });
  if (!res2.ok) throw new Error('Không thể tải dữ liệu sinh viên sự kiện');
  return await res2.json();
}

/**
 * 9. Gửi lượt điểm danh với kiosk session token và operationId idempotency
 */
export async function submitKioskCheckin({
  eventId,
  boothCode,
  studentId,
  attendanceId,
  photoBase64,
  deviceInfo,
  kioskToken,
  operationId
}) {
  const payload = {
    eventId,
    boothCode: (boothCode || '').toUpperCase(),
    studentId,
    attendanceId,
    photoBase64,
    deviceInfo: deviceInfo || 'Kiosk Camera Terminal',
    operationId
  };

  const rawBody = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    ...(kioskToken ? { Authorization: `Bearer ${kioskToken}` } : {})
  };

  // Gửi tới Worker
  try {
    const res = await fetch(`${WORKER_BASE_URL}/api/kiosk/checkin`, {
      method: 'POST',
      headers,
      body: rawBody
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(result.error || result.message || 'Lỗi xử lý điểm danh tại máy chủ');
      err.status = res.status;
      err.isBusinessError = res.status >= 400 && res.status < 500;
      err.alreadyVisited = result.alreadyVisited || false;
      throw err;
    }
    return result;
  } catch (workerErr) {
    // Nếu là lỗi nghiệp vụ (4xx như duplicate, sự kiện chưa bắt đầu, mã không hợp lệ), ném lỗi ngay
    if (workerErr.isBusinessError) {
      throw workerErr;
    }

    // Nếu Worker gặp sự cố kết nối mạng hoặc lỗi 5xx, mới thử fallback qua Backend API
    const res2 = await fetch(`${API_BASE_URL}/api/booths/manual-checkin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(kioskToken ? { Authorization: `Bearer ${kioskToken}` } : {})
      },
      body: JSON.stringify({
        eventId,
        boothCode: payload.boothCode,
        studentId,
        attendanceId,
        photoUrl: '',
        deviceInfo: 'Kiosk Direct Fallback',
        operationId
      })
    });
    const fallbackRes = await res2.json().catch(() => ({}));
    if (!res2.ok) {
      const err = new Error(fallbackRes.error || workerErr.message || 'Checkin thất bại');
      err.status = res2.status;
      err.isBusinessError = res2.status >= 400 && res2.status < 500;
      err.alreadyVisited = fallbackRes.alreadyVisited || false;
      throw err;
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

export async function exitKiosk(kioskToken, pin) {
  const response = await fetch(`${API_BASE_URL}/api/booths/kiosk-exit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${kioskToken}`
    },
    body: JSON.stringify({ pin })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Mã PIN trạm không đúng');
  return data;
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
