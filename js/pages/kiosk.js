import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { getKioskAuthConfig, getKioskStudentCache, submitKioskCheckin, exitKiosk } from "../api/booth.js";
import { initI18n, t } from "../lib/i18n.js";
import { API_BASE_URL } from "../config.js";

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
const KIOSK_QUEUE_DB = 'springwave-kiosk-outbox-v1';
function safeKioskUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function makeOperationId() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
}

function openQueueDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KIOSK_QUEUE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('outbox', { keyPath: 'operationId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadOfflineQueue() {
  try {
    const db = await openQueueDb();
    offlineQueue = await new Promise((resolve, reject) => {
      const request = db.transaction('outbox').objectStore('outbox').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    updateOfflineBadge();
  } catch (error) {
    console.warn('[Kiosk] Durable outbox unavailable:', error);
  }
}

async function persistQueueItem(item) {
  const db = await openQueueDb();
  await new Promise((resolve, reject) => {
    const request = db.transaction('outbox', 'readwrite').objectStore('outbox').put(item);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  db.close();
}

async function removeQueueItem(operationId) {
  const db = await openQueueDb();
  await new Promise((resolve, reject) => {
    const request = db.transaction('outbox', 'readwrite').objectStore('outbox').delete(operationId);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  db.close();
}

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

    if (toneType === 'buzz' || toneType === 'error') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } else if (toneType === 'chime_success' || toneType === 'arcade') {
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
async function initActivationView() {
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

  // Tokens stay in memory; operators re-authenticate after a refresh.
  await loadOfflineQueue();
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
  const safeBannerUrl = safeKioskUrl(kioskConfig.bannerUrl);
  if (safeBannerUrl) {
    bgBackdrop.style.backgroundImage = `url("${safeBannerUrl}")`;
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

  const safeLogoUrl = safeKioskUrl(kioskConfig.logoUrl);
  if (safeLogoUrl) {
    logoImg.src = safeLogoUrl;
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

  const safeSponsorUrl = safeKioskUrl(kioskConfig.layout?.sponsorQrUrl);
  if (safeSponsorUrl) {
    sponsorQrImg.src = safeSponsorUrl;
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
  loadStudentCache(event._id, session.kioskToken);
  startLiveRosterUpdates(event._id, session.kioskToken);

  // 9. Khởi động Camera ZXing
  initCameraScanner();
}

// =========================================================================
// 3. STUDENT CACHE (INDEXED MAP FOR ZERO-LATENCY VERIFICATION)
// =========================================================================
async function loadStudentCache(eventId, kioskToken) {
  try {
    const data = await getKioskStudentCache(eventId, kioskToken);
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

let liveRefreshTimer = null;
let liveStreamAbort = null;
async function refreshKioskRoster() {
  if (!currentSession?.event?._id || !currentSession?.kioskToken) return;
  await loadStudentCache(currentSession.event._id, currentSession.kioskToken);
}

function startLiveRosterUpdates(eventId, kioskToken) {
  clearInterval(liveRefreshTimer);
  liveStreamAbort?.abort();
  let fallbackStarted = false;
  const startPollingFallback = () => {
    if (fallbackStarted) return;
    fallbackStarted = true;
    liveRefreshTimer = setInterval(() => refreshKioskRoster().catch(() => {}), 15000);
  };
  const controller = new AbortController();
  liveStreamAbort = controller;
  (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/booths/kiosk-stream/${eventId}`, {
        headers: { Authorization: `Bearer ${kioskToken}`, Accept: 'text/event-stream' },
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE closed');
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        if (chunks.some(chunk => chunk.includes('event: kiosk-update'))) await refreshKioskRoster();
      }
    } catch (error) {
      if (!controller.signal.aborted) startPollingFallback();
    }
  })();
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
// =========================================================================
// 5. CHECK-IN LOGIC & ANIMATED RESULT FLYOUT
// =========================================================================
let flyoutDismissTimer = null;

async function handleScannedCode(rawCode) {
  if (!rawCode || scanCooldown) return;
  scanCooldown = true;

  const cleanCode = rawCode.trim().toUpperCase();
  const photoBase64 = captureVideoFrameToWebP();
  const booth = currentSession?.booth;
  const event = currentSession?.event;
  const kioskConfig = currentSession?.kioskConfig || {};

  if (!booth || !event) {
    scanCooldown = false;
    return;
  }

  // Tra cứu siêu tốc trên local cache
  const cachedStudent = studentMap.get(cleanCode);
  const studentName = cachedStudent ? cachedStudent.fullname : 'Sinh viên tham gia';
  const studentId = (cachedStudent && cachedStudent.studentId) ? cachedStudent.studentId : cleanCode;
  const attendanceId = cachedStudent ? cachedStudent.attendanceId : null;

  // 1. Kiểm tra nếu sinh viên này đã check-in tại trạm này trước đó (Local Cache Guard)
  if (cachedStudent && Array.isArray(cachedStudent.visitedBooths) && cachedStudent.visitedBooths.includes(booth.boothCode)) {
    playChime('buzz');
    showResultFlyout({
      isSuccess: false,
      title: 'Đã check-in trước đó!',
      studentName,
      studentId,
      message: `Bạn đã được ghi nhận tham quan tại ${booth.name} rồi.`
    });
    setTimeout(() => {
      scanCooldown = false;
    }, 1500);
    return;
  }

  // Hiển thị trạng thái đang kiểm tra (Verifying state)
  showResultFlyout({
    isVerifying: true,
    title: 'Đang kiểm tra...',
    studentName,
    studentId,
    message: `Đang xác thực thông tin với máy chủ tại ${booth.name}...`
  });

  // Bản ghi gửi lên server
  const checkinPayload = {
    eventId: event._id || event.id,
    boothCode: booth.boothCode || booth.code,
    studentId,
    attendanceId,
    photoBase64,
    deviceInfo: `Kiosk Terminal (${booth.name})`,
    operationId: makeOperationId()
  };

  try {
    if (navigator.onLine) {
      const res = await submitKioskCheckin({ ...checkinPayload, kioskToken: currentSession.kioskToken });
      const finalStudentName = res.studentName || studentName;

      if (res.alreadyVisited) {
        // Máy chủ thông báo sinh viên này đã từng check-in trạm này
        playChime('buzz');
        showResultFlyout({
          isSuccess: false,
          title: 'Đã check-in trước đó!',
          studentName: finalStudentName,
          studentId,
          message: `Bạn đã được ghi nhận tham quan tại ${booth.name} rồi.`
        });
        if (cachedStudent) {
          if (!cachedStudent.visitedBooths) cachedStudent.visitedBooths = [];
          if (!cachedStudent.visitedBooths.includes(booth.boothCode)) {
            cachedStudent.visitedBooths.push(booth.boothCode);
          }
        }
      } else {
        // Điểm danh máy chủ THÀNH CÔNG VÀ XÁC THỰC
        playChime(kioskConfig.soundTone || 'beep_high');

        showResultFlyout({
          isSuccess: true,
          title: kioskConfig.feedbackMessage?.title || 'Điểm danh thành công!',
          studentName: finalStudentName,
          studentId,
          message: `Đã ghi nhận lượt tham quan tại ${booth.name}`
        });

        // Cập nhật recent feed và bộ đếm
        updateRecentFeed(finalStudentName, studentId);
        const counterEl = document.getElementById('kiosk-live-counter');
        if (counterEl) {
          if (res.checkinCount != null) {
            counterEl.textContent = res.checkinCount;
          } else {
            const current = parseInt(counterEl.textContent, 10) || 0;
            counterEl.textContent = current + 1;
          }
        }

        // Cập nhật local cache
        if (cachedStudent) {
          if (!cachedStudent.visitedBooths) cachedStudent.visitedBooths = [];
          if (!cachedStudent.visitedBooths.includes(booth.boothCode)) {
            cachedStudent.visitedBooths.push(booth.boothCode);
          }
          if (res.stationCheckins) {
            cachedStudent.stationCheckins = res.stationCheckins;
          }
        }
      }
    } else {
      // Thiết bị đang ngoại tuyến
      playChime('bell');
      enqueueOfflineCheckin(checkinPayload);
      showResultFlyout({
        isOfflineQueued: true,
        title: 'Đã lưu ngoại tuyến',
        studentName,
        studentId,
        message: 'Mất kết nối mạng. Lượt điểm danh đã được lưu và sẽ tự động đồng bộ khi có kết nối trở lại.'
      });
    }
  } catch (err) {
    if (err.isBusinessError || err.alreadyVisited || (err.status >= 400 && err.status < 500)) {
      // Lỗi nghiệp vụ (chưa đăng ký sự kiện, mã thẻ sai, sự kiện chưa diễn ra, hoặc đã check-in)
      console.warn('[Checkin] Server rejected checkin:', err.message);
      playChime('buzz');
      showResultFlyout({
        isSuccess: false,
        title: err.alreadyVisited ? 'Đã check-in trước đó!' : 'Không thể điểm danh!',
        studentName,
        studentId,
        message: err.message || `Lỗi ghi nhận tại ${booth.name}`
      });
      if (err.alreadyVisited && cachedStudent) {
        if (!cachedStudent.visitedBooths) cachedStudent.visitedBooths = [];
        if (!cachedStudent.visitedBooths.includes(booth.boothCode)) {
          cachedStudent.visitedBooths.push(booth.boothCode);
        }
      }
    } else {
      // Lỗi mạng hoặc 5xx/timeout -> Lưu hàng đợi offline và thông báo rõ ràng
      console.warn('[Checkin] Network/Server timeout, deferred to offline queue:', err);
      playChime('bell');
      enqueueOfflineCheckin(checkinPayload);
      showResultFlyout({
        isOfflineQueued: true,
        title: 'Đã lưu ngoại tuyến',
        studentName,
        studentId,
        message: 'Hệ thống lưu ngoại tuyến do phản hồi chậm. Dữ liệu sẽ tự động đồng bộ lại khi có kết nối ổn định.'
      });
    }
  } finally {
    // Cooldown 1.2s trước khi quét thẻ tiếp theo
    setTimeout(() => {
      scanCooldown = false;
    }, 1200);
  }
}

function showResultFlyout({ isSuccess, isVerifying, isOfflineQueued, title, studentName, studentId, message }) {
  clearTimeout(flyoutDismissTimer);

  const modal = document.getElementById('checkin-modal');
  const card = document.getElementById('checkin-card');
  const titleEl = document.getElementById('result-status-title');
  const nameEl = document.getElementById('result-student-name');
  const idEl = document.getElementById('result-student-id');
  const msgEl = document.getElementById('result-booth-msg');
  const ring = document.getElementById('result-ring');
  const iconBg = document.getElementById('result-icon-bg');
  const icon = document.getElementById('result-icon');

  if (!modal || !card) return;

  titleEl.textContent = title;
  nameEl.textContent = studentName || '';
  idEl.textContent = studentId ? `MSSV / Mã vé: ${studentId}` : '';
  msgEl.textContent = message;

  if (isVerifying) {
    card.className = 'relative w-full max-w-sm sm:max-w-md rounded-3xl p-6 sm:p-8 bg-slate-900 border-2 border-sky-500/60 shadow-2xl shadow-sky-500/20 text-center transform transition-all scale-100 opacity-100 pointer-events-auto';
    nameEl.className = 'text-lg sm:text-xl font-bold text-sky-400 mb-1';
    iconBg.className = 'relative w-16 h-16 rounded-full bg-sky-600 text-white flex items-center justify-center shadow-lg';
    ring.className = 'absolute inset-0 rounded-full bg-sky-500/20 animate-pulse';
    icon.className = 'material-symbols-outlined text-4xl animate-spin';
    icon.textContent = 'progress_activity';
  } else if (isSuccess) {
    card.className = 'relative w-full max-w-sm sm:max-w-md rounded-3xl p-6 sm:p-8 bg-slate-900 border-2 border-emerald-500/60 shadow-2xl shadow-emerald-500/20 text-center transform transition-all scale-100 opacity-100 pointer-events-auto';
    nameEl.className = 'text-lg sm:text-xl font-bold text-emerald-400 mb-1';
    iconBg.className = 'relative w-16 h-16 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-lg';
    ring.className = 'absolute inset-0 rounded-full bg-emerald-500/20 animate-pulse-ring';
    icon.className = 'material-symbols-outlined text-4xl';
    icon.textContent = 'check';
  } else if (isOfflineQueued) {
    card.className = 'relative w-full max-w-sm sm:max-w-md rounded-3xl p-6 sm:p-8 bg-slate-900 border-2 border-amber-500/60 shadow-2xl shadow-amber-500/20 text-center transform transition-all scale-100 opacity-100 pointer-events-auto';
    nameEl.className = 'text-lg sm:text-xl font-bold text-amber-400 mb-1';
    iconBg.className = 'relative w-16 h-16 rounded-full bg-amber-500 text-white flex items-center justify-center shadow-lg';
    ring.className = 'absolute inset-0 rounded-full bg-amber-500/20 animate-pulse';
    icon.className = 'material-symbols-outlined text-4xl';
    icon.textContent = 'cloud_queue';
  } else {
    card.className = 'relative w-full max-w-sm sm:max-w-md rounded-3xl p-6 sm:p-8 bg-slate-900 border-2 border-rose-500/60 shadow-2xl shadow-rose-500/20 text-center transform transition-all scale-100 opacity-100 pointer-events-auto';
    nameEl.className = 'text-lg sm:text-xl font-bold text-rose-400 mb-1';
    iconBg.className = 'relative w-16 h-16 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-lg';
    ring.className = 'hidden';
    icon.className = 'material-symbols-outlined text-4xl';
    icon.textContent = 'close';
  }

  modal.classList.remove('hidden');

  if (!isVerifying) {
    const autoDismissSec = isOfflineQueued
      ? 2.5
      : isSuccess
        ? (currentSession?.kioskConfig?.feedbackMessage?.autoDismissSeconds || 1.4)
        : 2.0;

    flyoutDismissTimer = setTimeout(() => {
      card.classList.remove('scale-100', 'opacity-100');
      card.classList.add('scale-95', 'opacity-0');
      setTimeout(() => {
        modal.classList.add('hidden');
      }, 200);
    }, autoDismissSec * 1000);
  }
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
        ${(name || 'S').charAt(0).toUpperCase()}
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
  const item = { ...payload, queuedAt: Date.now() };
  offlineQueue.push(item);
  persistQueueItem(item).catch(error => console.warn('[Kiosk] Could not persist outbox item:', error));
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
  if (isSyncingOffline || offlineQueue.length === 0 || !navigator.onLine || !currentSession?.kioskToken) return;
  isSyncingOffline = true;

  console.log(`[Kiosk] Syncing ${offlineQueue.length} offline records to server...`);
  const remaining = [];

  for (const item of offlineQueue) {
    try {
      const res = await submitKioskCheckin({ ...item, kioskToken: currentSession.kioskToken });
      await removeQueueItem(item.operationId);
      const counterEl = document.getElementById('kiosk-live-counter');
      if (res?.checkinCount && counterEl) {
        counterEl.textContent = res.checkinCount;
      }
    } catch (err) {
      if (err.isBusinessError || err.alreadyVisited || (err.status >= 400 && err.status < 500)) {
        console.warn('[OfflineQueue] Dropping invalid item from retry queue:', err.message);
        await removeQueueItem(item.operationId);
      } else {
        remaining.push(item);
      }
    }
  }

  offlineQueue = remaining;
  updateOfflineBadge();
  isSyncingOffline = false;
}

function updateNetworkStatus() {
  const statusEl = document.getElementById('kiosk-footer-network');
  const dotEl = statusEl?.previousElementSibling;
  if (!statusEl) return;
  if (navigator.onLine) {
    statusEl.textContent = 'Kết nối ổn định (Edge Serverless)';
    if (dotEl) dotEl.className = 'w-2 h-2 rounded-full bg-emerald-500';
  } else {
    statusEl.textContent = 'Đang ngoại tuyến (Offline Mode)';
    if (dotEl) dotEl.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
  }
}

window.addEventListener('online', () => {
  updateNetworkStatus();
  flushOfflineQueue();
});
window.addEventListener('offline', updateNetworkStatus);
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

  confirmExitBtn?.addEventListener('click', async () => {
    const enteredPin = exitPinInput.value.trim();
    confirmExitBtn.disabled = true;
    try {
      await exitKiosk(currentSession.kioskToken, enteredPin);
      if (zxingReader) zxingReader.reset();
      currentSession = null;
      clearInterval(liveRefreshTimer);
      liveStreamAbort?.abort();
      offlineQueue = [];
      exitModal.classList.add('hidden');
      document.getElementById('view-kiosk').classList.add('hidden');
      document.getElementById('view-activate').classList.remove('hidden');
      const inputs = Array.from(document.querySelectorAll('#booth-code-inputs .code-box'));
      inputs.forEach(i => i.value = '');
      inputs[0]?.focus();
    } catch (error) {
      exitErrorMsg.textContent = error.message || 'Không thể thoát trạm';
      exitPinInput.focus();
    } finally {
      confirmExitBtn.disabled = false;
    }
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
