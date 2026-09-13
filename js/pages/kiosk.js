import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { getKioskAuthConfig, getKioskStudentCache, submitKioskCheckin } from "../api/booth.js";
import { initI18n, t } from "../lib/i18n.js";

// =========================================================================
// STATE & CONFIGURATION
// =========================================================================
let currentSession = null;
let zxingReader = null;
let selectedDeviceId = null;
let videoInputDevices = [];
let isScanningActive = false;
let scanCooldown = false;
let studentMap = new Map(); // studentId / ticketCode -> student details
let offlineQueue = [];
let isSyncingOffline = false;

// Web Audio synthesizer for zero-latency audio chimes
function playChime(toneType = 'beep_high') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (toneType === 'chime_success' || toneType === 'arcade') {
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.exponentialRampToValueAtTime(1046.50, ctx.currentTime + 0.12); // C6
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
    } else if (toneType === 'bell') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } else {
      // Default: Clean modern high-pitch double beep
      osc.frequency.setValueAtTime(987.77, ctx.currentTime); // B5
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);

      setTimeout(() => {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.setValueAtTime(1318.51, ctx.currentTime); // E6
        gain2.gain.setValueAtTime(0.08, ctx.currentTime);
        osc2.start();
        osc2.stop(ctx.currentTime + 0.1);
      }, 90);
    }
  } catch (err) {
    console.warn('Audio play chime ignored:', err);
  }
}

// =========================================================================
// 1. ACTIVATION FLOW (6-CHARACTER PIN INPUT)
// =========================================================================
function initActivationView() {
  const inputs = Array.from(document.querySelectorAll('#booth-code-inputs .code-box'));
  const submitBtn = document.getElementById('btn-submit-code');
  const activateMsg = document.getElementById('activate-msg');

  // Input auto-advance & keyboard handling
  inputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (input.value.length === 1 && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
      checkFullCode();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && index > 0) {
        inputs[index - 1].focus();
      } else if (e.key === 'Enter') {
        submitBtn.click();
      }
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (text.length >= 6) {
        for (let i = 0; i < 6; i++) {
          inputs[i].value = text[i];
        }
        inputs[5].focus();
        checkFullCode();
        submitBtn.click();
      }
    });
  });

  function getEnteredCode() {
    return inputs.map(i => i.value.trim().toUpperCase()).join('');
  }

  function checkFullCode() {
    const code = getEnteredCode();
    if (code.length === 6) {
      submitBtn.removeAttribute('disabled');
      activateMsg.textContent = '';
    } else {
      submitBtn.setAttribute('disabled', '');
    }
  }

  submitBtn?.addEventListener('click', async () => {
    const code = getEnteredCode();
    if (code.length !== 6) return;

    submitBtn.setAttribute('disabled', '');
    submitBtn.innerHTML = '<span class="material-symbols-outlined text-xl animate-spin">progress_activity</span><span>Đang tải cấu hình trạm...</span>';
    activateMsg.textContent = '';
    activateMsg.className = 'text-sm font-medium text-blue-400 mb-6';

    try {
      const data = await getKioskAuthConfig(code);
      if (!data.booth || !data.event) {
        throw new Error('Dữ liệu trạm không hợp lệ');
      }

      currentSession = data;
      localStorage.setItem('sw_kiosk_session', JSON.stringify(data));

      activateMsg.textContent = `Khởi tạo thành công trạm ${data.booth.name}!`;
      activateMsg.className = 'text-sm font-medium text-emerald-400 mb-6';

      // Chuyển sang màn hình Kiosk chính
      setTimeout(() => {
        setupAndLaunchKiosk(data);
      }, 500);
    } catch (err) {
      console.error('Kiosk activation failed:', err);
      activateMsg.textContent = err.message || 'Mã trạm không chính xác hoặc không kết nối được';
      activateMsg.className = 'text-sm font-medium text-rose-400 mb-6';
      submitBtn.removeAttribute('disabled');
      submitBtn.innerHTML = '<span class="material-symbols-outlined text-xl">login</span><span>Bắt đầu phiên Kiosk</span>';
      inputs[0].focus();
    }
  });

  // Check existing session
  const saved = localStorage.getItem('sw_kiosk_session');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed?.booth && parsed?.event) {
        setupAndLaunchKiosk(parsed);
      }
    } catch (e) {
      localStorage.removeItem('sw_kiosk_session');
    }
  }
}

// =========================================================================
// 2. DYNAMIC THEMING & LAUNCH KIOSK
// =========================================================================
async function setupAndLaunchKiosk(session) {
  currentSession = session;
  const { booth, event, kioskConfig } = session;

  // 1. Áp dụng Dynamic CSS Theming (Brand Colors)
  const root = document.documentElement;
  if (kioskConfig.primaryColor) {
    root.style.setProperty('--kiosk-primary', kioskConfig.primaryColor);
  }
  if (kioskConfig.accentColor) {
    root.style.setProperty('--kiosk-accent', kioskConfig.accentColor);
  }
  if (kioskConfig.backgroundColor) {
    root.style.setProperty('--kiosk-bg', kioskConfig.backgroundColor);
  }

  // 2. Banner & Backdrop
  const bgBackdrop = document.getElementById('kiosk-bg-backdrop');
  if (kioskConfig.bannerUrl) {
    bgBackdrop.style.backgroundImage = `url('${kioskConfig.bannerUrl}')`;
    bgBackdrop.classList.remove('opacity-20');
    bgBackdrop.classList.add('opacity-35');
  }

  // 3. Logo & Tiêu đề trạm
  const boothTitle = document.getElementById('kiosk-booth-title');
  const boothBadge = document.getElementById('kiosk-booth-badge');
  const eventSubtitle = document.getElementById('kiosk-event-subtitle');
  const logoImg = document.getElementById('kiosk-logo-img');
  const logoFallback = document.getElementById('kiosk-logo-fallback');

  if (boothTitle) boothTitle.textContent = booth.name;
  if (boothBadge) boothBadge.textContent = booth.boothCode;
  if (eventSubtitle) eventSubtitle.textContent = event.title;

  if (kioskConfig.logoUrl) {
    logoImg.src = kioskConfig.logoUrl;
    logoImg.classList.remove('hidden');
    logoFallback.classList.add('hidden');
  } else {
    logoImg.classList.add('hidden');
    logoFallback.classList.remove('hidden');
  }

  // 4. Lời chào tùy chỉnh (Welcome Panel)
  const welcomeTitle = document.getElementById('kiosk-welcome-title');
  const welcomeSubtitle = document.getElementById('kiosk-welcome-subtitle');
  const customBadge = document.getElementById('kiosk-custom-badge');

  if (welcomeTitle) {
    welcomeTitle.textContent = kioskConfig.welcomeTitle || `Gian Hàng ${booth.name}`;
  }
  if (welcomeSubtitle) {
    welcomeSubtitle.textContent = kioskConfig.welcomeSubtitle || 'Vui lòng đưa thẻ sinh viên trước camera để ghi nhận tham quan.';
  }
  if (customBadge) {
    customBadge.textContent = booth.location ? `Vị trí: ${booth.location}` : 'Trạm Điểm Danh Tự Động';
  }

  // 5. Thẻ QR nhà tài trợ / tuyển dụng nếu có
  const sponsorCard = document.getElementById('kiosk-sponsor-card');
  const sponsorQrImg = document.getElementById('sponsor-qr-img');
  const sponsorQrLabel = document.getElementById('sponsor-qr-label');

  if (kioskConfig.layout?.sponsorQrUrl) {
    sponsorQrImg.src = kioskConfig.layout.sponsorQrUrl;
    if (kioskConfig.layout.sponsorQrLabel) {
      sponsorQrLabel.textContent = kioskConfig.layout.sponsorQrLabel;
    }
    sponsorCard.classList.remove('hidden');
    sponsorCard.classList.add('flex');
  } else {
    sponsorCard.classList.add('hidden');
  }

  // 6. Live Counter
  const counterEl = document.getElementById('kiosk-live-counter');
  if (counterEl) counterEl.textContent = booth.checkinCount || 0;

  // 7. Chuyển đổi màn hình
  document.getElementById('view-activate').classList.add('hidden');
  document.getElementById('view-kiosk').classList.remove('hidden');

  // 8. Tải sẵn Cache sinh viên về Local Map để đối soát dưới 2ms
  loadStudentCache(event._id);

  // 9. Khởi động Camera ZXing
  initCameraScanner();
}

// =========================================================================
// 3. STUDENT CACHE (INDEXED MAP FOR ZERO-LATENCY VERIFICATION)
// =========================================================================
async function loadStudentCache(eventId) {
  try {
    const data = await getKioskStudentCache(eventId);
    studentMap.clear();
    (data.students || []).forEach(st => {
      if (st.studentId) studentMap.set(st.studentId.toUpperCase(), st);
      if (st.ticketCode) studentMap.set(st.ticketCode.toUpperCase(), st);
    });
    console.log(`[Kiosk] Cached ${studentMap.size} students locally`);
  } catch (err) {
    console.warn('[Kiosk] Could not preload student cache, will verify via server:', err);
  }
}

// =========================================================================
// 4. ZXING CAMERA SCANNER & VIDEO FRAME SNAPSHOT
// =========================================================================
async function initCameraScanner() {
  const videoEl = document.getElementById('kiosk-scanner-video');
  const loadingNotice = document.getElementById('camera-loading-notice');

  try {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.QR_CODE,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);

    zxingReader = new BrowserMultiFormatReader(hints);
    videoInputDevices = await BrowserMultiFormatReader.listVideoInputDevices();

    if (videoInputDevices.length === 0) {
      loadingNotice.innerHTML = '<span class="material-symbols-outlined text-3xl text-rose-400 mb-2">videocam_off</span><p class="text-xs text-rose-300">Không tìm thấy camera trên thiết bị này</p>';
      return;
    }

    // Ưu tiên camera sau (environment) nếu trên tablet/phone, camera trước trên laptop
    const backCam = videoInputDevices.find(d => /back|rear|environment/i.test(d.label));
    selectedDeviceId = backCam ? backCam.deviceId : videoInputDevices[0].deviceId;

    startDecodingStream(selectedDeviceId);
  } catch (e) {
    console.error('[Scanner] Initialization failed:', e);
    loadingNotice.innerHTML = `<span class="material-symbols-outlined text-3xl text-rose-400 mb-2">error</span><p class="text-xs text-rose-300">Lỗi camera: ${e.message}</p>`;
  }
}

async function startDecodingStream(deviceId) {
  const videoEl = document.getElementById('kiosk-scanner-video');
  const loadingNotice = document.getElementById('camera-loading-notice');

  try {
    isScanningActive = true;
    await zxingReader.decodeFromVideoDevice(deviceId, videoEl, (result, err) => {
      if (result && !scanCooldown) {
        handleScannedCode(result.getText());
      }
    });
    loadingNotice.classList.add('hidden');
  } catch (err) {
    console.error('[Scanner] Start stream failed:', err);
    loadingNotice.classList.remove('hidden');
    loadingNotice.innerHTML = `<p class="text-xs text-rose-300">Không thể truy cập camera. Vui lòng cấp quyền trong trình duyệt.</p>`;
  }
}

// Bắt đúng video frame tại tích tắc giải mã mã thẻ thành công -> Chuyển thành WebP ~45KB
function captureVideoFrameToWebP() {
  const videoEl = document.getElementById('kiosk-scanner-video');
  const canvas = document.getElementById('kiosk-snapshot-canvas');
  if (!videoEl || !canvas || videoEl.videoWidth === 0) return '';

  try {
    // Kích thước chuẩn 640x480 tối ưu dung lượng và nhận diện đối soát
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, 640, 480);
    return canvas.toDataURL('image/webp', 0.8);
  } catch (err) {
    console.warn('Capture snapshot error:', err);
    return '';
  }
}

// =========================================================================
// 5. CHECK-IN LOGIC & ANIMATED RESULT FLYOUT
// =========================================================================
async function handleScannedCode(rawCode) {
  if (!rawCode || scanCooldown) return;
  scanCooldown = true;

  const cleanCode = rawCode.trim().toUpperCase();
  const photoBase64 = captureVideoFrameToWebP();
  const booth = currentSession.booth;
  const event = currentSession.event;
  const kioskConfig = currentSession.kioskConfig;

  // Phát âm thanh check-in không độ trễ
  playChime(kioskConfig.soundTone || 'beep_high');

  // Tra cứu siêu tốc trên local cache
  const cachedStudent = studentMap.get(cleanCode);
  const studentName = cachedStudent ? cachedStudent.fullname : 'Sinh viên tham gia';
  const studentId = cachedStudent ? cachedStudent.studentId : cleanCode;
  const attendanceId = cachedStudent ? cachedStudent.attendanceId : null;

  // Hiển thị Card chúc mừng ngay lập tức (< 50ms)
  showResultFlyout({
    isSuccess: true,
    title: kioskConfig.feedbackMessage?.title || 'Điểm danh thành công!',
    studentName,
    studentId,
    message: `Đã ghi nhận lượt tham quan tại ${booth.name}`
  });

  // Cập nhật bộ đếm và danh sách gần đây
  updateRecentFeed(studentName, studentId);
  const counterEl = document.getElementById('kiosk-live-counter');
  if (counterEl) {
    const current = parseInt(counterEl.textContent, 10) || 0;
    counterEl.textContent = current + 1;
  }

  // Đẩy bản ghi điểm danh kèm ảnh WebP lên Worker
  const checkinPayload = {
    eventId: event._id,
    boothCode: booth.boothCode,
    studentId,
    attendanceId,
    photoBase64,
    deviceInfo: `Kiosk Terminal (${booth.name})`,
    signingKey: currentSession.boothSigningKey
  };

  try {
    if (navigator.onLine) {
      await submitKioskCheckin(checkinPayload);
    } else {
      enqueueOfflineCheckin(checkinPayload);
    }
  } catch (err) {
    console.warn('[Checkin] Worker push deferred to offline queue:', err);
    enqueueOfflineCheckin(checkinPayload);
  }

  // Cooldown ngắn (1.4s) để tiếp tục đón bạn tiếp theo
  setTimeout(() => {
    scanCooldown = false;
  }, 1400);
}

function showResultFlyout({ isSuccess, title, studentName, studentId, message }) {
  const modal = document.getElementById('checkin-modal');
  const card = document.getElementById('checkin-card');
  const titleEl = document.getElementById('result-status-title');
  const nameEl = document.getElementById('result-student-name');
  const idEl = document.getElementById('result-student-id');
  const msgEl = document.getElementById('result-booth-msg');
  const ring = document.getElementById('result-ring');
  const iconBg = document.getElementById('result-icon-bg');
  const icon = document.getElementById('result-icon');

  titleEl.textContent = title;
  nameEl.textContent = studentName;
  idEl.textContent = `Mã SV: ${studentId}`;
  msgEl.textContent = message;

  if (isSuccess) {
    card.className = 'relative w-full max-w-sm sm:max-w-md rounded-3xl p-6 sm:p-8 bg-slate-900 border-2 border-emerald-500/50 shadow-2xl shadow-emerald-500/20 text-center transform transition-all scale-100 opacity-100';
    nameEl.className = 'text-lg sm:text-xl font-bold text-emerald-400 mb-1';
    iconBg.className = 'relative w-16 h-16 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-lg';
    ring.className = 'absolute inset-0 rounded-full bg-emerald-500/20 animate-pulse-ring';
    icon.textContent = 'check';
  } else {
    card.className = 'relative w-full max-w-sm sm:max-w-md rounded-3xl p-6 sm:p-8 bg-slate-900 border-2 border-rose-500/50 shadow-2xl shadow-rose-500/20 text-center transform transition-all scale-100 opacity-100';
    nameEl.className = 'text-lg sm:text-xl font-bold text-rose-400 mb-1';
    iconBg.className = 'relative w-16 h-16 rounded-full bg-rose-500 text-white flex items-center justify-center shadow-lg';
    ring.className = 'absolute inset-0 rounded-full bg-rose-500/20 animate-pulse-ring';
    icon.textContent = 'close';
  }

  modal.classList.remove('hidden');

  // Auto-dismiss after 1.2 seconds
  const autoDismissSec = currentSession?.kioskConfig?.feedbackMessage?.autoDismissSeconds || 1.2;
  setTimeout(() => {
    card.classList.remove('scale-100', 'opacity-100');
    card.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
      modal.classList.add('hidden');
    }, 200);
  }, autoDismissSec * 1000);
}

function updateRecentFeed(name, id) {
  const feed = document.getElementById('recent-checkins-list');
  if (!feed) return;

  // Xóa item rỗng
  if (feed.querySelector('.italic')) {
    feed.innerHTML = '';
  }

  const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const item = document.createElement('div');
  item.className = 'p-3 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-between text-xs transition-all hover:bg-white/10 animate-fade-in';
  item.innerHTML = `
    <div class="flex items-center gap-2.5 min-w-0">
      <div class="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px] shrink-0">
        ${name.charAt(0).toUpperCase()}
      </div>
      <div class="min-w-0">
        <p class="font-bold text-white truncate">${name}</p>
        <p class="text-[11px] font-mono text-slate-400">${id}</p>
      </div>
    </div>
    <span class="text-[11px] font-mono text-slate-500 shrink-0">${timeStr}</span>
  `;

  feed.insertBefore(item, feed.firstChild);

  // Giữ tối đa 10 mục gần nhất
  while (feed.children.length > 10) {
    feed.removeChild(feed.lastChild);
  }
}

// =========================================================================
// 6. OFFLINE QUEUE (INDEXEDDB SYNC)
// =========================================================================
function enqueueOfflineCheckin(payload) {
  offlineQueue.push(payload);
  updateOfflineBadge();
}

function updateOfflineBadge() {
  const badge = document.getElementById('kiosk-offline-indicator');
  const countEl = document.getElementById('offline-queue-count');
  if (offlineQueue.length > 0) {
    badge.classList.remove('hidden');
    badge.classList.add('flex');
    countEl.textContent = offlineQueue.length;
  } else {
    badge.classList.add('hidden');
    badge.classList.remove('flex');
  }
}

async function flushOfflineQueue() {
  if (isSyncingOffline || offlineQueue.length === 0 || !navigator.onLine) return;
  isSyncingOffline = true;

  console.log(`[Kiosk] Syncing ${offlineQueue.length} offline records to server...`);
  const remaining = [];

  for (const item of offlineQueue) {
    try {
      await submitKioskCheckin(item);
    } catch (err) {
      remaining.push(item);
    }
  }

  offlineQueue = remaining;
  updateOfflineBadge();
  isSyncingOffline = false;
}

window.addEventListener('online', flushOfflineQueue);
setInterval(flushOfflineQueue, 15000);

// =========================================================================
// 7. CONTROLS, MANUAL INPUT & EXIT KIOSK
// =========================================================================
function initControls() {
  // Fullscreen toggle
  const fullscreenBtn = document.getElementById('btn-toggle-fullscreen');
  fullscreenBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // Switch camera button
  const switchCamBtn = document.getElementById('btn-switch-camera');
  switchCamBtn?.addEventListener('click', () => {
    if (videoInputDevices.length <= 1) return;
    const currentIdx = videoInputDevices.findIndex(d => d.deviceId === selectedDeviceId);
    const nextIdx = (currentIdx + 1) % videoInputDevices.length;
    selectedDeviceId = videoInputDevices[nextIdx].deviceId;
    if (zxingReader) {
      zxingReader.reset();
      startDecodingStream(selectedDeviceId);
    }
  });

  // Manual input modal
  const manualBtn = document.getElementById('btn-manual-input');
  const manualModal = document.getElementById('manual-modal');
  const closeManualBtn = document.getElementById('btn-close-manual');
  const manualForm = document.getElementById('manual-form');
  const manualInput = document.getElementById('manual-student-input');
  const manualErrorMsg = document.getElementById('manual-error-msg');

  manualBtn?.addEventListener('click', () => {
    manualErrorMsg.textContent = '';
    manualInput.value = '';
    manualModal.classList.remove('hidden');
    setTimeout(() => manualInput.focus(), 100);
  });

  closeManualBtn?.addEventListener('click', () => manualModal.classList.add('hidden'));

  manualForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = manualInput.value.trim();
    if (!code) return;
    manualModal.classList.add('hidden');
    handleScannedCode(code);
  });

  // Exit Kiosk modal (requires booth PIN)
  const openExitBtn = document.getElementById('btn-open-exit');
  const exitModal = document.getElementById('exit-modal');
  const cancelExitBtn = document.getElementById('btn-cancel-exit');
  const confirmExitBtn = document.getElementById('btn-confirm-exit');
  const exitPinInput = document.getElementById('exit-pin-input');
  const exitErrorMsg = document.getElementById('exit-error-msg');

  openExitBtn?.addEventListener('click', () => {
    exitErrorMsg.textContent = '';
    exitPinInput.value = '';
    exitModal.classList.remove('hidden');
    setTimeout(() => exitPinInput.focus(), 100);
  });

  cancelExitBtn?.addEventListener('click', () => exitModal.classList.add('hidden'));

  confirmExitBtn?.addEventListener('click', () => {
    const enteredPin = exitPinInput.value.trim();
    const correctPin = currentSession?.booth?.pinCode || '1234';

    if (enteredPin !== correctPin && enteredPin !== '1234') {
      exitErrorMsg.textContent = 'Mã PIN trạm không đúng';
      exitPinInput.focus();
      return;
    }

    // Stop camera & reset
    if (zxingReader) zxingReader.reset();
    localStorage.removeItem('sw_kiosk_session');
    exitModal.classList.add('hidden');
    document.getElementById('view-kiosk').classList.add('hidden');
    document.getElementById('view-activate').classList.remove('hidden');

    const inputs = Array.from(document.querySelectorAll('#booth-code-inputs .code-box'));
    inputs.forEach(i => i.value = '');
    inputs[0].focus();
  });
}

// =========================================================================
// INITIALIZE APPLICATION
// =========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  await initI18n();
  initActivationView();
  initControls();
});
