import "../../src/style.css";
import { CDN_DOMAIN } from "../config.js";
import { t, getLang, applyTranslation, getCategoryName } from "../lib/i18n.js";
import { isAuthenticated, getUser } from "../lib/session.js";
import { initChatbot } from "../components/chatbot.js";
import { loadNavbar } from "../components/navbar.js";
import { fetchContent, formatDate, capitalize, isOnlineEvent } from "../lib/utils.js";
import { get, post, put, del, uploadFormData } from "../api/client.js";
import { getMyOrganizations, getAllOrganizations, updateOrganization, deleteOrganization, getOrgActivities, getManagers, addManager, removeManager, transferOwnership, uploadOrgAvatar } from "../api/organizations.js";
import { getAttendance, getAttendanceStats, markAttendance, scanAttendance, initAttendance, importExcelAttendance, addParticipantsBatch, updateExternalParticipant, deleteExternalParticipant, removeParticipant, toggleOnlineCheckin, getOnlineCheckinStatus } from "../api/attendance.js";
import { getEventCertificates, issueCertificates, revokeCertificate, restoreCertificate } from "../api/certificates.js";
import { getHostReviews, updateActivity } from "../api/activities.js";
import { getOrgAnalytics, getEventAnalytics, downloadOrgExcelReport, downloadEventExcelReport } from "../api/analytics.js";
import { populateOrgUniversitySelect } from "../api/universities.js";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { drawStyledQR } from "../lib/qr-styler.js";
import { showConfirmDialog, showAlertDialog } from "../lib/modal.js";
import { escapeHtml } from "../lib/sanitize.js";
import QRCode from "qrcode";
import {
  getBoothsByEvent,
  createBooth,
  updateBooth,
  deleteBooth,
  saveEventKioskConfig,
  saveBoothKioskConfig,
  manualCheckinBooth,
  getBoothLiveStats,
  getExportMultiStationUrl
} from "../api/booth.js";

let currentOrgId = null;
let currentOrgs = [];
let currentEvents = [];
let currentSection = "events";

// Analytics scope state
let analyticsScope = "all"; // "all" or "event"
let analyticsEventId = null;
// LocalStorage keys for dialog selects (persisted per-section)
const DIALOG_STATE_KEY_PREFIX = "orgDash.eventSelect.";
// Map of section name → hidden input IDs (used to re-read persisted state)
const DIALOG_SELECT_MAP = {
  participant: "participant-event-select",
  attendance: "attendance-event-select",
  cert: "cert-event-select",
  analytics: "analytics-event-select",
  analyticsReport: "analytics-report-event-select",
};

document.addEventListener("DOMContentLoaded", async () => {
  if (!isAuthenticated()) {
    window.location.href = "/login.html";
    return;
  }
  const user = getUser();

  // Initialize UI event handlers immediately & synchronously
  initSideNav();
  initOrgSelector();
  initCreateOrg();
  initSettingsForm();
  initAddManager();
  initQRScan();
  initAttendanceButtons();
  initOnlineCheckinHostModal();
  initIssueCerts();
  initCreateEvent();
  initEventsTabs();
  initParticipantEventSelect();
  initPdfExportButtons();
  initAttendanceEventSelect();
  initCertEventSelect();
  initCertSearch();
  initCertBackgroundManager();
  initCertLayoutDesigner();
  initAddParticipantsModal();
  initEditExternalModal();

  // Nút mở profile của tổ chức
  document.getElementById("view-profile-btn")?.addEventListener("click", () => {
    if (currentOrgId) {
      window.open(`/org-profile.html?orgId=${currentOrgId}`, "_blank");
    }
  });

  // Async data & component loading
  await loadNavbar({ activeSection: "dashboard" });
  await initChatbot();
  await loadOrgs();
});

// ─── Org Loading ───

function isAdminUser() {
  const u = getUser();
  return u?.role === "admin";
}

function isOrgOwner() {
  if (isAdminUser()) return true;
  const org = currentOrgs.find(o => o._id === currentOrgId);
  if (!org) return false;
  if (org.membershipRole === "owner") return true;
  if (org.membershipRole === "manager") return false;
  const currentUserId = getUser()?._id || getUser()?.id;
  const ownerId = typeof org.owner === "object" ? (org.owner?._id || org.owner?.id) : org.owner;
  return !!(currentUserId && ownerId && String(currentUserId) === String(ownerId));
}

async function loadOrgs() {
  try {
    const data = isAdminUser() ? await getAllOrganizations() : await getMyOrganizations();
    currentOrgs = data.organizations || [];

    renderOrgDropdown();
    if (currentOrgs.length === 1) {
      const singleOrg = currentOrgs[0];
      document.getElementById("org-selector-label").textContent = singleOrg.name;
      await selectOrg(singleOrg._id);
    } else if (currentOrgs.length > 1) {
      const savedOrgId = sessionStorage.getItem("selected_org_id") || localStorage.getItem("selected_org_id");
      const matchedOrg = currentOrgs.find(o => o._id === savedOrgId);
      if (matchedOrg) {
        document.getElementById("org-selector-label").textContent = matchedOrg.name;
        await selectOrg(matchedOrg._id);
      } else {
        const dropdown = document.getElementById("org-dropdown");
        if (dropdown) {
          dropdown.classList.remove("hidden");
          document.getElementById("org-chevron")?.classList.add("rotate-180");
        }
      }
    }
  } catch (err) {
    console.error("Failed to load orgs:", err);
    currentOrgs = [];
    renderOrgDropdown();
  }
}

function renderOrgDropdown() {
  const list = document.getElementById("org-list");
  if (!list) return;
  if (!currentOrgs.length) {
    list.innerHTML = `<div class="text-center py-8 text-[#94a3b8] text-sm">No organizations found</div>`;
    return;
  }
  list.innerHTML = currentOrgs.map(o => {
    const ownerName = o.owner?.fullname || o.owner?.email || "Unknown";
    const avatarContent = o.avatar
      ? `<img src="${o.avatar}" class="w-full h-full object-cover" alt="${o.name}" onerror="this.outerHTML='<span class=\\'font-bold text-sm text-primary\\'>${(o.name?.[0] || '?').toUpperCase()}</span>'" />`
      : `<span class="font-bold text-sm text-primary">${(o.name?.[0] || "?").toUpperCase()}</span>`;
    return `
      <button class="org-option w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[#f8f9fc] transition-colors text-left ${o._id === currentOrgId ? "bg-[#ecedfa] ring-1 ring-primary/20" : ""}" data-id="${o._id}">
        <div class="w-9 h-9 rounded-lg bg-[#ecedfa] flex items-center justify-center text-primary font-bold text-sm shrink-0 overflow-hidden">
          ${avatarContent}
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-sm text-[#191b22] truncate">${o.name}</div>
          <div class="text-[11px] text-[#64748b] truncate" data-org-meta="1">${ownerName}${o.eventCount !== undefined ? ` · ${o.eventCount} events` : ""}</div>
        </div>
        ${o._id === currentOrgId ? '<i class="fa-solid fa-check text-primary text-xs"></i>' : ""}
      </button>
    `;
  }).join("");

  list.querySelectorAll(".org-option").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (id) {
        switchOrg(id);
        closeOrgDropdown();
      }
    });
  });
}

function switchOrg(orgId) {
  const org = currentOrgs.find(o => o._id === orgId);
  if (!org) return;
  currentOrgId = orgId;
  document.getElementById("org-selector-label").textContent = org.name;
  sessionStorage.setItem("selected_org_id", orgId);
  localStorage.setItem("selected_org_id", orgId);
  renderOrgDropdown();
  selectOrg(orgId);
}

function closeOrgDropdown() {
  document.getElementById("org-dropdown")?.classList.add("hidden");
  document.getElementById("org-chevron")?.classList.remove("rotate-180");
}

function initOrgSelector() {
  const btn = document.getElementById("org-selector-btn");
  const dropdown = document.getElementById("org-dropdown");
  const search = document.getElementById("org-search");
  const chevron = document.getElementById("org-chevron");
  if (!btn || !dropdown) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains("hidden");
    dropdown.classList.toggle("hidden");
    if (chevron) chevron.classList.toggle("rotate-180");
    if (!isOpen && search) { search.value = ""; search.focus(); filterOrgs(""); }
  });

  search?.addEventListener("input", (e) => filterOrgs(e.target.value));

  document.addEventListener("click", (e) => {
    if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
      closeOrgDropdown();
    }
  });
}

function filterOrgs(query) {
  const list = document.getElementById("org-list");
  if (!list) return;
  const q = query.toLowerCase().trim();
  list.querySelectorAll(".org-option").forEach(btn => {
    const name = btn.querySelector(".font-semibold")?.textContent?.toLowerCase() || "";
    const meta = btn.querySelector("[data-org-meta]")?.textContent?.toLowerCase() || "";
    btn.style.display = (!q || name.includes(q) || meta.includes(q)) ? "" : "none";
  });
}

async function selectOrg(orgId) {
  currentOrgId = orgId;
  const org = currentOrgs.find(o => o._id === orgId);
  if (org) {
    document.getElementById("org-name-sidebar").textContent = org.name;
    const roleLabel = isAdminUser() ? "Admin" : (org.membershipRole || "owner");
    document.getElementById("org-role-sidebar").textContent = `Role: ${roleLabel}`;

    // Update avatar in sidebar
    const sidebarAvatar = document.getElementById("org-avatar-sidebar");
    const sidebarPlaceholder = document.getElementById("org-avatar-sidebar-placeholder");
    if (sidebarAvatar && sidebarPlaceholder) {
      if (org.avatar) {
        sidebarAvatar.src = org.avatar;
        sidebarAvatar.classList.remove("hidden");
        sidebarPlaceholder.classList.add("hidden");
      } else {
        sidebarAvatar.classList.add("hidden");
        sidebarPlaceholder.classList.remove("hidden");
        sidebarPlaceholder.innerHTML = `<span class="font-bold text-sm text-white">${(org.name?.[0] || "?").toUpperCase()}</span>`;
      }
    }

    // Update avatar in org-selector-btn
    const selectorAvatar = document.getElementById("org-selector-avatar");
    const selectorPlaceholder = document.getElementById("org-selector-avatar-placeholder");
    if (selectorAvatar && selectorPlaceholder) {
      if (org.avatar) {
        selectorAvatar.src = org.avatar;
        selectorAvatar.classList.remove("hidden");
        selectorPlaceholder.classList.add("hidden");
      } else {
        selectorAvatar.classList.add("hidden");
        selectorPlaceholder.classList.remove("hidden");
        selectorPlaceholder.innerHTML = `<span class="font-bold text-xs text-primary">${(org.name?.[0] || "?").toUpperCase()}</span>`;
      }
    }

    const badge = document.getElementById("admin-badge");
    if (isAdminUser() && badge) {
      badge.classList.remove("hidden");
    }

    document.getElementById("org-meta").textContent = isAdminUser()
      ? `Impersonating · Owner: ${org.owner?.fullname || org.owner?.email || "Unknown"}`
      : (org.membershipRole === "owner" ? "You are the owner" : "You are a manager");

    checkOrgDisabledState(org);
  }
  await loadDashboard();
  await loadEvents();
  await loadManagers();
  await loadReviews();
  initAnalyticsScopeControls();
  initAnalyticsReportEventSelect();
  loadSettings(org);
}

function checkOrgDisabledState(org) {
  const isDisabled = org && (org.isActive === false || org.status === 'disabled');
  let banner = document.getElementById("org-disabled-warning-banner");

  if (isDisabled) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "org-disabled-warning-banner";
      banner.className = "mb-6 p-4.5 rounded-2xl bg-red-50 border border-red-200 text-red-800 flex items-start gap-3.5 shadow-sm";
      banner.innerHTML = `
        <div class="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center text-red-600 shrink-0">
          <i class="fa-solid fa-triangle-exclamation text-lg"></i>
        </div>
        <div class="flex-1 min-w-0">
          <h4 class="font-bold text-base text-red-900">Tổ chức / CLB của bạn đã bị Quản trị viên vô hiệu hóa</h4>
          <p class="text-xs text-red-700 mt-1">Tất cả thông tin và sự kiện thuộc tổ chức này đã bị ẩn hoàn toàn khỏi SpringWave. Bạn không thể tạo hoặc cập nhật sự kiện mới. Vui lòng liên hệ ban quản trị để biết thêm chi tiết.</p>
        </div>
      `;
      const mainContainer = document.querySelector("main");
      if (mainContainer) {
        mainContainer.insertBefore(banner, mainContainer.firstChild);
      }
    }
    const createEventBtn = document.getElementById("create-event-btn");
    if (createEventBtn) {
      createEventBtn.disabled = true;
      createEventBtn.classList.add("opacity-50", "pointer-events-none");
    }
  } else {
    if (banner) banner.remove();
    const createEventBtn = document.getElementById("create-event-btn");
    if (createEventBtn) {
      createEventBtn.disabled = false;
      createEventBtn.classList.remove("opacity-50", "pointer-events-none");
    }
  }
}

// ─── Side Nav ───

function initSideNav() {
  document.querySelectorAll(".sidenav-link").forEach(link => {
    link.addEventListener("click", () => {
      switchSection(link.dataset.section);
    });
  });
  document.querySelectorAll(".mobile-tab-link").forEach(link => {
    link.addEventListener("click", () => {
      switchSection(link.dataset.section);
    });
  });
  document.getElementById("goto-events")?.addEventListener("click", () => {
    switchSection("events");
  });
}

function switchSection(section) {
  if (section === "dashboard") section = "events";
  currentSection = section;
  document.querySelectorAll(".section-content").forEach(el => el.classList.add("hidden"));
  const target = document.getElementById(`section-${section}`);
  if (target) target.classList.remove("hidden");

  // Sync desktop sidenav active state
  document.querySelectorAll(".sidenav-link").forEach(l => {
    if (l.dataset.section === section) {
      l.classList.add("active");
    } else {
      l.classList.remove("active");
    }
  });

  // Sync mobile sub-nav active state
  document.querySelectorAll(".mobile-tab-link").forEach(l => {
    if (l.dataset.section === section) {
      l.classList.add("active", "bg-primary", "text-white", "shadow-2xs");
      l.classList.remove("bg-white", "text-slate-600", "border", "border-slate-200", "text-[#64748b]", "border-[#e2e2eb]");
      l.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    } else {
      l.classList.remove("active", "bg-primary", "text-white", "shadow-2xs");
      l.classList.add("bg-white", "text-slate-600", "border", "border-slate-200");
    }
  });

  const ps = document.getElementById("participant-event-select");
  if (section === "participants") {
    if (ps && ps.value) loadParticipants(ps.value);
    updatePdfExportButton();
  }
  const as = document.getElementById("attendance-event-select");
  if (section === "attendance" && as && as.value) loadAttendance(as.value);
  const cs = document.getElementById("cert-event-select");
  if (section === "certificates" && cs && cs.value) loadCertificates(cs.value);
  if (section === "reviews") {
    loadReviews();
  }
  if (section === "analytics") {
    loadOrgAnalytics();
  }
}

// ─── Timeline Status & Metrics ───

export function getEventTimelineStatus(event) {
  if (!event) return "upcoming";
  if (event.isEnded) return "ended";
  if (!event.heldDate) return "upcoming";
  const now = Date.now();
  const startTime = new Date(event.heldDate).getTime();
  if (isNaN(startTime)) return "upcoming";

  let endTime;
  if (event.heldDateEnd) {
    endTime = new Date(event.heldDateEnd).getTime();
  }
  // If no end time, default to end of the heldDate in Vietnam timezone (+7)
  if (!endTime || isNaN(endTime)) {
    const eventDateStr = new Date(event.heldDate).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
    const endOfDay = new Date(`${eventDateStr}T23:59:59.999+07:00`).getTime();
    endTime = !isNaN(endOfDay) ? Math.max(endOfDay, startTime + 4 * 60 * 60 * 1000) : (startTime + 24 * 60 * 60 * 1000);
  }

  if (now > endTime) {
    return "ended";
  }
  if (now >= startTime && now <= endTime) {
    return "ongoing";
  }
  return "upcoming";
}

function updateEventsMetrics(events = currentEvents) {
  const totalParticipants = events.reduce((s, e) => s + (e.participants?.length || 0), 0);
  const upcoming = events.filter(e => getEventTimelineStatus(e) === "upcoming").length;
  const ongoing = events.filter(e => getEventTimelineStatus(e) === "ongoing").length;
  const ended = events.filter(e => getEventTimelineStatus(e) === "ended").length;
  const totalViews = events.reduce((s, e) => s + (e.viewCount || 0), 0);

  const elEvents = document.getElementById("stat-events");
  if (elEvents) elEvents.textContent = events.length;
  const elPart = document.getElementById("stat-participants");
  if (elPart) elPart.textContent = totalParticipants;
  const elUpcoming = document.getElementById("stat-upcoming");
  if (elUpcoming) elUpcoming.textContent = upcoming;
  const elOngoing = document.getElementById("stat-ongoing");
  if (elOngoing) elOngoing.textContent = ongoing;
  const elViews = document.getElementById("stat-views");
  if (elViews) elViews.textContent = totalViews;

  const countAll = document.getElementById("tab-count-all");
  if (countAll) countAll.textContent = events.length;
  const countUpcoming = document.getElementById("tab-count-upcoming");
  if (countUpcoming) countUpcoming.textContent = upcoming;
  const countOngoing = document.getElementById("tab-count-ongoing");
  if (countOngoing) countOngoing.textContent = ongoing;
  const countEnded = document.getElementById("tab-count-ended");
  if (countEnded) countEnded.textContent = ended;
}

// ─── Dashboard (Compatibility Alias) ───

async function loadDashboard() {
  if (!currentOrgId) return;
  try {
    const { events: rawEvents = [] } = await getOrgActivities(currentOrgId);
    currentEvents = rawEvents.filter(a => a._id);
    updateEventsMetrics(currentEvents);
  } catch (err) {
    console.error("Dashboard load error:", err);
  }
}

// ─── Events ───

let eventsTimelineFilter = "all";
let eventsStatusFilter = "all";
let eventsSearchQuery = "";

function initEventsTabs() {
  document.querySelectorAll("[data-events-timeline]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-events-timeline]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      eventsTimelineFilter = btn.dataset.eventsTimeline;
      renderEventsTable();
    });
  });

  const searchInput = document.getElementById("events-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      eventsSearchQuery = searchInput.value.trim().toLowerCase();
      renderEventsTable();
    });
  }

  const statusFilter = document.getElementById("events-status-filter");
  if (statusFilter) {
    statusFilter.addEventListener("change", () => {
      eventsStatusFilter = statusFilter.value;
      renderEventsTable();
    });
  }
}

async function loadEvents() {
  if (!currentOrgId) return;
  try {
    const { events: rawEvents = [] } = await getOrgActivities(currentOrgId);
    currentEvents = rawEvents.filter(a => a._id);
    updateEventsMetrics(currentEvents);
    renderEventsTable();
    populateEventSelects();

    // Auto-trigger data loading for the current active section
    if (currentSection === "participants") {
      const ps = document.getElementById("participant-event-select");
      if (ps && ps.value) loadParticipants(ps.value);
    } else if (currentSection === "attendance") {
      const as = document.getElementById("attendance-event-select");
      if (as && as.value) loadAttendance(as.value);
    } else if (currentSection === "certificates") {
      const cs = document.getElementById("cert-event-select");
      if (cs && cs.value) loadCertificates(cs.value);
    } else if (currentSection === "reviews") {
      const rev = document.getElementById("analytics-event-select");
      filterAnalyticsBySelectedEvent(rev?.value || "");
    } else if (currentSection === "analytics") {
      loadOrgAnalytics();
    }
  } catch (err) {
    console.error("Load events error:", err);
  }
}

function isEventExpired(heldDate) {
  if (!heldDate) return false;
  // Use Vietnam timezone (Asia/Ho_Chi_Minh) for date-only comparison,
  // consistent with how the backend checks event dates. This prevents
  // newly created future events from appearing as expired due to UTC+7 offset.
  const eventDateStr = new Date(heldDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const nowStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return eventDateStr < nowStr;
}

function canEditEvent(heldDate) {
  if (!heldDate) return true;
  const heldTime = new Date(heldDate).getTime();
  const now = Date.now();
  const diffMs = heldTime - now;
  return !(diffMs > 0 && diffMs < 30 * 60 * 1000);
}

function renderEventsTable() {
  const tbody = document.getElementById("events-table-body");
  const empty = document.getElementById("events-empty");
  if (!tbody) return;

  let filtered = currentEvents;
  if (eventsTimelineFilter !== "all") {
    filtered = filtered.filter(e => getEventTimelineStatus(e) === eventsTimelineFilter);
  }
  if (eventsStatusFilter !== "all") {
    filtered = filtered.filter(e => e.status === eventsStatusFilter);
  }
  if (eventsSearchQuery) {
    filtered = filtered.filter(e => {
      const title = (e.title || "").toLowerCase();
      const type = (e.type || "").toLowerCase();
      const loc = (e.location || "").toLowerCase();
      return title.includes(eventsSearchQuery) || type.includes(eventsSearchQuery) || loc.includes(eventsSearchQuery);
    });
  }

  if (!filtered.length) {
    tbody.innerHTML = "";
    if (empty) {
      empty.classList.remove("hidden");
      const emptyTitle = empty.querySelector(".font-bold");
      const emptyDesc = empty.querySelector(".text-xs");
      if (emptyTitle && emptyDesc) {
        if (eventsTimelineFilter === "ongoing") {
          emptyTitle.textContent = t("org_dashboard.no_ongoing_events", {}, "Không có sự kiện nào đang diễn ra");
          emptyDesc.textContent = t("org_dashboard.no_ongoing_events_desc", {}, "Hiện tại không có sự kiện nào diễn ra trong khung thời gian này");
        } else if (eventsTimelineFilter === "upcoming") {
          emptyTitle.textContent = t("org_dashboard.no_upcoming_events", {}, "Không có sự kiện sắp tới");
          emptyDesc.textContent = t("org_dashboard.no_upcoming_events_desc", {}, "Hãy tạo sự kiện mới để thu hút sinh viên tham gia");
        } else if (eventsTimelineFilter === "ended") {
          emptyTitle.textContent = t("org_dashboard.no_ended_events", {}, "Không có sự kiện đã kết thúc");
          emptyDesc.textContent = t("org_dashboard.no_ended_events_desc", {}, "Các sự kiện đã hoàn thành sẽ xuất hiện tại đây");
        } else {
          emptyTitle.textContent = t("org_dashboard.no_events_found", {}, "Không tìm thấy sự kiện");
          emptyDesc.textContent = t("org_dashboard.no_events_found_desc", {}, "Tạo sự kiện đầu tiên hoặc thử thay đổi bộ lọc tìm kiếm");
        }
      }
    }
    return;
  }
  if (empty) empty.classList.add("hidden");

  tbody.innerHTML = filtered.map(e => {
    const timelineStatus = getEventTimelineStatus(e);
    const isEnded = timelineStatus === "ended";
    const canEdit = canEditEvent(e.heldDate);
    const editDisabled = !canEdit || isEnded;
    const editTitle = isEnded ? 'Sự kiện đã kết thúc' : (!canEdit ? 'Không thể chỉnh sửa sự kiện trước thời gian diễn ra 30 phút' : 'Edit');

    let timelineBadge = "";
    if (timelineStatus === "ongoing") {
      timelineBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/80 shadow-2xs whitespace-nowrap"><span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span>${t("org_dashboard.timeline_ongoing", {}, "Đang diễn ra")}</span></span>`;
    } else if (timelineStatus === "upcoming") {
      timelineBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200/80 shadow-2xs whitespace-nowrap"><span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span><span>${t("org_dashboard.timeline_upcoming", {}, "Sắp diễn ra")}</span></span>`;
    } else {
      timelineBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200/80 whitespace-nowrap"><span>${t("org_dashboard.timeline_ended", {}, "Đã diễn ra")}</span></span>`;
    }

    const isDraft = e.status === "draft";
    const draftBadge = isDraft
      ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-amber-50 text-amber-700 border border-amber-200/80 whitespace-nowrap">Draft</span>`
      : "";

    const dateDisplay = e.heldDateEnd
      ? `<span class="font-medium text-slate-700">${formatDate(e.heldDate)}</span><span class="block text-[11px] text-slate-400 font-normal">đến ${formatDate(e.heldDateEnd)}</span>`
      : `<span class="font-medium text-slate-700">${formatDate(e.heldDate)}</span>`;

    return `
    <tr class="border-b border-[#ecedfa] hover:bg-[#f8f9fc] transition-colors ${isEnded ? 'bg-slate-50/40 text-slate-600' : ''}" data-id="${e._id}">
      <td class="py-3.5 px-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-[#ecedfa] overflow-hidden shrink-0">
            ${e.thumbnail
        ? `<img src="${e.thumbnail}" class="w-full h-full object-cover" alt="" />`
        : `<div class="w-full h-full flex items-center justify-center text-[#94a3b8]"><i class="fa-regular fa-image text-sm"></i></div>`
      }
          </div>
          <div class="min-w-0">
            <p class="font-semibold text-[#191b22] truncate max-w-[220px]" title="${e.title || ''}">${e.title}</p>
          </div>
        </div>
      </td>
      <td class="py-3.5 px-4 text-[#64748b] hidden md:table-cell text-xs">${dateDisplay}</td>
      <td class="py-3.5 px-4 text-[#64748b] hidden sm:table-cell font-medium">${e.participants?.length || 0}</td>
      <td class="py-3.5 px-4 text-[#64748b] hidden lg:table-cell text-xs font-medium">${getCategoryName(e.category || e.type || "")}</td>
      <td class="py-3.5 px-4">
        <div class="flex flex-wrap items-center gap-1.5">
          ${timelineBadge}
          ${draftBadge}
        </div>
      </td>
      <td class="py-3.5 px-4 text-right">
        <div class="flex items-center justify-end gap-1.5">
          <button class="view-event-btn w-9 h-9 rounded-lg border border-[#e2e2eb] bg-white flex items-center justify-center text-[#64748b] hover:bg-[#dae1ff] hover:text-primary transition-all spring-ease" title="View">
            <i class="fa-regular fa-eye text-sm"></i>
          </button>
          <button class="edit-event-btn w-9 h-9 rounded-lg border border-[#e2e2eb] bg-white flex items-center justify-center transition-all spring-ease ${editDisabled ? 'opacity-40 cursor-not-allowed' : 'text-[#1755ba] hover:bg-[#dae1ff] hover:text-primary'}" title="${editTitle}" ${editDisabled ? 'disabled' : ''}>
            <i class="fa-solid fa-pen text-sm"></i>
          </button>
          ${!isEnded ? `
          <button class="end-event-btn w-9 h-9 rounded-lg border border-[#e2e2eb] bg-white flex items-center justify-center text-amber-600 hover:bg-amber-50 hover:border-amber-300 transition-all spring-ease" title="${t("org_dashboard.end_event_btn", {}, "Kết thúc sự kiện sớm")}">
            <i class="fa-solid fa-flag-checkered text-sm"></i>
          </button>
          ` : ''}
          ${isOrgOwner() ? `
          <button class="delete-event-btn w-9 h-9 rounded-lg border border-[#e2e2eb] bg-white flex items-center justify-center text-[#ef4444] hover:bg-red-50 hover:border-red-200 transition-all spring-ease" title="Delete">
            <i class="fa-solid fa-trash-can text-sm"></i>
          </button>
          ` : ''}
        </div>
      </td>
    </tr>
  `}).join("");

  tbody.querySelectorAll(".view-event-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.closest("tr").dataset.id;
      openEventDetailModal(id);
    });
  });

  tbody.querySelectorAll(".edit-event-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.closest("tr").dataset.id;
      const event = currentEvents.find(ev => ev._id === id);
      if (!canEditEvent(event?.heldDate)) {
        alert('Không thể chỉnh sửa sự kiện trước thời gian diễn ra 30 phút');
        return;
      }
      window.location.href = `/hostActivity.html?edit=${id}&org=${currentOrgId}`;
    });
  });

  tbody.querySelectorAll(".end-event-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.closest("tr").dataset.id;
      handleEndEvent(id);
    });
  });

  tbody.querySelectorAll(".delete-event-btn").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      if (!isOrgOwner()) {
        alert("Only the organization owner can delete events");
        return;
      }
      const id = btn.closest("tr").dataset.id;
      const confirmed = await showConfirmDialog({
        titleKey: "common.delete_confirm_title",
        messageKey: "org_dashboard.delete_event_confirm",
        confirmTextKey: "common.delete_btn",
        type: "danger"
      });
      if (!confirmed) return;
      try {
        await del(`/events/${id}`);
        currentEvents = currentEvents.filter(ev => ev._id !== id);
        updateEventsMetrics(currentEvents);
        renderEventsTable();
      } catch (err) {
        alert(err.message || "Failed to delete event");
      }
    });
  });
}

async function handleEndEvent(id) {
  const event = currentEvents.find(ev => ev._id === id);
  const confirmed = await showConfirmDialog({
    titleKey: "org_dashboard.end_event_confirm_title",
    messageKey: "org_dashboard.end_event_confirm_msg",
    confirmTextKey: "org_dashboard.end_event_confirm_btn",
    type: "warning",
    params: { title: event?.title || "" }
  });
  if (!confirmed) return;

  try {
    const res = await post(`/events/${id}/end`);
    showAlertDialog({
      titleKey: "common.confirm_title",
      messageKey: "org_dashboard.end_event_success",
      type: "success"
    });

    const idx = currentEvents.findIndex(ev => ev._id === id);
    if (idx !== -1) {
      if (res?.event) {
        currentEvents[idx] = { ...currentEvents[idx], ...res.event, isEnded: true, heldDateEnd: res.event.heldDateEnd };
      } else {
        currentEvents[idx].isEnded = true;
        currentEvents[idx].heldDateEnd = new Date().toISOString();
      }
    }
    updateEventsMetrics(currentEvents);
    renderEventsTable();

    const overlay = document.getElementById("event-detail-overlay");
    if (overlay && !overlay.hasAttribute("hidden") && !overlay.classList.contains("hidden")) {
      openEventDetailModal(id);
    }
  } catch (err) {
    showAlertDialog({
      titleKey: "common.error",
      message: err.message || t("org_dashboard.end_event_failed", {}, "Không thể kết thúc sự kiện"),
      type: "error"
    });
  }
}

// ─── Event Detail Modal ───

async function openEventDetailModal(eventId) {
  let event = currentEvents.find(e => e._id === eventId);
  if (!event) return;

  const overlay = document.getElementById("event-detail-overlay");
  const body = document.getElementById("event-detail-body");
  if (!overlay || !body) return;

  try {
    const res = await get(`/events/${eventId}`);
    if (res?.event) event = { ...event, ...res.event };
  } catch (e) { }

  const heldDate = formatDate(event.heldDate);
  const heldDateEnd = event.heldDateEnd ? formatDate(event.heldDateEnd) : null;
  const deadlineFormatted = event.applicationDeadline ? formatDate(event.applicationDeadline) : null;
  const expired = isEventExpired(event.heldDate);
  const timelineStatus = getEventTimelineStatus(event);
  const isEnded = timelineStatus === "ended";
  const canEdit = canEditEvent(event.heldDate);
  const type = capitalize(event.type || "Event");
  const categoryName = getCategoryName(event.category || type);
  const hostOrgName = typeof event.organization === 'object' ? event.organization?.name : null;
  const source = hostOrgName || event.hostName || event.createdByName || "Unknown";

  const filesHTML = (event.attachments || []).map(f => {
    const link = f.link || f.activityAttachLink || "";
    const fileName = decodeURIComponent(link.split('/').pop());
    const href = (link.startsWith("http://") || link.startsWith("https://")) ? link : `${CDN_DOMAIN}/${link}`;
    return `
      <div class="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-200/80 hover:border-primary/40 shadow-xs transition-all">
        <div class="flex items-center gap-3 truncate min-w-0">
          <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <i class="fa-solid fa-file-arrow-down text-sm"></i>
          </div>
          <span class="truncate font-medium text-slate-800 text-xs sm:text-sm">${fileName}</span>
        </div>
        <a href="${href}" target="_blank" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-primary hover:text-white text-slate-700 font-semibold text-xs transition-colors shrink-0 ml-3">
          <i class="fa-solid fa-download text-[11px]"></i> ${t("common.download", "Download")}
        </a>
      </div>`;
  }).join("");

  body.innerHTML = `
    <!-- Hero Banner -->
    <div class="relative h-[220px] sm:h-[260px] w-full overflow-hidden bg-slate-900 group">
      ${event.thumbnail
      ? `<img src="${event.thumbnail}" class="w-full h-full object-cover opacity-85 transition-transform duration-700 ease-out group-hover:scale-105" alt="${event.title}" />`
      : `<div class="w-full h-full bg-slate-900 flex items-center justify-center"><i class="fa-regular fa-image text-6xl text-white/15"></i></div>`
    }
      <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-black/30"></div>

      <!-- Top Action Floating Bar -->
      <div class="absolute top-4 right-4 z-20 flex items-center gap-2">
        <a href="/explore.html?id=${event._id}" target="_blank" class="px-3 py-1.5 rounded-xl bg-white/20 hover:bg-white/35 text-white backdrop-blur-md text-xs font-semibold flex items-center gap-1.5 border border-white/25 transition-all shadow-sm" title="View public page">
          <i class="fa-solid fa-arrow-up-right-from-square text-[11px]"></i> <span class="hidden sm:inline">Public Page</span>
        </a>
        ${!isEnded ? `
        <button id="detail-modal-end-btn" class="px-3.5 py-1.5 rounded-xl bg-amber-600/90 hover:bg-amber-600 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md border border-white/20 transition-all cursor-pointer active:scale-95" title="${t("org_dashboard.end_event_btn", {}, "Kết thúc sự kiện sớm")}">
          <i class="fa-solid fa-flag-checkered text-[11px]"></i> <span class="hidden sm:inline">${t("org_dashboard.end_event_btn", {}, "Kết thúc sự kiện")}</span>
        </button>
        ` : ''}
        <button id="detail-modal-edit-btn" class="px-3.5 py-1.5 rounded-xl bg-primary hover:bg-primary/90 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md border border-white/20 transition-all ${canEdit ? 'cursor-pointer active:scale-95' : 'opacity-50 cursor-not-allowed'}" ${canEdit ? '' : 'disabled'}>
          <i class="fa-solid fa-pen text-[11px]"></i> Edit
        </button>
        <button id="event-detail-close-btn" class="w-8 h-8 rounded-xl bg-black/40 hover:bg-black/70 text-white backdrop-blur-md flex items-center justify-center border border-white/25 transition-all cursor-pointer active:scale-95">
          <i class="fa-solid fa-xmark text-sm"></i>
        </button>
      </div>

      <!-- Hero Bottom Badges & Category -->
      <div class="absolute bottom-4 left-4 right-4 z-10 flex flex-wrap items-center gap-2">
        ${event.status === "published"
      ? `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 backdrop-blur-md text-xs font-bold uppercase tracking-wider"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Published</span>`
      : `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400/50 text-amber-300 backdrop-blur-md text-xs font-bold uppercase tracking-wider"><span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> Draft</span>`
    }
        ${isEnded ? `<span class="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-slate-500/20 border border-slate-400/50 text-slate-300 backdrop-blur-md text-xs font-bold uppercase tracking-wider">Ended</span>` : (expired ? `<span class="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-rose-500/20 border border-rose-400/50 text-rose-300 backdrop-blur-md text-xs font-bold uppercase tracking-wider">Expired</span>` : '')}
        <span class="inline-flex items-center px-3 py-1 rounded-full bg-white/15 border border-white/20 text-white backdrop-blur-md text-xs font-medium">${categoryName}</span>
      </div>
    </div>

    <!-- Main Content Body -->
    <div class="p-6 sm:p-8 space-y-6 bg-[#fcfdfe]">
      <!-- Header Title & Tags -->
      <div>
        <h2 class="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight leading-tight">${event.title}</h2>
        ${(event.tags || []).length ? `
          <div class="flex flex-wrap gap-1.5 mt-3">
            ${event.tags.map(t => `<span class="inline-block text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">${t}</span>`).join('')}
          </div>` : ''}
      </div>

      <!-- Quick Metrics Strip -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div class="p-3.5 rounded-2xl bg-blue-50/60 border border-blue-100 flex flex-col justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-blue-500/10 text-blue-600 flex items-center justify-center shrink-0">
              <i class="fa-solid fa-users text-lg"></i>
            </div>
            <div class="min-w-0">
              <p class="text-xs font-medium text-slate-500 uppercase tracking-wide truncate">${t("description.participants", "Participants")}</p>
              <p class="text-lg font-bold text-slate-900 truncate">${event.participants?.length || 0}${event.slots ? ` / ${event.slots}` : ''}</p>
            </div>
          </div>
          ${event.slots ? `
            <div class="mt-2.5">
              <div class="flex justify-between text-[11px] font-semibold text-slate-500 mb-1">
                <span>${Math.min(100, Math.round(((event.participants?.length || 0) / event.slots) * 100))}%</span>
                <span>${Math.max(0, event.slots - (event.participants?.length || 0))} ${t("explore.slots_unit", "chỗ")} còn lại</span>
              </div>
              <div class="w-full h-2 bg-slate-200 rounded-full overflow-hidden border border-slate-300/60">
                <div class="h-full rounded-full transition-all" style="width: ${Math.min(100, Math.round(((event.participants?.length || 0) / event.slots) * 100))}%; background-color: ${((event.participants?.length || 0) >= event.slots) ? '#dc2626' : (((event.participants?.length || 0) / event.slots) >= 0.85 ? '#d97706' : '#2563eb')};"></div>
              </div>
            </div>
          ` : ''}
        </div>

        <div class="p-3.5 rounded-2xl bg-emerald-50/60 border border-emerald-100 flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-600 flex items-center justify-center shrink-0">
            <i class="fa-solid fa-award text-lg"></i>
          </div>
          <div class="min-w-0">
            <p class="text-xs font-medium text-slate-500 uppercase tracking-wide truncate">Certificate</p>
            <p class="text-sm font-bold ${event.hasCertificate ? 'text-emerald-700' : 'text-slate-500'} truncate">
              ${event.hasCertificate ? t("common.has_cert", "Supported") : t("common.no_cert", "None")}
            </p>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-indigo-50/60 border border-indigo-100 flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-600 flex items-center justify-center shrink-0">
            <i class="fa-solid fa-qrcode text-lg"></i>
          </div>
          <div class="min-w-0">
            <p class="text-xs font-medium text-slate-500 uppercase tracking-wide truncate">Attendance</p>
            <p class="text-sm font-bold ${event.hasAttendance ? 'text-indigo-700' : 'text-slate-500'} truncate">
              ${event.hasAttendance ? t("common.enable_attendance", "Active") : t("common.disable_attendance", "Disabled")}
            </p>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-amber-50/60 border border-amber-100 flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-700 flex items-center justify-center shrink-0">
            <i class="fa-solid fa-hourglass-half text-lg"></i>
          </div>
          <div class="min-w-0">
            <p class="text-xs font-medium text-slate-500 uppercase tracking-wide truncate">${t("profile.apply_deadline", "Deadline")}</p>
            <p class="text-xs sm:text-sm font-bold text-slate-900 truncate">${deadlineFormatted || 'No limit'}</p>
          </div>
        </div>
      </div>

      <!-- Main Columns Grid -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-2">
        <!-- Main Info Left Column -->
        <div class="lg:col-span-2 space-y-6">
          ${event.registrationLink ? `
            <div class="p-4 rounded-2xl bg-blue-50/70 border border-blue-200/80 flex items-center justify-between gap-3 shadow-xs">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-9 h-9 rounded-xl bg-primary text-white flex items-center justify-center shrink-0 shadow-xs">
                  <i class="fa-solid fa-link text-sm"></i>
                </div>
                <div class="min-w-0">
                  <p class="text-xs font-bold text-slate-700 uppercase tracking-wider">${t("common.registration_link", "External Registration Link")}</p>
                  <a href="${event.registrationLink}" target="_blank" class="text-sm text-primary font-semibold hover:underline truncate block">${event.registrationLink}</a>
                </div>
              </div>
              <button id="copy-reg-link-btn" class="px-3 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 font-semibold text-xs transition-colors shrink-0 flex items-center gap-1.5 cursor-pointer shadow-2xs">
                <i class="fa-regular fa-copy text-xs"></i> <span>Copy</span>
              </button>
            </div>` : ''}

          <!-- Description Section -->
          <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs">
            <h3 class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <i class="fa-solid fa-align-left text-primary"></i> About Event
            </h3>
            <div class="text-slate-700 leading-relaxed text-sm sm:text-base whitespace-pre-wrap">
              ${event.description || t("common.no_description", "No description provided.")}
            </div>
          </div>

          <!-- Attachments Section -->
          ${filesHTML ? `
            <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs">
              <h3 class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                <i class="fa-solid fa-paperclip text-primary"></i> ${t("explore.attached_files", "Attachments")} (${(event.attachments || []).length})
              </h3>
              <div class="space-y-2.5">${filesHTML}</div>
            </div>` : ''}
        </div>

        <!-- Sidebar Right Column -->
        <div class="space-y-4">
          <!-- Schedule Card -->
          <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs space-y-4">
            <h3 class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2 border-b border-slate-100 pb-3">
              <i class="fa-regular fa-calendar-days text-primary"></i> Event Schedule
            </h3>
            <div class="space-y-3 text-xs sm:text-sm">
              <div class="flex items-start gap-3">
                <div class="w-8 h-8 rounded-lg bg-indigo-50 text-primary flex items-center justify-center shrink-0 mt-0.5"><i class="fa-regular fa-clock text-xs"></i></div>
                <div>
                  <p class="text-[11px] font-semibold text-slate-400 uppercase">${t("description.date", "Start Date")}</p>
                  <p class="font-bold text-slate-900">${heldDate}</p>
                </div>
              </div>
              ${heldDateEnd ? `
                <div class="flex items-start gap-3">
                  <div class="w-8 h-8 rounded-lg bg-indigo-50 text-primary flex items-center justify-center shrink-0 mt-0.5"><i class="fa-solid fa-flag-checkered text-xs"></i></div>
                  <div>
                    <p class="text-[11px] font-semibold text-slate-400 uppercase">End Date</p>
                    <p class="font-bold text-slate-900">${heldDateEnd}</p>
                  </div>
                </div>` : ''}
              ${deadlineFormatted ? `
                <div class="flex items-start gap-3">
                  <div class="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center shrink-0 mt-0.5"><i class="fa-solid fa-hourglass-half text-xs"></i></div>
                  <div>
                    <p class="text-[11px] font-semibold text-amber-700 uppercase">${t("profile.apply_deadline", "Application Deadline")}</p>
                    <p class="font-bold text-amber-900">${deadlineFormatted}</p>
                  </div>
                </div>` : ''}
            </div>
          </div>

          <!-- Location Card -->
          <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs space-y-3">
            <h3 class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2 border-b border-slate-100 pb-3">
              <i class="fa-solid fa-location-dot text-rose-500"></i> ${t("description.location", "Location")}
            </h3>
            <div class="flex items-start gap-3 text-xs sm:text-sm">
              <div class="w-8 h-8 rounded-lg bg-rose-50 text-rose-500 flex items-center justify-center shrink-0 mt-0.5"><i class="fa-solid fa-map-pin text-xs"></i></div>
              <p class="font-semibold text-slate-800 leading-snug">${event.location || 'Online / Unspecified'}</p>
            </div>
          </div>

          <!-- Host Info Card -->
          <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs space-y-3">
            <h3 class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2 border-b border-slate-100 pb-3">
              <i class="fa-solid fa-building-user text-indigo-500"></i> Organizer
            </h3>
            <div class="flex items-center gap-3 text-xs sm:text-sm">
              <div class="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0"><i class="fa-solid fa-user-tie text-xs"></i></div>
              <p class="font-bold text-slate-900 truncate">${source}</p>
            </div>
          </div>

          <!-- Attendance Rules Card -->
          <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs space-y-3">
            <h3 class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2 border-b border-slate-100 pb-3">
              <i class="fa-solid fa-shield-halved text-emerald-600"></i> Check-in Policy
            </h3>
            <div class="space-y-2 text-xs">
              <div class="flex justify-between items-center py-1 border-b border-slate-100">
                <span class="text-slate-500">Status</span>
                <span class="font-bold ${event.hasAttendance ? 'text-emerald-600' : 'text-slate-400'}">${event.hasAttendance ? 'Enabled' : 'Disabled'}</span>
              </div>
              ${event.hasAttendance ? `
                <div class="flex justify-between items-center py-1 border-b border-slate-100">
                  <span class="text-slate-500">Late Grace</span>
                  <span class="font-semibold text-slate-800">${(event.lateCheckinMinutes || 0) > 0 ? `${event.lateCheckinMinutes}m` : 'None'}</span>
                </div>
                <div class="flex justify-between items-center py-1">
                  <span class="text-slate-500">Expiration</span>
                  <span class="font-semibold text-slate-800">${(event.expiredCheckinMinutes || 0) > 0 ? `${event.expiredCheckinMinutes}m` : 'None'}</span>
                </div>` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  // Attach Event Handlers
  const closeBtn = document.getElementById("event-detail-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeEventDetailModal);

  const endBtn = document.getElementById("detail-modal-end-btn");
  if (endBtn && !isEnded) {
    endBtn.addEventListener("click", () => {
      handleEndEvent(eventId);
    });
  }

  const editBtn = document.getElementById("detail-modal-edit-btn");
  if (editBtn && canEdit) {
    editBtn.addEventListener("click", () => {
      closeEventDetailModal();
      window.location.href = `/hostActivity.html?edit=${eventId}&org=${currentOrgId}`;
    });
  }

  const copyLinkBtn = document.getElementById("copy-reg-link-btn");
  if (copyLinkBtn && event.registrationLink) {
    copyLinkBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(event.registrationLink).then(() => {
        copyLinkBtn.innerHTML = `<i class="fa-solid fa-check text-emerald-600 text-xs"></i> <span class="text-emerald-700">Copied!</span>`;
        setTimeout(() => {
          copyLinkBtn.innerHTML = `<i class="fa-regular fa-copy text-xs"></i> <span>Copy</span>`;
        }, 2000);
      });
    });
  }

  overlay.removeAttribute("hidden");
  overlay.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeEventDetailModal() {
  const overlay = document.getElementById("event-detail-overlay");
  if (!overlay) return;
  overlay.classList.remove("active");
  document.body.style.overflow = "";
  setTimeout(() => overlay.setAttribute("hidden", ""), 300);
}

// ─── Expired Events Toggle ───

document.addEventListener("DOMContentLoaded", () => {
  const toggleBtn = document.getElementById("toggle-expired-events");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      showExpiredEvents = !showExpiredEvents;
      toggleBtn.classList.toggle("bg-[#dae1ff]", showExpiredEvents);
      const icon = toggleBtn.querySelector(".material-symbols-outlined");
      const text = toggleBtn.querySelector("span:last-child");
      if (icon) icon.textContent = showExpiredEvents ? "visibility_off" : "visibility";
      if (text) text.textContent = showExpiredEvents ? "Hide Expired Events" : "Show Expired Events";
      renderEventsTable();
    });
  }

  const detailBackdrop = document.getElementById("event-detail-backdrop");
  if (detailBackdrop) detailBackdrop.addEventListener("click", closeEventDetailModal);
  const detailClose = document.getElementById("event-detail-close");
  if (detailClose) detailClose.addEventListener("click", closeEventDetailModal);
});

function initCreateEvent() {
  document.getElementById("create-event-btn").addEventListener("click", () => {
    if (!currentOrgId) return alert("Select an organization first");
    window.location.href = `/hostActivity.html?org=${currentOrgId}`;
  });
}

function populateEventSelects() {
  renderEventSelectDialog("participant-event-select-wrapper", "participant-event-select", currentEvents, "Select an event...", "participant", false);
  renderEventSelectDialog("attendance-event-select-wrapper", "attendance-event-select", currentEvents, "Select an event...", "attendance", false);
  renderEventSelectDialog("cert-event-select-wrapper", "cert-event-select", currentEvents, "Select an event...", "cert", false);
  renderEventSelectDialog("analytics-event-select-wrapper", "analytics-event-select", currentEvents, "All Events", "analytics", true);
  renderEventSelectDialog("analytics-report-event-select-wrapper", "analytics-report-event-select", currentEvents, "Select an event...", "analyticsReport", false);
  initEventSelectDialogs();
}

// ─── Event Select Dialog & Cache Management ───────────────────────────────────

const EVENT_CACHE_GLOBAL_PREFIX = "sw_host_event_global_";
const EVENT_CACHE_SECTION_PREFIX = "sw_host_event_section_";

function _resolveThumbnailUrl(thumb) {
  if (!thumb) return "";
  if (thumb.startsWith("http://") || thumb.startsWith("https://") || thumb.startsWith("data:") || thumb.startsWith("blob:")) return thumb;
  return `${CDN_DOMAIN}/${thumb}`;
}

function saveEventSelection(sectionKey, eventId, events, hiddenInputId) {
  if (!currentOrgId) return;
  const ev = events.find(e => e._id === eventId);
  const payload = {
    eventId: eventId || "",
    eventTitle: ev?.title || "",
    eventThumbnail: ev?.thumbnail || "",
    updatedAt: Date.now()
  };
  try {
    if (eventId) {
      localStorage.setItem(`${EVENT_CACHE_GLOBAL_PREFIX}${currentOrgId}`, JSON.stringify(payload));
    }
    if (sectionKey) {
      localStorage.setItem(`${EVENT_CACHE_SECTION_PREFIX}${currentOrgId}_${sectionKey}`, JSON.stringify(payload));
    }
    if (hiddenInputId) {
      localStorage.setItem(`${DIALOG_STATE_KEY_PREFIX}${hiddenInputId}`, JSON.stringify(payload));
    }
  } catch (_) { }
}

function restoreDialogState(hiddenInputId, events, sectionKey, allowAllOption = false) {
  if (!currentOrgId) return allowAllOption ? "" : (events[0]?._id || "");
  try {
    // 1. Check section specific selection for this org
    if (sectionKey) {
      const secRaw = localStorage.getItem(`${EVENT_CACHE_SECTION_PREFIX}${currentOrgId}_${sectionKey}`);
      if (secRaw) {
        const parsed = JSON.parse(secRaw);
        if (allowAllOption && parsed.eventId === "") return "";
        if (parsed.eventId && events.some(e => e._id === parsed.eventId)) return parsed.eventId;
      }
    }
    // 2. Check global selection for this org
    const globRaw = localStorage.getItem(`${EVENT_CACHE_GLOBAL_PREFIX}${currentOrgId}`);
    if (globRaw) {
      const parsed = JSON.parse(globRaw);
      if (parsed.eventId && events.some(e => e._id === parsed.eventId)) return parsed.eventId;
    }
    // 3. Check legacy key
    const legacyRaw = localStorage.getItem(`${DIALOG_STATE_KEY_PREFIX}${hiddenInputId}`);
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw);
      if (allowAllOption && parsed.eventId === "") return "";
      if (parsed.eventId && events.some(e => e._id === parsed.eventId)) return parsed.eventId;
    }
    // 4. Defaults
    if (allowAllOption) return "";
    if (events.length > 0) return events[0]._id;
    return "";
  } catch (_) {
    return (events.length > 0 && !allowAllOption) ? events[0]._id : "";
  }
}

function _renderTriggerContent(selectedEvent, placeholder, allowAllOption) {
  if (selectedEvent) {
    const thumbUrl = _resolveThumbnailUrl(selectedEvent.thumbnail);
    const thumbHtml = thumbUrl
      ? `<img src="${thumbUrl}" class="w-full h-full object-cover" alt="" loading="lazy">`
      : `<div class="w-full h-full bg-[#dae1ff] text-primary flex items-center justify-center"><i class="fa-regular fa-calendar text-xs"></i></div>`;
    return `
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <div class="trigger-thumbnail w-9 h-9 rounded-xl bg-[#ecedfa] overflow-hidden shrink-0 flex items-center justify-center border border-slate-200/80 shadow-2xs">
          ${thumbHtml}
        </div>
        <div class="min-w-0 flex-1 text-left">
          <span class="custom-select-selected-value font-bold text-xs sm:text-sm text-[#191b22] truncate block leading-tight max-w-[180px] sm:max-w-[240px]">
            ${selectedEvent.title}
          </span>
          <span class="text-[11px] text-[#64748b] flex items-center gap-1 mt-0.5 truncate font-medium">
            <i class="fa-regular fa-clock text-[10px] text-primary"></i> ${formatDate(selectedEvent.heldDate)}
          </span>
        </div>
      </div>
      <div class="trigger-chevron-box w-6 h-6 rounded-lg bg-slate-100/80 flex items-center justify-center text-slate-500 shrink-0 ml-1.5 transition-all">
        <span class="material-symbols-outlined text-[18px]">unfold_more</span>
      </div>
    `;
  } else if (allowAllOption) {
    return `
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <div class="trigger-thumbnail w-9 h-9 rounded-xl bg-blue-50 text-primary flex items-center justify-center shrink-0 border border-blue-200/60 shadow-2xs">
          <i class="fa-solid fa-layer-group text-sm"></i>
        </div>
        <div class="min-w-0 flex-1 text-left">
          <span class="custom-select-selected-value font-bold text-xs sm:text-sm text-[#191b22] truncate block leading-tight">
            All Events (Overview)
          </span>
          <span class="text-[11px] text-[#64748b] flex items-center gap-1 mt-0.5 truncate font-medium">
            <i class="fa-solid fa-chart-pie text-[10px] text-primary"></i> Aggregate view
          </span>
        </div>
      </div>
      <div class="trigger-chevron-box w-6 h-6 rounded-lg bg-slate-100/80 flex items-center justify-center text-slate-500 shrink-0 ml-1.5 transition-all">
        <span class="material-symbols-outlined text-[18px]">unfold_more</span>
      </div>
    `;
  } else {
    return `
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <div class="trigger-thumbnail w-9 h-9 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center shrink-0 border border-slate-200/80">
          <i class="fa-regular fa-calendar text-sm"></i>
        </div>
        <div class="min-w-0 flex-1 text-left">
          <span class="custom-select-selected-value font-bold text-xs sm:text-sm text-slate-600 truncate block leading-tight">
            ${placeholder}
          </span>
          <span class="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5 truncate">
            <i class="fa-solid fa-hand-pointer text-[10px]"></i> Click to choose event
          </span>
        </div>
      </div>
      <div class="trigger-chevron-box w-6 h-6 rounded-lg bg-slate-100/80 flex items-center justify-center text-slate-500 shrink-0 ml-1.5 transition-all">
        <span class="material-symbols-outlined text-[18px]">unfold_more</span>
      </div>
    `;
  }
}

function renderEventSelectDialog(wrapperId, hiddenInputId, events, placeholder, sectionKey, allowAllOption = false) {
  const wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;

  // Clean up any existing dialog for this hiddenInputId
  const oldDialog = document.getElementById(hiddenInputId + "-dialog");
  if (oldDialog) {
    if (oldDialog._escHandler) document.removeEventListener("keydown", oldDialog._escHandler);
    oldDialog.remove();
  }

  let currentValue = restoreDialogState(hiddenInputId, events, sectionKey, allowAllOption);
  let selectedEvent = events.find(e => e._id === currentValue) || null;
  if (!selectedEvent && !allowAllOption && events.length > 0) {
    currentValue = events[0]._id;
    selectedEvent = events[0];
  }

  wrapper.innerHTML = "";

  // Trigger button
  const triggerBtn = document.createElement("button");
  triggerBtn.type = "button";
  triggerBtn.id = hiddenInputId + "-trigger";
  triggerBtn.className = "custom-select-trigger w-full sm:w-auto min-w-[220px] md:min-w-[270px] max-w-full";
  triggerBtn.setAttribute("aria-haspopup", "dialog");
  triggerBtn.setAttribute("aria-expanded", "false");
  triggerBtn.setAttribute("aria-controls", hiddenInputId + "-dialog");
  triggerBtn.innerHTML = _renderTriggerContent(selectedEvent, placeholder, allowAllOption);
  wrapper.appendChild(triggerBtn);

  // Hidden input
  const input = document.createElement("input");
  input.type = "hidden";
  input.id = hiddenInputId;
  input.value = currentValue;
  wrapper.appendChild(input);

  // Section-based title
  const dialogTitle = sectionKey === "attendance"
    ? "Select Event for Attendance"
    : sectionKey === "cert"
      ? "Select Event for Certificates"
      : sectionKey === "participant"
        ? "Select Event for Participants"
        : sectionKey === "analytics"
          ? "Filter Reviews by Event"
          : sectionKey === "analyticsReport"
            ? "Select Event for Analytics Report"
            : "Select Event";

  const orgName = currentOrgs.find(o => o._id === currentOrgId)?.name || "Your Organization";

  // Filter counts
  const publishedCount = events.filter(e => e.status === "published").length;
  const draftCount = events.filter(e => e.status === "draft").length;
  const upcomingCount = events.filter(e => e.heldDate && new Date(e.heldDate) >= new Date()).length;
  const pastCount = events.filter(e => isEventExpired(e.heldDate)).length;

  // Dialog DOM
  const dialog = document.createElement("div");
  dialog.id = hiddenInputId + "-dialog";
  dialog.className = "event-select-dialog hidden";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `${hiddenInputId}-dialog-title`);
  dialog.innerHTML = `
    <div class="event-select-backdrop" aria-hidden="true"></div>
    <div class="event-select-dialog-inner">
      <div class="event-select-drag-handle"></div>
      <div class="event-select-dialog-header">
        <div>
          <h3 id="${hiddenInputId}-dialog-title" class="event-select-dialog-title">${dialogTitle}</h3>
          <p class="event-select-dialog-subtitle">Choose an event from ${orgName}</p>
        </div>
        <button type="button" class="event-select-dialog-close" aria-label="Close dialog">
          <span class="material-symbols-outlined text-[20px]">close</span>
        </button>
      </div>

      <div class="event-select-dialog-search-container">
        <div class="event-select-dialog-search">
          <span class="material-symbols-outlined event-select-search-icon">search</span>
          <input type="text" class="event-select-search-input" placeholder="Search event by name, date, location..." autocomplete="off">
          <button type="button" class="event-select-search-clear hidden" aria-label="Clear search">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="event-select-filter-pills">
          <button type="button" class="event-select-pill active" data-filter="all">All (${events.length})</button>
          <button type="button" class="event-select-pill" data-filter="published">Published (${publishedCount})</button>
          <button type="button" class="event-select-pill" data-filter="draft">Draft (${draftCount})</button>
          <button type="button" class="event-select-pill" data-filter="upcoming">Upcoming (${upcomingCount})</button>
          <button type="button" class="event-select-pill" data-filter="past">Past (${pastCount})</button>
        </div>
      </div>

      <div class="event-select-dialog-list"></div>

      <div class="event-select-dialog-footer">
        <span class="text-xs text-[#64748b] font-medium" id="${hiddenInputId}-dialog-count">Showing ${events.length} event(s)</span>
        <button type="button" class="event-select-dialog-choose px-5 py-2 rounded-xl bg-primary text-white hover:bg-primary/90 text-xs font-semibold cursor-pointer shadow-xs transition-colors">${t('common.choose', 'Choose')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  const listEl = dialog.querySelector(".event-select-dialog-list");
  const searchInput = dialog.querySelector(".event-select-search-input");
  const searchClearBtn = dialog.querySelector(".event-select-search-clear");
  const filterPills = dialog.querySelectorAll(".event-select-pill");
  const closeBtn = dialog.querySelector(".event-select-dialog-close");
  const chooseBtn = dialog.querySelector(".event-select-dialog-choose");
  const backdrop = dialog.querySelector(".event-select-backdrop");
  const countEl = dialog.querySelector(`#${hiddenInputId}-dialog-count`);

  let activeFilter = "all";
  let activeQuery = "";
  let tempSelectedId = input.value;

  function _updateSelectedCard(newSelectedId) {
    tempSelectedId = newSelectedId;
    const cards = listEl.querySelectorAll(".event-select-card");
    cards.forEach(c => {
      const cardId = c.dataset.eventId !== undefined ? c.dataset.eventId : "";
      const isThisSelected = (cardId === (tempSelectedId || ""));
      c.classList.toggle("event-select-card-selected", isThisSelected);
      const radioContainer = c.querySelector(".event-select-radio-container");
      if (radioContainer) {
        radioContainer.innerHTML = isThisSelected
          ? '<div class="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center shadow-xs"><span class="material-symbols-outlined text-[16px] font-bold">check</span></div>'
          : '<div class="w-6 h-6 rounded-full border-2 border-slate-200"></div>';
      }
    });
  }

  function _confirmSelection() {
    if (tempSelectedId) {
      const ev = events.find(e => e._id === tempSelectedId) || null;
      _selectEventItem(ev);
    } else if (allowAllOption) {
      _selectEventItem(null);
    } else if (events.length > 0) {
      _selectEventItem(events[0]);
    } else {
      closeDialog();
    }
  }

  function _filterEventsList() {
    let list = events;
    if (activeFilter === "published") {
      list = list.filter(e => e.status === "published");
    } else if (activeFilter === "draft") {
      list = list.filter(e => e.status === "draft");
    } else if (activeFilter === "upcoming") {
      list = list.filter(e => e.heldDate && new Date(e.heldDate) >= new Date());
    } else if (activeFilter === "past") {
      list = list.filter(e => isEventExpired(e.heldDate));
    }

    if (activeQuery) {
      const q = activeQuery.toLowerCase().trim();
      list = list.filter(e => {
        const title = (e.title || "").toLowerCase();
        const loc = (e.location || "").toLowerCase();
        const dateStr = formatDate(e.heldDate).toLowerCase();
        const cat = (e.category?.name || e.type || "").toLowerCase();
        return title.includes(q) || loc.includes(q) || dateStr.includes(q) || cat.includes(q);
      });
    }

    return list;
  }

  function _renderCards() {
    const filtered = _filterEventsList();
    listEl.innerHTML = "";

    if (countEl) {
      countEl.innerHTML = `Showing <strong class="text-slate-800">${filtered.length}</strong> of ${events.length} event(s)`;
    }

    // If org has 0 events total
    if (events.length === 0) {
      if (chooseBtn) {
        chooseBtn.disabled = true;
        chooseBtn.classList.add("opacity-50", "cursor-not-allowed");
      }
      listEl.innerHTML = `
        <div class="event-select-empty">
          <i class="fa-regular fa-calendar-xmark text-4xl text-slate-300 mb-1"></i>
          <p class="font-bold text-slate-700 text-sm">No events created yet</p>
          <p class="text-xs text-slate-500 max-w-[260px] leading-relaxed">Create your first event for ${orgName} to manage participants and attendance.</p>
          <a href="/hostActivity.html?org=${currentOrgId || ''}" class="mt-3 px-5 py-2.5 rounded-full bg-primary text-white text-xs font-semibold hover:bg-primary/90 transition-all shadow-xs">
            <i class="fa-solid fa-plus mr-1"></i> Create Event
          </a>
        </div>
      `;
      return;
    }

    if (chooseBtn) {
      chooseBtn.disabled = false;
      chooseBtn.classList.remove("opacity-50", "cursor-not-allowed");
    }

    // If query returned 0 matches
    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="event-select-empty">
          <i class="fa-solid fa-magnifying-glass text-3xl text-slate-300 mb-1"></i>
          <p class="font-bold text-slate-700 text-sm">No events found matching "${activeQuery}"</p>
          <p class="text-xs text-slate-500">Try searching for a different keyword or change filter.</p>
          <button type="button" class="clear-search-action text-xs text-primary font-semibold hover:underline mt-2 cursor-pointer bg-transparent border-none">
            Reset search & filters
          </button>
        </div>
      `;
      listEl.querySelector(".clear-search-action")?.addEventListener("click", () => {
        activeQuery = "";
        searchInput.value = "";
        searchClearBtn.classList.add("hidden");
        activeFilter = "all";
        filterPills.forEach(p => p.classList.toggle("active", p.dataset.filter === "all"));
        _renderCards();
      });
      return;
    }

    const fragment = document.createDocumentFragment();

    // If allowAllOption is true and activeFilter is all without query
    if (allowAllOption && activeFilter === "all" && !activeQuery) {
      const isAllSelected = !tempSelectedId;
      const allCard = document.createElement("div");
      allCard.dataset.eventId = "";
      allCard.className = `event-select-card ${isAllSelected ? "event-select-card-selected" : ""}`;
      allCard.innerHTML = `
        <div class="w-16 h-16 rounded-xl bg-blue-50 flex items-center justify-center text-primary text-2xl shrink-0 border border-blue-200/60 shadow-2xs">
          <i class="fa-solid fa-layer-group"></i>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h4 class="font-bold text-sm text-[#191b22]">All Events (Overview)</h4>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">Aggregate</span>
          </div>
          <p class="text-xs text-[#64748b] mt-1">Show combined metrics and reviews for all ${events.length} events</p>
        </div>
        <div class="event-select-radio-container shrink-0 ml-2">
          ${isAllSelected
          ? '<div class="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center shadow-xs"><span class="material-symbols-outlined text-[16px] font-bold">check</span></div>'
          : '<div class="w-6 h-6 rounded-full border-2 border-slate-200"></div>'}
        </div>
      `;
      allCard.addEventListener("click", () => {
        _updateSelectedCard("");
      });
      allCard.addEventListener("dblclick", () => {
        _updateSelectedCard("");
        _confirmSelection();
      });
      fragment.appendChild(allCard);
    }

    filtered.forEach(e => {
      const isSelected = tempSelectedId === e._id;
      const isExpired = isEventExpired(e.heldDate);
      const isUpcoming = e.heldDate && new Date(e.heldDate) >= new Date();
      const thumbUrl = _resolveThumbnailUrl(e.thumbnail);

      const thumbHtml = thumbUrl
        ? `<img src="${thumbUrl}" class="w-full h-full object-cover" alt="" loading="lazy">`
        : `<div class="w-full h-full bg-[#dae1ff] text-primary flex items-center justify-center"><i class="fa-regular fa-calendar text-base"></i></div>`;

      let statusBadgeHtml = '';
      if (e.status === 'published') {
        statusBadgeHtml = `<span class="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200/60 text-[10px] font-semibold">Published</span>`;
      } else {
        statusBadgeHtml = `<span class="px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200/60 text-[10px] font-semibold">Draft</span>`;
      }

      let timingBadge = '';
      if (isExpired) {
        timingBadge = `<span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[10px] font-semibold">Past</span>`;
      } else if (isUpcoming) {
        timingBadge = `<span class="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200/60 text-[10px] font-semibold">Upcoming</span>`;
      }

      const card = document.createElement("div");
      card.dataset.eventId = e._id;
      card.className = `event-select-card ${isSelected ? "event-select-card-selected" : ""}`;
      card.innerHTML = `
        <div class="w-16 h-16 rounded-xl overflow-hidden shrink-0 bg-slate-100 border border-slate-200/80 relative shadow-2xs">
          ${thumbHtml}
        </div>
        <div class="min-w-0 flex-1">
          <h4 class="font-bold text-sm text-[#191b22] line-clamp-1 leading-snug">${e.title}</h4>
          <div class="text-xs text-[#64748b] mt-1 flex items-center gap-1.5 flex-wrap">
            <span class="inline-flex items-center gap-1"><i class="fa-regular fa-calendar text-[11px] text-primary"></i> ${formatDate(e.heldDate)}</span>
            ${e.location ? `<span class="text-slate-300">·</span><span class="truncate max-w-[140px]"><i class="fa-solid fa-location-dot text-[10px] text-rose-500 mr-0.5"></i> ${e.location}</span>` : ""}
          </div>
          <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
            ${statusBadgeHtml}
            ${timingBadge}
            <span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[10px] font-semibold">
              <i class="fa-solid fa-users text-[9px] mr-1"></i>${e.participants?.length || 0}
            </span>
            ${e.hasCertificate ? '<span class="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200/60 text-[10px] font-semibold"><i class="fa-solid fa-award text-[9px] mr-1"></i>Cert</span>' : ''}
            ${e.hasAttendance ? '<span class="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200/60 text-[10px] font-semibold"><i class="fa-solid fa-qrcode text-[9px] mr-1"></i>Check-in</span>' : ''}
          </div>
        </div>
        <div class="event-select-radio-container shrink-0 ml-2">
          ${isSelected
          ? '<div class="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center shadow-xs"><span class="material-symbols-outlined text-[16px] font-bold">check</span></div>'
          : '<div class="w-6 h-6 rounded-full border-2 border-slate-200"></div>'}
        </div>
      `;

      card.addEventListener("click", () => {
        _updateSelectedCard(e._id);
      });

      card.addEventListener("dblclick", () => {
        _updateSelectedCard(e._id);
        _confirmSelection();
      });

      fragment.appendChild(card);
    });

    listEl.appendChild(fragment);
  }

  function _selectEventItem(ev) {
    const newId = ev ? ev._id : "";
    input.value = newId;
    triggerBtn.innerHTML = _renderTriggerContent(ev, placeholder, allowAllOption);
    saveEventSelection(sectionKey, newId, events, hiddenInputId);
    closeDialog();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function openDialog() {
    dialog.classList.remove("hidden");
    triggerBtn.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
    tempSelectedId = input.value;
    activeFilter = "all";
    activeQuery = "";
    searchInput.value = "";
    searchClearBtn.classList.add("hidden");
    filterPills.forEach(p => p.classList.toggle("active", p.dataset.filter === "all"));
    _renderCards();
    setTimeout(() => searchInput.focus(), 60);
  }

  function closeDialog() {
    dialog.classList.add("hidden");
    triggerBtn.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  }

  triggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openDialog();
  });

  closeBtn?.addEventListener("click", closeDialog);
  chooseBtn?.addEventListener("click", _confirmSelection);
  backdrop?.addEventListener("click", closeDialog);

  searchInput?.addEventListener("input", (e) => {
    activeQuery = e.target.value;
    searchClearBtn.classList.toggle("hidden", !activeQuery);
    _renderCards();
  });

  searchClearBtn?.addEventListener("click", () => {
    activeQuery = "";
    searchInput.value = "";
    searchClearBtn.classList.add("hidden");
    searchInput.focus();
    _renderCards();
  });

  filterPills.forEach(pill => {
    pill.addEventListener("click", () => {
      activeFilter = pill.dataset.filter || "all";
      filterPills.forEach(p => p.classList.toggle("active", p === pill));
      _renderCards();
    });
  });

  const _escHandler = (ev) => {
    if (ev.key === "Escape" && !dialog.classList.contains("hidden")) {
      ev.stopPropagation();
      closeDialog();
    }
  };
  document.addEventListener("keydown", _escHandler);
  dialog._escHandler = _escHandler;
}

function initEventSelectDialogs() {
  initParticipantEventSelect();
  initAttendanceEventSelect();
  initCertEventSelect();
  initAnalyticsEventSelect();
  initAnalyticsReportEventSelect();
}

function initAnalyticsEventSelect() {
  const wrapper = document.getElementById("analytics-event-select-wrapper");
  if (!wrapper || wrapper.dataset.analyticsInitialized === "true") return;
  wrapper.dataset.analyticsInitialized = "true";
  wrapper.addEventListener("change", (e) => {
    if (e.target.id === "analytics-event-select") {
      filterAnalyticsBySelectedEvent(e.target.value);
    }
  });
}

function initParticipantEventSelect() {
  const wrapper = document.getElementById("participant-event-select-wrapper");
  if (!wrapper || wrapper.dataset.participantInitialized === "true") return;
  wrapper.dataset.participantInitialized = "true";
  wrapper.addEventListener("change", (e) => {
    if (e.target.id === "participant-event-select") {
      if (e.target.value) {
        loadParticipants(e.target.value);
      } else {
        document.getElementById("participants-table-body").innerHTML = "";
        document.getElementById("participants-empty").classList.remove("hidden");
        document.getElementById("participant-count").textContent = "0";
      }
    }
    updatePdfExportButton();
  });
}

let currentParticipantsList = [];
let currentEvent = null; // currently loaded event for participants section

function renderParticipantsTable(list) {
  const tbody = document.getElementById("participants-table-body");
  const empty = document.getElementById("participants-empty");
  if (!tbody) return;
  if (!list || !list.length) {
    tbody.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");

  tbody.innerHTML = list.map(p => {
    const studentIdDisplay = p.studentId || "—";
    const emailDisplay = p.email || "—";

    const typeBadge = p.isExternal
      ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
           <i class="fa-solid fa-user-tag text-[9px]"></i> Guest
         </span>`
      : `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
           <i class="fa-solid fa-user-check text-[9px]"></i> Member
         </span>`;

    let statusBadge = '';
    if (p.status === 'present') {
      statusBadge = '<span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background:#d1fae5;color:#059669">Present</span>';
    } else if (p.status === 'late') {
      statusBadge = '<span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background:#fef3c7;color:#d97706">Late</span>';
    } else {
      statusBadge = '<span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background:#fee2e2;color:#dc2626">Absent</span>';
    }

    const actionButtons = p.isExternal
      ? `<div class="flex items-center justify-end gap-1.5">
           <button class="edit-ext-btn w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-primary hover:bg-primary/10 transition-colors border border-transparent hover:border-primary/20 cursor-pointer"
             data-id="${p.attendanceId || p._id}"
             data-fullname="${encodeURIComponent(p.fullname || '')}"
             data-studentid="${encodeURIComponent(p.studentId || '')}"
             data-email="${encodeURIComponent(p.email || '')}"
             title="Edit participant information">
             <i class="fa-solid fa-pen text-xs"></i>
           </button>
           <button class="delete-participant-btn w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors border border-transparent hover:border-red-200 cursor-pointer"
             data-id="${p.attendanceId || p._id}"
             data-name="${encodeURIComponent(p.fullname || '')}"
             data-is-external="true"
             title="Remove participant">
             <i class="fa-solid fa-trash-can text-xs"></i>
           </button>
         </div>`
      : `<div class="flex items-center justify-end gap-1.5">
           <button class="delete-participant-btn w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors border border-transparent hover:border-red-200 cursor-pointer"
             data-id="${p._id || p.attendanceId}"
             data-name="${encodeURIComponent(p.fullname || '')}"
             data-is-external="false"
             title="Remove participant & revoke QR ticket">
             <i class="fa-solid fa-trash-can text-xs"></i>
           </button>
         </div>`;

    return `
      <tr class="border-b border-[#ecedfa] hover:bg-slate-50/60 transition-colors">
        <td class="py-3.5 px-4">
          <div class="flex items-center gap-3">
            ${p.avatar
        ? `<img src="${p.avatar}" class="w-8 h-8 rounded-full object-cover shrink-0" />`
        : `<div class="w-8 h-8 rounded-full ${p.isExternal ? 'bg-amber-100 text-amber-700' : 'bg-[#dae1ff] text-primary'} flex items-center justify-center text-xs font-bold shrink-0">${(p.fullname?.[0] || "?").toUpperCase()}</div>`}
            <div>
              <span class="font-semibold text-[#191b22] block">${p.fullname || "Unknown"}</span>
            </div>
          </div>
        </td>
        <td class="py-3.5 px-4 font-mono text-xs text-slate-700 font-semibold">${studentIdDisplay}</td>
        <td class="py-3.5 px-4 text-[#64748b] hidden md:table-cell">${emailDisplay}</td>
        <td class="py-3.5 px-4">${typeBadge}</td>
        <td class="py-3.5 px-4 hidden sm:table-cell">${statusBadge}</td>
        <td class="py-3.5 px-4 text-right">${actionButtons}</td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".edit-ext-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const fullname = decodeURIComponent(btn.dataset.fullname || "");
      const studentId = decodeURIComponent(btn.dataset.studentid || "");
      const email = decodeURIComponent(btn.dataset.email || "");
      openEditExternalModal(id, fullname, studentId, email);
    });
  });

  tbody.querySelectorAll(".delete-participant-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const isExt = btn.dataset.isExternal === "true";
      const name = decodeURIComponent(btn.dataset.name || "this participant");
      const eventId = document.getElementById("participant-event-select")?.value;
      if (!eventId || !id) return;

      const confirmMsg = isExt
        ? `Remove guest "${name}" from this event?`
        : `Remove "${name}" from this event? This will revoke their QR ticket and cancel participation.`;

      const confirmed = await showConfirmDialog({
        titleKey: "common.delete_confirm_title",
        message: confirmMsg,
        confirmTextKey: "common.delete_btn",
        type: "danger"
      });
      if (!confirmed) return;

      try {
        await removeParticipant(eventId, id);
        await loadParticipants(eventId);
      } catch (err) {
        alert(err.message || "Failed to remove participant");
      }
    });
  });
}

async function loadParticipants(eventId) {
  try {
    const [attRes, eventRes] = await Promise.all([
      getAttendance(eventId).catch(() => ({ attendance: [] })),
      get(`/events/${eventId}?includeParticipants=true`).catch(() => ({ event: {} }))
    ]);

    const records = attRes?.attendance || [];
    const event = eventRes?.event || {};
    const eventParticipants = event?.participants || [];

    const combinedMap = new Map();

    records.forEach(r => {
      const isExt = r.isExternal === true || Boolean(r.externalParticipant) || r.user?.isExternal === true || (!r.user && Boolean(r.externalParticipant));
      if (isExt) {
        const extId = r._id;
        combinedMap.set(`ext_${extId}`, {
          _id: extId,
          attendanceId: r._id,
          fullname: r.externalParticipant?.fullname || r.user?.fullname || "Unknown",
          studentId: r.externalParticipant?.studentId || r.user?.studentId || "",
          email: r.externalParticipant?.email || r.user?.email || "",
          phoneNo: r.externalParticipant?.phoneNo || r.externalParticipant?.phone || r.user?.phoneNo || r.user?.phone || "",
          school: r.externalParticipant?.school || r.user?.school || "",
          class: r.externalParticipant?.class || r.user?.class || "",
          major: r.externalParticipant?.major || r.user?.major || "",
          isExternal: true,
          status: r.status || "absent",
          joinedAt: r.createdAt,
          notes: r.notes || r.note || ""
        });
      } else if (r.user) {
        const uid = r.user._id ? String(r.user._id) : `u_${r._id}`;
        combinedMap.set(`user_${uid}`, {
          _id: r.user._id || r._id,
          attendanceId: r._id,
          fullname: r.user.fullname || "Unknown",
          studentId: r.user.studentId || r.user.username || "",
          email: r.user.email || "",
          phoneNo: r.user.phoneNo || r.user.phone || "",
          school: r.user.school || "",
          class: r.user.class || "",
          major: r.user.major || "",
          avatar: r.user.avatar || "",
          isExternal: false,
          status: r.status || "absent",
          joinedAt: r.createdAt,
          notes: r.notes || r.note || ""
        });
      }
    });

    if (Array.isArray(eventParticipants)) {
      for (const p of eventParticipants) {
        const uid = typeof p === 'object' && p._id ? String(p._id) : String(p);
        if (combinedMap.has(`user_${uid}`)) {
          // Enrich missing user details from populated event.participants
          const existing = combinedMap.get(`user_${uid}`);
          if (typeof p === 'object' && p._id) {
            if (!existing.avatar && p.avatar) existing.avatar = p.avatar;
            if ((!existing.fullname || existing.fullname === 'Unknown') && p.fullname) existing.fullname = p.fullname;
            if (!existing.studentId && (p.studentId || p.username)) existing.studentId = p.studentId || p.username;
            if (!existing.email && p.email) existing.email = p.email;
            if (!existing.school && p.school) existing.school = p.school;
            if (!existing.class && p.class) existing.class = p.class;
            if (!existing.major && p.major) existing.major = p.major;
          }
        } else {
          if (typeof p === 'object' && p._id) {
            combinedMap.set(`user_${uid}`, {
              _id: p._id,
              fullname: p.fullname || "Unknown",
              studentId: p.studentId || p.username || "",
              email: p.email || "",
              phoneNo: p.phoneNo || p.phone || "",
              school: p.school || "",
              class: p.class || "",
              major: p.major || "",
              avatar: p.avatar || "",
              isExternal: false,
              status: "absent",
              joinedAt: p.joinedAt || event.createdAt,
              notes: ""
            });
          }
        }
      }
    }

    currentParticipantsList = Array.from(combinedMap.values());
    currentEvent = event || {};
    const countEl = document.getElementById("participant-count");
    if (countEl) countEl.textContent = currentParticipantsList.length;

    const searchInput = document.getElementById("participants-search-input");
    const q = searchInput?.value?.toLowerCase().trim() || "";
    if (q) {
      const filtered = currentParticipantsList.filter(p => {
        const fn = (p.fullname || "").toLowerCase();
        const em = (p.email || "").toLowerCase();
        const sid = (p.studentId || "").toLowerCase();
        return fn.includes(q) || em.includes(q) || sid.includes(q);
      });
      renderParticipantsTable(filtered);
    } else {
      renderParticipantsTable(currentParticipantsList);
    }
  } catch (err) {
    console.error("Load participants error:", err);
  }
}

// ─── Participant List PDF Export ───

function escapePdfHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let pdfExportColumns = [];

function getDefaultPdfExportColumns() {
  const lang = getLang();
  return [
    { id: "stt", key: "stt", name: lang === "vi" ? "STT" : "No.", type: "system", w: 12, minW: 8, maxW: 24 },
    { id: "studentId", key: "studentId", name: lang === "vi" ? "Mã sinh viên" : "Student ID", type: "system", w: 28, minW: 18, maxW: 50 },
    { id: "fullname", key: "fullname", name: lang === "vi" ? "Họ và tên" : "Full Name", type: "system", w: 48, minW: 25, maxW: 90 },
    { id: "email", key: "email", name: "Email", type: "system", w: 45, minW: 25, maxW: 90 },
    { id: "note", key: "note", name: lang === "vi" ? "Ghi chú" : "Notes", type: "custom", isDefault: true, w: 38, minW: 18, maxW: 90 },
  ];
}

// Extract column value from participant object
function getParticipantColValue(p, col, idx, lang) {
  const key = col.key || col.id;
  if (key === "stt" || col.id === "stt") {
    return String(idx + 1);
  }
  if (key === "studentId" || col.id === "studentId") {
    return p.studentId || "—";
  }
  if (key === "fullname" || col.id === "fullname") {
    return p.fullname || "—";
  }
  if (key === "email" || col.id === "email") {
    return p.email || "—";
  }
  if (key === "phoneNo" || col.id === "phoneNo" || key === "phone") {
    return p.phoneNo || p.phone || "—";
  }
  if (key === "school" || col.id === "school") {
    return p.school || "—";
  }
  if (key === "class" || col.id === "class") {
    return p.class || "—";
  }
  if (key === "major" || col.id === "major") {
    return p.major || "—";
  }
  if (key === "status" || col.id === "status") {
    const isAttended = p.status === "attended" || p.status === "present";
    return isAttended ? (lang === "vi" ? "Có mặt" : "Present") : (lang === "vi" ? "Vắng mặt" : "Absent");
  }
  if (key === "note" || col.id === "note") {
    return (p.notes && p.notes.trim()) ? p.notes : "";
  }
  // Custom columns left blank for physical handwriting/checking
  return "";
}

// Safe Dynamic CDN / Window Loader for jsPDF & AutoTable
function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true" || window.jspdf) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", (e) => reject(e));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      s.dataset.loaded = "true";
      resolve();
    };
    s.onerror = (err) => reject(err);
    document.head.appendChild(s);
  });
}

async function getJsPDF() {
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
  await loadExternalScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
  return window.jspdf?.jsPDF;
}

async function getAutoTable() {
  if (typeof window.jspdf?.jsPDF?.prototype?.autoTable === "function" || window.jspdf?.autoTable) return true;
  await loadExternalScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js");
  return true;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

let cachedPlusJakartaRegularBase64 = null;
let cachedPlusJakartaBoldBase64 = null;
let cachedAleoBoldBase64 = null;
let cachedRobotoRegularBase64 = null;

async function setupJsPDFFonts(doc) {
  try {
    if (!cachedPlusJakartaRegularBase64 || !cachedPlusJakartaBoldBase64 || !cachedAleoBoldBase64) {
      const [regularRes, boldRes, aleoRes] = await Promise.all([
        fetch("/fonts/PlusJakartaSans-Regular.ttf").then(r => {
          if (!r.ok) throw new Error("PlusJakartaSans-Regular font not found");
          return r.arrayBuffer();
        }),
        fetch("/fonts/PlusJakartaSans-Bold.ttf").then(r => {
          if (!r.ok) throw new Error("PlusJakartaSans-Bold font not found");
          return r.arrayBuffer();
        }),
        fetch("/fonts/Aleo-Bold.ttf").then(r => {
          if (!r.ok) throw new Error("Aleo-Bold font not found");
          return r.arrayBuffer();
        })
      ]);
      cachedPlusJakartaRegularBase64 = arrayBufferToBase64(regularRes);
      cachedPlusJakartaBoldBase64 = arrayBufferToBase64(boldRes);
      cachedAleoBoldBase64 = arrayBufferToBase64(aleoRes);
    }

    doc.addFileToVFS("PlusJakartaSans-Regular.ttf", cachedPlusJakartaRegularBase64);
    doc.addFont("PlusJakartaSans-Regular.ttf", "PlusJakartaSans", "normal");

    doc.addFileToVFS("PlusJakartaSans-Bold.ttf", cachedPlusJakartaBoldBase64);
    doc.addFont("PlusJakartaSans-Bold.ttf", "PlusJakartaSans", "bold");

    doc.addFileToVFS("Aleo-Bold.ttf", cachedAleoBoldBase64);
    doc.addFont("Aleo-Bold.ttf", "Aleo", "bold");

    doc.setFont("PlusJakartaSans", "normal");
    return { fontName: "PlusJakartaSans", logoFont: "Aleo" };
  } catch (err) {
    console.warn("Could not load PlusJakartaSans, attempting fallback:", err);
    try {
      if (!cachedRobotoRegularBase64) {
        const robotoRes = await fetch("/fonts/Roboto-Regular.ttf").then(r => r.arrayBuffer());
        cachedRobotoRegularBase64 = arrayBufferToBase64(robotoRes);
      }
      doc.addFileToVFS("Roboto-Regular.ttf", cachedRobotoRegularBase64);
      doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
      doc.setFont("Roboto", "normal");
      return { fontName: "Roboto", logoFont: "Roboto" };
    } catch {
      doc.setFont("helvetica", "normal");
      return { fontName: "helvetica", logoFont: "helvetica" };
    }
  }
}

function openPdfExportModal() {
  const ps = document.getElementById("participant-event-select");
  const eventId = ps?.value;
  if (!eventId) {
    alert(t("org_dashboard.pdf_no_participants", "Please select an event first."));
    return;
  }
  if (!currentParticipantsList || currentParticipantsList.length === 0) {
    alert(t("org_dashboard.pdf_no_participants", "No participants to export for this event."));
    return;
  }

  const overlay = document.getElementById("pdf-export-overlay");
  if (!overlay) return;

  // Initialize columns with default columns (including default "Ghi chú" column and default widths)
  pdfExportColumns = getDefaultPdfExportColumns();

  const colInput = document.getElementById("pdf-new-column-input");
  if (colInput) colInput.value = "";

  updatePdfModalHeaderInfo();
  renderPdfColumnChips();
  renderPdfPreviewDoc();
  updatePdfFooterInfo();

  overlay.removeAttribute("hidden");
  requestAnimationFrame(() => overlay.classList.add("active"));
  document.body.style.overflow = "hidden";
}

function closePdfExportModal() {
  const overlay = document.getElementById("pdf-export-overlay");
  if (!overlay) return;
  overlay.classList.remove("active");
  document.body.style.overflow = "";
  setTimeout(() => overlay.setAttribute("hidden", ""), 200);
}

function updatePdfModalHeaderInfo() {
  const event = currentEvent || {};
  const org = currentOrgs.find(o => o._id === currentOrgId) || {};
  const lang = getLang();

  const eventNameEl = document.getElementById("pdf-modal-event-name");
  if (eventNameEl) eventNameEl.textContent = event.title || (lang === "vi" ? "Sự kiện" : "Event");

  const countEl = document.getElementById("pdf-modal-participant-count");
  if (countEl) countEl.textContent = `${currentParticipantsList.length} ${lang === "vi" ? "người tham gia" : "participants"}`;

  const docOrgEl = document.getElementById("pdf-doc-org-name");
  if (docOrgEl) docOrgEl.textContent = org.name || "SpringWave Organization";

  const docEventTitleEl = document.getElementById("pdf-doc-event-title");
  if (docEventTitleEl) docEventTitleEl.textContent = event.title || "—";

  const docHeldDateEl = document.getElementById("pdf-doc-held-date");
  if (docHeldDateEl) docHeldDateEl.textContent = event.heldDate ? formatDate(event.heldDate) : "—";

  const docLocEl = document.getElementById("pdf-doc-location");
  if (docLocEl) docLocEl.textContent = event.location || event.address || "—";

  const docCountEl = document.getElementById("pdf-doc-count");
  if (docCountEl) docCountEl.textContent = `${currentParticipantsList.length} ${lang === "vi" ? "người" : "people"}`;

  const docDateEl = document.getElementById("pdf-doc-date");
  if (docDateEl) {
    const now = new Date();
    docDateEl.textContent = now.toLocaleDateString(lang === "vi" ? "vi-VN" : "en-US") + " " + now.toLocaleTimeString(lang === "vi" ? "vi-VN" : "en-US", { hour: "2-digit", minute: "2-digit" });
  }
}

function handleMovePdfColumn(colId, direction) {
  const index = pdfExportColumns.findIndex(c => c.id === colId);
  if (index < 0) return;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= pdfExportColumns.length) return;

  const temp = pdfExportColumns[index];
  pdfExportColumns[index] = pdfExportColumns[targetIndex];
  pdfExportColumns[targetIndex] = temp;

  renderPdfColumnChips();
  renderPdfPreviewDoc();
}

function handleRenamePdfColumn(colId) {
  const target = pdfExportColumns.find(c => c.id === colId);
  if (!target) return;
  const lang = getLang();
  const promptText = lang === "vi" ? `Nhập tên mới cho cột "${target.name}":` : `Enter new name for column "${target.name}":`;
  const newName = prompt(promptText, target.name);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed) {
    alert(t("org_dashboard.pdf_col_error_empty", "Column name cannot be empty."));
    return;
  }
  target.name = trimmed;
  renderPdfColumnChips();
  renderPdfPreviewDoc();
}

function handleAdjustPdfColWidth(colId, delta) {
  const target = pdfExportColumns.find(c => c.id === colId);
  if (!target) return;
  const currentW = target.w || 40;
  const min = target.minW || 10;
  const max = target.maxW || 120;
  const newW = Math.max(min, Math.min(max, currentW + delta));
  if (newW !== currentW) {
    target.w = newW;
    renderPdfColumnChips();
    renderPdfPreviewDoc();
  }
}

function handleDeletePdfColumn(colId) {
  if (pdfExportColumns.length <= 1) {
    alert(getLang() === "vi" ? "Cần giữ lại ít nhất 1 cột trong danh sách." : "You must keep at least 1 column.");
    return;
  }
  pdfExportColumns = pdfExportColumns.filter(c => c.id !== colId);
  renderPdfColumnChips();
  renderPdfPreviewDoc();
  updatePdfFooterInfo();
}

function handleAddPdfCustomColumn(colName, colKey, defaultW) {
  const trimmed = (colName || "").trim();
  if (!trimmed) {
    alert(t("org_dashboard.pdf_col_error_empty", "Column name cannot be empty."));
    return false;
  }

  const exists = pdfExportColumns.some(c => c.name.toLowerCase() === trimmed.toLowerCase());
  if (exists) {
    alert(t("org_dashboard.pdf_col_error_dup", "This column name already exists."));
    return false;
  }

  if (pdfExportColumns.length >= 10) {
    alert(t("org_dashboard.pdf_col_limit", "Maximum number of columns reached (10)."));
    return false;
  }

  // Detect key if not provided
  let key = colKey || "custom";
  let w = defaultW || 40;
  let type = "custom";

  const lower = trimmed.toLowerCase();
  if (!colKey) {
    if (lower.includes("sđt") || lower.includes("số điện thoại") || lower.includes("phone")) {
      key = "phoneNo";
      w = 38;
      type = "system";
    } else if (lower.includes("trường") || lower.includes("school") || lower.includes("university")) {
      key = "school";
      w = 50;
      type = "system";
    } else if (lower.includes("lớp") || lower.includes("class")) {
      key = "class";
      w = 28;
      type = "system";
    } else if (lower.includes("ngành") || lower.includes("chuyên ngành") || lower.includes("major")) {
      key = "major";
      w = 45;
      type = "system";
    } else if (lower.includes("trạng thái") || lower.includes("status")) {
      key = "status";
      w = 32;
      type = "system";
    }
  }

  const newId = `col_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pdfExportColumns.push({
    id: newId,
    key: key,
    name: trimmed,
    type: type,
    w: w,
    minW: 10,
    maxW: 120
  });

  renderPdfColumnChips();
  renderPdfPreviewDoc();
  updatePdfFooterInfo();
  return true;
}

function renderPdfColumnChips() {
  const container = document.getElementById("pdf-column-chips-container");
  if (!container) return;

  const total = pdfExportColumns.length;
  const lang = getLang();

  container.innerHTML = pdfExportColumns.map((col, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === total - 1;
    const isDbField = col.key && col.key !== "custom" && col.key !== "note";

    return `
      <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white border border-slate-200 shadow-2xs hover:border-slate-300 transition-all text-xs font-semibold text-slate-800">
        <!-- Reorder Left -->
        <button type="button" class="pdf-move-col-btn text-slate-400 hover:text-primary transition-all p-0 border-none bg-transparent cursor-pointer flex items-center justify-center ${isFirst ? 'opacity-20 cursor-not-allowed pointer-events-none' : ''}" data-id="${col.id}" data-dir="-1" title="${lang === 'vi' ? 'Di chuyển sang trái' : 'Move left'}">
          <i class="fa-solid fa-chevron-left text-[10px]"></i>
        </button>

        <!-- Column Name & Rename Trigger -->
        <button type="button" class="pdf-rename-col-btn inline-flex items-center gap-1 hover:text-primary transition-all border-none bg-transparent cursor-pointer p-0 text-xs font-bold text-slate-800" data-id="${col.id}" title="${lang === 'vi' ? 'Bấm để đổi tên cột' : 'Click to rename column'}">
          ${isDbField ? '<span class="w-1.5 h-1.5 rounded-full bg-sky-500 mr-0.5" title="Dữ liệu từ hệ thống"></span>' : ''}
          <span class="max-w-[110px] truncate">${escapePdfHtml(col.name)}</span>
          <i class="fa-solid fa-pen text-[9px] text-slate-400 hover:text-primary"></i>
        </button>

        <!-- Width Stepper -->
        <div class="inline-flex items-center gap-0.5 bg-slate-100 px-1 py-0.5 rounded-md text-[10px] border border-slate-200/60 select-none">
          <button type="button" class="pdf-width-btn w-3.5 h-3.5 rounded text-[10px] font-bold text-slate-600 hover:bg-white hover:text-primary transition-all flex items-center justify-center border-none cursor-pointer leading-none p-0" data-id="${col.id}" data-delta="-5" title="${lang === 'vi' ? 'Giảm độ rộng' : 'Decrease width'}">-</button>
          <span class="font-mono font-bold text-primary min-w-[24px] text-center">${col.w || 40}mm</span>
          <button type="button" class="pdf-width-btn w-3.5 h-3.5 rounded text-[10px] font-bold text-slate-600 hover:bg-white hover:text-primary transition-all flex items-center justify-center border-none cursor-pointer leading-none p-0" data-id="${col.id}" data-delta="5" title="${lang === 'vi' ? 'Tăng độ rộng' : 'Increase width'}">+</button>
        </div>

        <!-- Reorder Right -->
        <button type="button" class="pdf-move-col-btn text-slate-400 hover:text-primary transition-all p-0 border-none bg-transparent cursor-pointer flex items-center justify-center ${isLast ? 'opacity-20 cursor-not-allowed pointer-events-none' : ''}" data-id="${col.id}" data-dir="1" title="${lang === 'vi' ? 'Di chuyển sang phải' : 'Move right'}">
          <i class="fa-solid fa-chevron-right text-[10px]"></i>
        </button>

        <!-- Delete / Remove -->
        <button type="button" class="pdf-remove-col-btn text-slate-400 hover:text-red-600 ml-0.5 border-none bg-transparent cursor-pointer p-0 text-xs flex items-center justify-center" data-id="${col.id}" title="${lang === 'vi' ? 'Xóa cột' : 'Remove column'}">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `;
  }).join("");

  // Attach event listeners
  container.querySelectorAll(".pdf-move-col-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const dir = parseInt(btn.dataset.dir, 10) || 0;
      handleMovePdfColumn(id, dir);
    });
  });

  container.querySelectorAll(".pdf-rename-col-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      handleRenamePdfColumn(id);
    });
  });

  container.querySelectorAll(".pdf-width-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const delta = parseInt(btn.dataset.delta, 10) || 0;
      handleAdjustPdfColWidth(id, delta);
    });
  });

  container.querySelectorAll(".pdf-remove-col-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      handleDeletePdfColumn(id);
    });
  });
}

function renderPdfPreviewDoc() {
  const theadRow = document.getElementById("pdf-table-header-row");
  const tbody = document.getElementById("pdf-table-body");
  if (!theadRow || !tbody) return;

  const lang = getLang();

  theadRow.innerHTML = pdfExportColumns.map(col => {
    const key = col.key || col.id;
    const isStt = col.id === "stt" || key === "stt";
    const isCompact = isStt || key === "class" || key === "status" || key === "phoneNo";

    let thClasses = "py-2 px-2.5 text-xs font-bold border-r border-slate-700 last:border-r-0 uppercase tracking-wider select-none";
    if (isStt) {
      thClasses += " text-center w-12 shrink-0";
    } else if (isCompact) {
      thClasses += " text-left whitespace-nowrap shrink-0";
    } else {
      thClasses += " text-left";
    }

    return `
      <th class="${thClasses}">
        <div class="flex items-center ${isStt ? 'justify-center' : 'justify-between'} gap-1.5">
          <span class="truncate">${escapePdfHtml(col.name)}</span>
          <span class="text-[9px] font-mono font-normal text-slate-300 opacity-75 shrink-0">(${col.w || 40}mm)</span>
        </div>
      </th>
    `;
  }).join("");

  if (!currentParticipantsList || currentParticipantsList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${pdfExportColumns.length}" class="py-8 text-center text-slate-400 italic">
          ${t("org_dashboard.pdf_no_participants", "No participants to display.")}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = currentParticipantsList.map((p, idx) => {
    const isEven = idx % 2 === 1;
    const rowBg = isEven ? "bg-slate-50/70" : "bg-white";

    return `
      <tr class="${rowBg} border-b border-slate-200">
        ${pdfExportColumns.map(col => {
      const val = getParticipantColValue(p, col, idx, lang);
      const key = col.key || col.id;
      const isStt = col.id === "stt" || key === "stt";
      const isStudentId = col.id === "studentId" || key === "studentId";
      const isFullname = col.id === "fullname" || key === "fullname";
      const isEmail = col.id === "email" || key === "email";
      const isCompact = isStt || key === "class" || key === "phoneNo" || key === "status";

      let tdClass = "py-1.5 px-2.5 text-xs border-r border-slate-200 last:border-r-0";
      if (isStt) {
        tdClass += " text-center text-slate-500 font-mono w-12 shrink-0";
      } else if (isStudentId) {
        tdClass += " font-mono font-semibold text-slate-800 whitespace-nowrap shrink-0";
      } else if (isFullname) {
        tdClass += " font-medium text-slate-900";
      } else if (isEmail) {
        tdClass += " text-slate-600 truncate max-w-[200px]";
      } else if (isCompact) {
        tdClass += " text-slate-700 whitespace-nowrap shrink-0";
      } else {
        tdClass += " text-slate-700";
      }

      return `<td class="${tdClass}">${escapePdfHtml(val)}</td>`;
    }).join("")}
      </tr>
    `;
  }).join("");
}

function updatePdfFooterInfo() {
  const footerInfo = document.getElementById("pdf-footer-info");
  if (!footerInfo) return;
  const lang = getLang();
  const pCount = currentParticipantsList ? currentParticipantsList.length : 0;
  footerInfo.textContent = `${pCount} ${lang === "vi" ? "người tham gia" : "participants"} • ${pdfExportColumns.length} ${lang === "vi" ? "cột" : "columns"}`;
}

async function generateAndDownloadPdf() {
  const btn = document.getElementById("pdf-download-action-btn");
  if (!btn) return;
  const originalHtml = btn.innerHTML;

  try {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-xs"></i> <span>${t("org_dashboard.pdf_loading", "Generating PDF...")}</span>`;

    const jsPDFClass = await getJsPDF();
    if (!jsPDFClass) throw new Error("Could not load jsPDF library");
    await getAutoTable();

    const doc = new jsPDFClass({
      orientation: "landscape",
      unit: "mm",
      format: "a4",
      compress: true,
    });

    const fonts = await setupJsPDFFonts(doc);
    const fontName = fonts.fontName;
    const logoFont = fonts.logoFont;

    const event = currentEvent || {};
    const org = currentOrgs.find(o => o._id === currentOrgId) || {};
    const lang = getLang();

    const cleanEventName = (event.title || "Event")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_");
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${cleanEventName}_DanhSachThamGia_${dateStr}.pdf`;

    doc.setProperties({
      title: `${event.title || "Participant_List"} - SpringWave`,
      subject: "SpringWave Participant List Export",
      author: org.name || "SpringWave Organization",
      creator: "SpringWave Platform",
    });

    // Clean headers & body (WITHOUT any UI width hints like "(12mm)")
    const head = [pdfExportColumns.map(c => c.name)];
    const body = (currentParticipantsList || []).map((p, idx) => {
      return pdfExportColumns.map(col => getParticipantColValue(p, col, idx, lang));
    });

    const pageW = 297;
    const margin = 14;
    const usableW = pageW - margin * 2; // 269mm

    // Draw header on the first page
    const drawDocumentHeader = (docInstance) => {
      // 1. SpringWave Logo with authentic Aleo typography
      docInstance.setFont(logoFont, "bold");
      docInstance.setFontSize(14);
      docInstance.setTextColor(23, 85, 186); // #1755ba
      docInstance.text("Spring", margin, 14.5);
      const springW = docInstance.getTextWidth("Spring");

      docInstance.setTextColor(2, 132, 199); // #0284c7
      docInstance.text("Wave", margin + springW, 14.5);
      const waveW = docInstance.getTextWidth("Wave");

      // Separator dot & Org Name
      docInstance.setFont(fontName, "normal");
      docInstance.setFontSize(11);
      docInstance.setTextColor(203, 213, 225); // #cbd5e1
      docInstance.text("•", margin + springW + waveW + 3, 14.5);

      docInstance.setFont(fontName, "bold");
      docInstance.setFontSize(9.5);
      docInstance.setTextColor(100, 116, 139); // #64748b
      const maxOrgW = usableW - (springW + waveW + 10) - 75;
      const orgNameStr = docInstance.splitTextToSize(org.name || "SpringWave Organization", maxOrgW)[0] || "";
      docInstance.text(orgNameStr, margin + springW + waveW + 7, 14.5);

      // Title
      const titleText = lang === "vi" ? "DANH SÁCH NGƯỜI THAM GIA" : "PARTICIPANT LIST";
      docInstance.setFont(fontName, "bold");
      docInstance.setFontSize(13);
      docInstance.setTextColor(15, 23, 42); // #0f172a
      docInstance.text(titleText, margin, 23.5);

      // Export Date (Right aligned)
      const now = new Date();
      const exportDateStr = (lang === "vi" ? "Ngày xuất: " : "Export Date: ") +
        now.toLocaleDateString(lang === "vi" ? "vi-VN" : "en-US") + " " +
        now.toLocaleTimeString(lang === "vi" ? "vi-VN" : "en-US", { hour: "2-digit", minute: "2-digit" });
      docInstance.setFont(fontName, "normal");
      docInstance.setFontSize(8);
      docInstance.setTextColor(148, 163, 184); // #94a3b8
      docInstance.text(exportDateStr, pageW - margin, 14.5, { align: "right" });

      // Meta Info Card (Dynamically expanding for long Location / Event title)
      const cardY = 26.5;
      const w1 = Math.round(usableW * 0.32 * 10) / 10; // Event: 32% (86mm)
      const w2 = Math.round(usableW * 0.20 * 10) / 10; // Date: 20% (53.8mm)
      const w3 = Math.round(usableW * 0.34 * 10) / 10; // Location: 34% (91.4mm)
      const w4 = usableW - (w1 + w2 + w3);            // Participants: 14% (37.8mm)

      const eventTitle = event.title || "—";
      const heldDate = event.heldDate ? formatDate(event.heldDate) : "—";
      const location = event.location || event.address || "—";
      const pCount = `${(currentParticipantsList || []).length} ${lang === "vi" ? "người" : "people"}`;

      // Measure multi-line wrapping
      docInstance.setFont(fontName, "bold");
      docInstance.setFontSize(8.5);
      const eventLines = docInstance.splitTextToSize(eventTitle, w1 - 8);

      docInstance.setFont(fontName, "normal");
      docInstance.setFontSize(8.5);
      const locLines = docInstance.splitTextToSize(location, w3 - 8);

      const maxLines = Math.max(eventLines.length, locLines.length, 1);
      const lineHeight = 4.0;
      const dynamicCardH = Math.max(16, 12.5 + (maxLines - 1) * lineHeight);

      // Card Background & Border
      docInstance.setFillColor(248, 250, 252); // #f8fafc
      docInstance.setDrawColor(226, 232, 240); // #e2e8f0
      docInstance.setLineWidth(0.35);
      docInstance.roundedRect(margin, cardY, usableW, dynamicCardH, 2.5, 2.5, "FD");

      // Column 1: Event
      const col1X = margin;
      docInstance.setFont(fontName, "bold");
      docInstance.setFontSize(7);
      docInstance.setTextColor(148, 163, 184);
      docInstance.text(lang === "vi" ? "SỰ KIỆN" : "EVENT", col1X + 4, cardY + 5.2);

      docInstance.setFont(fontName, "bold");
      docInstance.setFontSize(8.5);
      docInstance.setTextColor(30, 41, 59);
      eventLines.forEach((line, i) => {
        docInstance.text(line, col1X + 4, cardY + 10.8 + (i * lineHeight));
      });

      // Column 2: Date
      const col2X = margin + w1;
      docInstance.setFont(fontName, "bold");
      docInstance.setFontSize(7);
      docInstance.setTextColor(148, 163, 184);
      docInstance.text(lang === "vi" ? "THỜI GIAN" : "DATE", col2X + 4, cardY + 5.2);

      docInstance.setFont(fontName, "normal");
      docInstance.setFontSize(8.5);
      docInstance.setTextColor(51, 65, 85);
      docInstance.text(heldDate, col2X + 4, cardY + 10.8);

      // Column 3: Location
      const col3X = margin + w1 + w2;
      docInstance.setFont(fontName, "bold");
      docInstance.setFontSize(7);
      docInstance.setTextColor(148, 163, 184);
      docInstance.text(lang === "vi" ? "ĐỊA ĐIỂM" : "LOCATION", col3X + 4, cardY + 5.2);

      docInstance.setFont(fontName, "normal");
      docInstance.setFontSize(8.5);
      docInstance.setTextColor(51, 65, 85);
      locLines.forEach((line, i) => {
        docInstance.text(line, col3X + 4, cardY + 10.8 + (i * lineHeight));
      });

      // Column 4: Participant count
      const col4X = margin + w1 + w2 + w3;
      docInstance.setFont(fontName, "bold");
      docInstance.setFontSize(7);
      docInstance.setTextColor(148, 163, 184);
      docInstance.text(lang === "vi" ? "SỐ LƯỢNG" : "PARTICIPANTS", col4X + 4, cardY + 5.2);

      docInstance.setFont(fontName, "bold");
      docInstance.setFontSize(9);
      docInstance.setTextColor(16, 185, 129); // #10b981 emerald
      docInstance.text(pCount, col4X + 4, cardY + 10.8);

      return cardY + dynamicCardH;
    };

    const headerBottomY = drawDocumentHeader(doc);
    const tableStartY = headerBottomY + 3.5;

    // Dynamic Column styles setup with intelligent auto-shrink & balanced width distribution
    const totalConfiguredW = pdfExportColumns.reduce((sum, c) => sum + (Number(c.w) || 35), 0);

    const columnStyles = {};
    pdfExportColumns.forEach((col, idx) => {
      const key = col.key || col.id;
      const isStt = col.id === "stt" || key === "stt";
      const isStudentId = col.id === "studentId" || key === "studentId";
      const isFullname = col.id === "fullname" || key === "fullname";
      const isEmail = col.id === "email" || key === "email";
      const isPhone = key === "phoneNo" || col.id === "phoneNo" || key === "phone";
      const isClass = key === "class" || col.id === "class";
      const isStatus = key === "status" || col.id === "status";

      // Calculate auto-shrunk width proportionally fitting usable table width
      let colWidth = Math.round(((Number(col.w) || 35) / totalConfiguredW) * usableW * 10) / 10;

      // Smart upper/lower bounds for compact data cells
      if (isStt) {
        colWidth = Math.max(10, Math.min(13, colWidth));
      } else if (isClass) {
        colWidth = Math.max(16, Math.min(24, colWidth));
      } else if (isStudentId) {
        colWidth = Math.max(22, Math.min(30, colWidth));
      } else if (isPhone) {
        colWidth = Math.max(24, Math.min(32, colWidth));
      } else if (isStatus) {
        colWidth = Math.max(20, Math.min(28, colWidth));
      }

      const styleObj = { cellWidth: colWidth };
      if (isStt) {
        styleObj.halign = "center";
      } else if (isStudentId) {
        styleObj.fontStyle = "bold";
      } else if (isFullname) {
        styleObj.fontStyle = "bold";
      } else if (isEmail) {
        styleObj.textColor = [71, 85, 105];
      } else {
        styleObj.textColor = [15, 23, 42];
      }

      columnStyles[idx] = styleObj;
    });

    // Call AutoTable
    doc.autoTable({
      head: head,
      body: body,
      startY: tableStartY,
      margin: { left: margin, right: margin, bottom: 16, top: 16 },
      theme: "grid",
      styles: {
        font: fontName,
        fontSize: 8.5,
        cellPadding: { top: 2.2, bottom: 2.2, left: 2.5, right: 2.5 },
        lineColor: [226, 232, 240], // #e2e8f0
        lineWidth: 0.15,
        textColor: [15, 23, 42], // #0f172a
        overflow: "linebreak",
        valign: "middle",
      },
      headStyles: {
        font: fontName,
        fontStyle: "bold",
        fontSize: 8.5,
        fillColor: [30, 41, 59], // #1e293b slate 800
        textColor: [255, 255, 255],
        lineWidth: 0.15,
        lineColor: [51, 65, 85],
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252], // #f8fafc
      },
      columnStyles: columnStyles,
      showHead: "everyPage",
      didDrawPage: (data) => {
        // Redraw minimal header on page 2+
        if (data.pageNumber > 1) {
          doc.setFont(fontName, "bold");
          doc.setFontSize(8);
          doc.setTextColor(100, 116, 139);
          doc.text(`SpringWave • ${event.title || "Event"} - ${lang === "vi" ? "Danh sách người tham gia" : "Participant List"}`, margin, 10);
        }

        // Page footer on every page
        doc.setFont(fontName, "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(148, 163, 184);
        doc.text("SpringWave Platform • https://springwave.io", margin, 203);

        const pageStr = `${lang === "vi" ? "Trang" : "Page"} ${data.pageNumber}`;
        doc.text(pageStr, pageW - margin, 203, { align: "right" });
      },
    });

    doc.save(filename);
    closePdfExportModal();
  } catch (err) {
    console.error("PDF generation error:", err);
    alert(t("org_dashboard.pdf_export_error", "Could not generate PDF. Please try again."));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

function initPdfExportButtons() {
  const exportBtn = document.getElementById("pdf-export-btn");
  exportBtn?.addEventListener("click", openPdfExportModal);

  document.getElementById("pdf-export-close-btn")?.addEventListener("click", closePdfExportModal);
  document.getElementById("pdf-export-cancel-btn")?.addEventListener("click", closePdfExportModal);
  document.getElementById("pdf-export-backdrop")?.addEventListener("click", closePdfExportModal);

  const addBtn = document.getElementById("pdf-add-column-btn");
  const colInput = document.getElementById("pdf-new-column-input");

  const onAddCol = () => {
    if (colInput && handleAddPdfCustomColumn(colInput.value)) {
      colInput.value = "";
    }
  };

  addBtn?.addEventListener("click", onAddCol);
  colInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onAddCol();
    }
  });

  document.querySelectorAll(".pdf-col-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const colName = btn.dataset.col;
      const colKey = btn.dataset.key;
      const colW = parseInt(btn.dataset.w, 10) || 40;
      if (colName) handleAddPdfCustomColumn(colName, colKey, colW);
    });
  });

  document.getElementById("pdf-download-action-btn")?.addEventListener("click", generateAndDownloadPdf);
}

function updatePdfExportButton() {
  const btn = document.getElementById("pdf-export-btn");
  const ps = document.getElementById("participant-event-select");
  if (!btn || !ps) return;
  const hasEvent = Boolean(ps.value);
  btn.disabled = !hasEvent;
  btn.classList.toggle("opacity-50", !hasEvent);
  btn.classList.toggle("cursor-not-allowed", !hasEvent);
}



function openEditExternalModal(attendanceId, fullname, studentId, email) {
  const overlay = document.getElementById("edit-ext-overlay");
  if (!overlay) return;

  document.getElementById("edit-ext-attendance-id").value = attendanceId;
  document.getElementById("edit-ext-fullname").value = fullname;
  document.getElementById("edit-ext-studentid").value = studentId;
  document.getElementById("edit-ext-email").value = email;

  overlay.removeAttribute("hidden");
  overlay.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeEditExternalModal() {
  const overlay = document.getElementById("edit-ext-overlay");
  if (!overlay) return;
  overlay.classList.remove("active");
  document.body.style.overflow = "";
  setTimeout(() => overlay.setAttribute("hidden", ""), 200);
}

function initEditExternalModal() {
  const closeBtn = document.getElementById("edit-ext-close-btn");
  const cancelBtn = document.getElementById("edit-ext-cancel-btn");
  const backdrop = document.getElementById("edit-ext-backdrop");
  const saveBtn = document.getElementById("edit-ext-save-btn");
  const deleteBtn = document.getElementById("edit-ext-delete-btn");

  [closeBtn, cancelBtn, backdrop].forEach(el => {
    el?.addEventListener("click", closeEditExternalModal);
  });

  saveBtn?.addEventListener("click", async () => {
    const eventId = document.getElementById("participant-event-select")?.value;
    const attendanceId = document.getElementById("edit-ext-attendance-id")?.value;
    const fullname = document.getElementById("edit-ext-fullname")?.value.trim();
    const studentId = document.getElementById("edit-ext-studentid")?.value.trim();
    const email = document.getElementById("edit-ext-email")?.value.trim();

    if (!eventId || !attendanceId) return;
    if (!fullname) return alert("Full Name is required.");
    if (!studentId) return alert("Student ID (MSSV) is required.");
    if (!email) return alert("Email is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return alert("Please enter a valid email address.");
    }

    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

    try {
      await updateExternalParticipant(eventId, attendanceId, { fullname, studentId, email });
      closeEditExternalModal();
      await loadParticipants(eventId);
    } catch (err) {
      alert(err.message || "Failed to update participant");
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `Save Changes`;
    }
  });

  deleteBtn?.addEventListener("click", async () => {
    const eventId = document.getElementById("participant-event-select")?.value;
    const attendanceId = document.getElementById("edit-ext-attendance-id")?.value;
    if (!eventId || !attendanceId) return;

    const confirmed = await showConfirmDialog({
      titleKey: "common.delete_confirm_title",
      messageKey: "org_dashboard.remove_participant_confirm",
      confirmTextKey: "common.delete_btn",
      type: "danger"
    });
    if (!confirmed) return;

    deleteBtn.disabled = true;
    try {
      await removeParticipant(eventId, attendanceId);
      closeEditExternalModal();
      await loadParticipants(eventId);
    } catch (err) {
      alert(err.message || "Failed to remove participant");
    } finally {
      deleteBtn.disabled = false;
    }
  });
}

// ─── Add / Import Participants Modal ───

let participantGridRows = [];

function openAddParticipantsModal() {
  const eventId = document.getElementById("participant-event-select")?.value;
  if (!eventId) {
    alert("Please select an event first before adding participants.");
    return;
  }

  const overlay = document.getElementById("add-participants-overlay");
  if (!overlay) return;

  switchAddParticipantsMode("manual");
  const banner = document.getElementById("parse-status-banner");
  if (banner) banner.classList.add("hidden");
  const modalInput = document.getElementById("modal-excel-input");
  if (modalInput) modalInput.value = "";
  const feedback = document.getElementById("add-participants-feedback");
  if (feedback) feedback.textContent = "";

  if (!participantGridRows.length) {
    participantGridRows = [
      { fullname: "", studentId: "", email: "" },
      { fullname: "", studentId: "", email: "" },
      { fullname: "", studentId: "", email: "" }
    ];
  }
  renderParticipantGridRows();

  overlay.removeAttribute("hidden");
  overlay.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeAddParticipantsModal() {
  const overlay = document.getElementById("add-participants-overlay");
  if (!overlay) return;
  overlay.classList.remove("active");
  document.body.style.overflow = "";
  setTimeout(() => overlay.setAttribute("hidden", ""), 200);
}

function switchAddParticipantsMode(mode) {
  const manualBtn = document.getElementById("mode-manual-btn");
  const excelBtn = document.getElementById("mode-excel-btn");
  const excelSection = document.getElementById("excel-import-section");

  if (mode === "manual") {
    manualBtn?.classList.add("bg-primary", "text-white", "shadow-xs");
    manualBtn?.classList.remove("border", "border-[#e2e2eb]", "bg-white", "text-[#64748b]");
    excelBtn?.classList.remove("bg-primary", "text-white", "shadow-xs");
    excelBtn?.classList.add("border", "border-[#e2e2eb]", "bg-white", "text-[#64748b]");
    excelSection?.classList.add("hidden");
  } else {
    excelBtn?.classList.add("bg-primary", "text-white", "shadow-xs");
    excelBtn?.classList.remove("border", "border-[#e2e2eb]", "bg-white", "text-[#64748b]");
    manualBtn?.classList.remove("bg-primary", "text-white", "shadow-xs");
    manualBtn?.classList.add("border", "border-[#e2e2eb]", "bg-white", "text-[#64748b]");
    excelSection?.classList.remove("hidden");
  }
}

function syncGridRowsFromDOM() {
  const tbody = document.getElementById("add-participants-grid-body");
  if (!tbody) return;
  const rows = [];
  tbody.querySelectorAll("tr").forEach(tr => {
    const fn = tr.querySelector(".grid-fullname")?.value || "";
    const sid = tr.querySelector(".grid-studentid")?.value || "";
    const em = tr.querySelector(".grid-email")?.value || "";
    if (fn || sid || em) {
      rows.push({ fullname: fn, studentId: sid, email: em });
    }
  });
  if (rows.length > 0) {
    participantGridRows = rows;
  }
}

function renderParticipantGridRows() {
  const tbody = document.getElementById("add-participants-grid-body");
  const countBadge = document.getElementById("grid-row-count");
  if (!tbody) return;

  if (countBadge) countBadge.textContent = `${participantGridRows.length} rows`;

  if (!participantGridRows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-6 text-center text-slate-400 italic">No rows. Click "+ Add Row" or upload an Excel file above.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = participantGridRows.map((r, idx) => `
    <tr class="border-b border-[#ecedfa] hover:bg-slate-50/50">
      <td class="py-2 px-3 text-center text-slate-400 font-mono">${idx + 1}</td>
      <td class="py-2 px-3">
        <input class="grid-fullname w-full px-2.5 py-1.5 rounded-lg border border-[#e2e2eb] bg-white text-xs outline-none focus:border-primary transition-all font-medium text-slate-800" placeholder="e.g. Nguyen Van A" value="${(r.fullname || '').replace(/"/g, '&quot;')}" />
      </td>
      <td class="py-2 px-3">
        <input class="grid-studentid w-full px-2.5 py-1.5 rounded-lg border border-[#e2e2eb] bg-white text-xs outline-none focus:border-primary transition-all font-mono font-semibold text-slate-800" placeholder="e.g. 102200001" value="${(r.studentId || '').replace(/"/g, '&quot;')}" />
      </td>
      <td class="py-2 px-3">
        <input class="grid-email w-full px-2.5 py-1.5 rounded-lg border border-[#e2e2eb] bg-white text-xs outline-none focus:border-primary transition-all text-slate-700" placeholder="e.g. user@gmail.com" value="${(r.email || '').replace(/"/g, '&quot;')}" />
      </td>
      <td class="py-2 px-3 text-center">
        <button type="button" class="grid-remove-row-btn w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors border-none bg-transparent cursor-pointer" data-idx="${idx}">
          <i class="fa-solid fa-trash-can text-xs"></i>
        </button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".grid-remove-row-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      syncGridRowsFromDOM();
      const idx = parseInt(btn.dataset.idx);
      if (!isNaN(idx)) {
        participantGridRows.splice(idx, 1);
        renderParticipantGridRows();
      }
    });
  });

  tbody.querySelectorAll("input").forEach(input => {
    input.addEventListener("input", () => {
      const feedback = document.getElementById("add-participants-feedback");
      if (feedback) feedback.textContent = "";
    });
  });
}

function handleExcelFileSelect(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      if (!window.XLSX) {
        alert("Excel parser library is loading. Please try again in a moment.");
        return;
      }
      const data = new Uint8Array(e.target.result);
      const workbook = window.XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("Excel file contains no sheets");

      const sheet = workbook.Sheets[sheetName];
      const rawRows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      if (!rawRows || rawRows.length < 2) {
        throw new Error("Excel sheet must contain a header row and at least one participant row");
      }

      let headerIndex = 0;
      let headers = [];
      for (let i = 0; i < rawRows.length; i++) {
        const rowStr = rawRows[i].map(c => String(c).trim().toLowerCase()).join(" ");
        if (rowStr.length > 0) {
          headerIndex = i;
          headers = rawRows[i].map(c => String(c).trim().toLowerCase());
          break;
        }
      }

      const fullnameKeywords = ["họ và tên", "ho va ten", "họ tên", "ho ten", "fullname", "full_name", "name", "tên", "ten"];
      const studentIdKeywords = ["mã sinh viên", "ma sinh vien", "studentid", "student_id", "mssv", "mã sv", "ma sv", "stuid", "id"];
      const emailKeywords = ["email", "mail", "e-mail", "địa chỉ email", "dia chi email"];

      let fnCol = -1, sidCol = -1, emCol = -1;
      headers.forEach((h, idx) => {
        if (fnCol === -1 && fullnameKeywords.some(k => h.includes(k))) fnCol = idx;
        if (sidCol === -1 && studentIdKeywords.some(k => h.includes(k))) sidCol = idx;
        if (emCol === -1 && emailKeywords.some(k => h.includes(k))) emCol = idx;
      });

      if (fnCol === -1 && sidCol === -1 && emCol === -1) {
        fnCol = 0; sidCol = 1; emCol = 2;
      } else {
        if (fnCol === -1) fnCol = 0;
        if (sidCol === -1) sidCol = fnCol === 0 ? 1 : 0;
        if (emCol === -1) {
          for (let i = 0; i < headers.length; i++) {
            if (i !== fnCol && i !== sidCol) { emCol = i; break; }
          }
        }
      }

      const parsedRows = [];
      for (let i = headerIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row || row.every(cell => String(cell).trim() === "")) continue;

        const fn = fnCol >= 0 ? String(row[fnCol] || "").trim() : "";
        const sid = sidCol >= 0 ? String(row[sidCol] || "").trim() : "";
        const em = emCol >= 0 ? String(row[emCol] || "").trim() : "";

        if (fn || sid || em) {
          parsedRows.push({ fullname: fn, studentId: sid, email: em });
        }
      }

      if (!parsedRows.length) {
        throw new Error("No participant rows found in the selected file");
      }

      participantGridRows = parsedRows;
      renderParticipantGridRows();

      const banner = document.getElementById("parse-status-banner");
      const title = document.getElementById("parse-status-title");
      const desc = document.getElementById("parse-status-desc");
      if (banner && title && desc) {
        banner.classList.remove("hidden");
        title.textContent = `Successfully parsed ${parsedRows.length} participants!`;
        desc.textContent = `From file: ${file.name}. Review and modify the rows in the table below before clicking Save.`;
      }
    } catch (err) {
      alert(err.message || "Failed to parse Excel file");
    }
  };
  reader.readAsArrayBuffer(file);
}

function downloadSampleExcelTemplate() {
  if (!window.XLSX) {
    alert("Export library is loading, please try again in a moment.");
    return;
  }
  const headers = ["Họ và tên", "Mã sinh viên", "Email"];
  const sampleData = [
    headers,
    ["Nguyễn Văn An", "102200001", "an.nguyen@example.com"],
    ["Trần Thị Bình", "102200002", "binh.tran@example.com"],
    ["Lê Hoàng Cường", "102200003", "cuong.le@example.com"]
  ];

  const ws = window.XLSX.utils.aoa_to_sheet(sampleData);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "Participants");
  window.XLSX.writeFile(wb, "SpringWave_Participants_Template.xlsx");
}

function initAddParticipantsModal() {
  document.getElementById("open-add-participants-btn")?.addEventListener("click", openAddParticipantsModal);
  document.getElementById("add-participants-close-btn")?.addEventListener("click", closeAddParticipantsModal);
  document.getElementById("add-participants-cancel-btn")?.addEventListener("click", closeAddParticipantsModal);
  document.getElementById("add-participants-backdrop")?.addEventListener("click", closeAddParticipantsModal);

  document.getElementById("mode-manual-btn")?.addEventListener("click", () => switchAddParticipantsMode("manual"));
  document.getElementById("mode-excel-btn")?.addEventListener("click", () => switchAddParticipantsMode("excel"));

  const fileInput = document.getElementById("modal-excel-input");
  fileInput?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleExcelFileSelect(file);
  });

  document.getElementById("download-template-btn")?.addEventListener("click", downloadSampleExcelTemplate);

  document.getElementById("grid-add-row-btn")?.addEventListener("click", () => {
    syncGridRowsFromDOM();
    participantGridRows.push({ fullname: "", studentId: "", email: "" });
    renderParticipantGridRows();
    const container = document.querySelector("#add-participants-grid-body")?.closest(".overflow-y-auto");
    if (container) setTimeout(() => { container.scrollTop = container.scrollHeight; }, 50);
  });

  document.getElementById("grid-clear-btn")?.addEventListener("click", async () => {
    if (participantGridRows.length > 0) {
      const confirmed = await showConfirmDialog({
        titleKey: "common.confirm_title",
        messageKey: "org_dashboard.clear_grid_confirm",
        confirmTextKey: "common.confirm_btn",
        type: "warning"
      });
      if (!confirmed) return;
    }
    participantGridRows = [{ fullname: "", studentId: "", email: "" }];
    renderParticipantGridRows();
    const banner = document.getElementById("parse-status-banner");
    if (banner) banner.classList.add("hidden");
  });

  document.getElementById("save-participants-batch-btn")?.addEventListener("click", async () => {
    syncGridRowsFromDOM();
    const eventId = document.getElementById("participant-event-select")?.value;
    if (!eventId) return alert("Select an event first");

    const nonEmpties = participantGridRows.filter(r => (r.fullname && r.fullname.trim()) || (r.studentId && r.studentId.trim()) || (r.email && r.email.trim()));
    if (!nonEmpties.length) {
      return alert("Please enter at least one participant (Full Name, MSSV, and Email are required).");
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (let i = 0; i < nonEmpties.length; i++) {
      const row = nonEmpties[i];
      const fn = (row.fullname || '').trim();
      const sid = (row.studentId || '').trim();
      const em = (row.email || '').trim().toLowerCase();

      if (!fn) {
        return alert(`Row ${i + 1}: Full Name is required.`);
      }
      if (!sid) {
        return alert(`Row ${i + 1} (${fn}): Student ID (MSSV) is required.`);
      }
      if (!em) {
        return alert(`Row ${i + 1} (${fn}): Email is required.`);
      }
      if (!emailRegex.test(em)) {
        return alert(`Row ${i + 1} (${fn}): Invalid email format "${em}".`);
      }
    }

    const saveBtn = document.getElementById("save-participants-batch-btn");
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

    try {
      const res = await addParticipantsBatch(eventId, nonEmpties);
      const summary = res.summary || {};
      let msg = res.message || "Participants processed successfully!";

      const parts = [];
      if (summary.totalRows !== undefined) parts.push(`• Total processed: ${summary.totalRows}`);
      if (summary.matchedCount !== undefined) parts.push(`• SpringWave accounts matched (Member): ${summary.matchedCount}`);
      if (summary.externalCount !== undefined) parts.push(`• External guests created (Guest): ${summary.externalCount}`);

      if (parts.length) {
        msg += `\n\n` + parts.join("\n");
      }

      if (summary.matchedList && summary.matchedList.length) {
        msg += `\n\nSpringWave Members:\n- ` + summary.matchedList.slice(0, 5).join("\n- ");
        if (summary.matchedList.length > 5) msg += `\n... và ${summary.matchedList.length - 5} người khác`;
      }

      if (summary.externalList && summary.externalList.length) {
        msg += `\n\nExternal Guests (Editable ✏️):\n- ` + summary.externalList.slice(0, 5).join("\n- ");
        if (summary.externalList.length > 5) msg += `\n... và ${summary.externalList.length - 5} người khác`;
      }

      if (summary.errors && summary.errors.length) {
        msg += `\n\nWarnings:\n${summary.errors.slice(0, 5).join("\n")}`;
      }

      alert(msg);
      participantGridRows = [];
      closeAddParticipantsModal();
      await loadParticipants(eventId);
    } catch (err) {
      alert(err.message || "Failed to save participants");
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Participants`;
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("participants-search-input")?.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) {
      renderParticipantsTable(currentParticipantsList);
      return;
    }
    const filtered = currentParticipantsList.filter(p => {
      const fn = (p.fullname || "").toLowerCase();
      const em = (p.email || "").toLowerCase();
      const sid = (p.studentId || p.username || "").toLowerCase();
      const un = (p.username || "").toLowerCase();
      return fn.includes(q) || em.includes(q) || sid.includes(q) || un.includes(q);
    });
    renderParticipantsTable(filtered);
  });

  document.getElementById("attendance-search-input")?.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase().trim();
    const records = attendanceState.cachedAttendanceRecords || [];
    if (!q) {
      renderAttendanceTableRows(records, attendanceState.isCurrentEventPast);
      return;
    }
    const filtered = records.filter(r => {
      const u = r.user || {};
      const ext = r.externalParticipant || {};
      const fn = (u.fullname || ext.fullname || "").toLowerCase();
      const em = (u.email || "").toLowerCase();
      const sid = (u.studentId || u.username || ext.studentId || r.ticketCode || "").toLowerCase();
      const un = (u.username || "").toLowerCase();
      return fn.includes(q) || em.includes(q) || sid.includes(q) || un.includes(q);
    });
    renderAttendanceTableRows(filtered, attendanceState.isCurrentEventPast);
  });
});

// ─── Attendance ───

function initAttendanceEventSelect() {
  const wrapper = document.getElementById("attendance-event-select-wrapper");
  if (!wrapper || wrapper.dataset.attendanceInitialized === "true") return;
  wrapper.dataset.attendanceInitialized = "true";
  wrapper.addEventListener("change", (e) => {
    if (e.target.id === "attendance-event-select") {
      if (e.target.value) {
        loadAttendance(e.target.value);
      } else {
        document.getElementById("attendance-table-body").innerHTML = "";
        const scanQrBtn = document.getElementById("scan-qr-btn");
        const openOnlineCheckinBtn = document.getElementById("open-online-checkin-modal-btn");
        if (scanQrBtn) scanQrBtn.classList.add("hidden");
        if (openOnlineCheckinBtn) openOnlineCheckinBtn.classList.add("hidden");
        const empty = document.getElementById("attendance-empty");
        if (empty) {
          empty.classList.remove("hidden");
          empty.innerHTML = `<i class="fa-solid fa-qrcode text-4xl mb-3 block"></i>
            <p class="text-base font-semibold">Select an event to view attendance</p>`;
        }
        const statsGrid = document.querySelector("#section-attendance .grid.grid-cols-1");
        const actionBtns = document.querySelector("#section-attendance .flex.gap-3.mb-6");
        const attendanceListHeader = document.querySelector("#section-attendance .px-6.py-4");
        const attendanceTable = document.querySelector("#section-attendance .overflow-x-auto");
        if (statsGrid) statsGrid.style.opacity = "1";
        if (actionBtns) actionBtns.style.opacity = "1";
        if (attendanceListHeader) attendanceListHeader.style.opacity = "1";
        if (attendanceTable) attendanceTable.style.opacity = "1";
      }
    }
  });
}

let attendanceCache = {
  eventId: null,
  records: [],
  lookupMap: new Map(),
  eventRules: { lateCheckinMinutes: 0, expiredCheckinMinutes: 0, heldDate: null },
  isPastEvent: false
};

let backgroundQueue = [];
let totalQueueEnqueued = 0;
let totalQueueProcessed = 0;
let isProcessingQueue = false;

function updateQueueBadgeUI() {
  const badge = document.getElementById("queue-status-badge");
  const dot = document.getElementById("queue-status-dot");
  const text = document.getElementById("queue-status-text");
  if (!badge || !text) return;

  if (totalQueueEnqueued === 0) {
    badge.classList.add("opacity-0", "translate-x-[calc(100%+24px)]", "pointer-events-none");
    badge.classList.remove("opacity-100", "translate-x-0");
    return;
  }

  void badge.offsetWidth;
  badge.classList.remove("opacity-0", "translate-x-[calc(100%+24px)]", "pointer-events-none");
  badge.classList.add("opacity-100", "translate-x-0");

  const pending = backgroundQueue.length;
  if (pending > 0) {
    if (dot) dot.className = "w-2 h-2 rounded-full bg-amber-400 animate-pulse";
    text.textContent = `Sync: ${totalQueueProcessed}/${totalQueueEnqueued}`;
  } else {
    if (dot) dot.className = "w-2 h-2 rounded-full bg-emerald-400";
    text.textContent = `Synced ${totalQueueProcessed}/${totalQueueEnqueued}`;
    setTimeout(() => {
      if (backgroundQueue.length === 0) {
        totalQueueEnqueued = 0;
        totalQueueProcessed = 0;
        updateQueueBadgeUI();
      }
    }, 4000);
  }
}

async function processBackgroundQueue() {
  if (isProcessingQueue || backgroundQueue.length === 0) return;
  isProcessingQueue = true;

  while (backgroundQueue.length > 0) {
    const job = backgroundQueue[0];
    updateQueueBadgeUI();

    let success = false;
    try {
      await scanAttendance(job.eventId, job.code);
      success = true;
    } catch (err) {
      console.warn(`Background checkin attempt ${(job.attempts || 0) + 1} failed:`, err);
      job.attempts = (job.attempts || 0) + 1;
      if (job.attempts < 3) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    }

    backgroundQueue.shift();
    totalQueueProcessed++;
    updateQueueBadgeUI();
  }

  isProcessingQueue = false;

  if (attendanceCache.eventId) {
    loadAttendance(attendanceCache.eventId).catch(() => { });
  }
}

function rebuildAttendanceCache(eventId, records, event, isPastEvent) {
  attendanceCache.eventId = eventId;
  attendanceCache.records = records;
  attendanceCache.isPastEvent = isPastEvent;
  attendanceCache.eventRules = {
    lateCheckinMinutes: event.lateCheckinMinutes || 0,
    expiredCheckinMinutes: event.expiredCheckinMinutes || 0,
    heldDate: event.heldDate
  };

  const map = new Map();
  records.forEach(r => {
    const user = r.user || {};
    const ext = r.externalParticipant || {};

    const keys = [
      user.studentId,
      user.verifiedStudentId,
      user.username,
      r.ticketCode,
      r.ticket?.qrCode,
      ext.studentId
    ].filter(Boolean);

    keys.forEach(k => {
      const normalized = String(k).trim().toLowerCase();
      if (normalized) map.set(normalized, r);
    });
  });

  attendanceCache.lookupMap = map;
}

function renderAttendanceTableRows(records, isPastEvent) {
  const tbody = document.getElementById("attendance-table-body");
  const empty = document.getElementById("attendance-empty");
  if (!tbody || !empty) return;

  if (!records || !records.length) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const activeBoothCode = (document.getElementById("multibooth-active-station-select")?.value || "").trim().toUpperCase();

  tbody.innerHTML = records.map(r => {
    const user = r.user || (r.isExternal ? { fullname: r.externalParticipant?.fullname, email: `External (${r.externalParticipant?.studentId || 'ID'})` } : {});
    const status = r.status || "absent";
    const visitedList = (r.stationCheckins || []).map(s => (s.boothCode || '').toUpperCase()).filter(Boolean);
    const hasVisitedActiveStation = activeBoothCode && visitedList.includes(activeBoothCode);

    let badge = '';
    if (status === 'present') {
      const stationTag = visitedList.length > 0
        ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 ml-1.5" title="${visitedList.length} trạm: ${visitedList.join(', ')}"><i class="fa-solid fa-store text-[9px]"></i>${visitedList.length} trạm</span>`
        : '';
      badge = `<span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background:#d1fae5;color:#059669">Present</span>${stationTag}`;
    } else if (status === 'late') {
      badge = '<span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background:#fef3c7;color:#d97706">Late</span>';
    } else {
      badge = '<span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background:#fee2e2;color:#dc2626">Absent</span>';
    }
    const isCheckedIn = status === 'present' || status === 'late';
    const visitedPills = visitedList.length > 0
      ? `<div class="flex items-center gap-1 flex-wrap mt-1"><span class="text-[10px] text-slate-500 font-medium">Đã ghé:</span>${visitedList.map(c => `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-50 text-indigo-700 border border-indigo-200/60" title="Trạm ${c}">${c}</span>`).join('')}</div>`
      : '';

    const stationBtnText = hasVisitedActiveStation
      ? `<i class="fa-solid fa-check text-[10px]"></i><span>Đã ghé</span>`
      : `<i class="fa-solid fa-store text-[10px]"></i><span>+ Trạm</span>`;
    const stationBtnClass = hasVisitedActiveStation
      ? `btn-checkin-station-row text-xs py-1.5 px-2.5 rounded-xl bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 transition-all inline-flex items-center gap-1 cursor-default opacity-85`
      : `btn-checkin-station-row text-xs py-1.5 px-2.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold border border-indigo-200 transition-all inline-flex items-center gap-1 cursor-pointer`;

    return `
      <tr class="border-b border-[#ecedfa]">
        <td class="py-3.5 px-4">
          <div class="flex items-center gap-3">
            ${user.avatar
        ? `<img src="${user.avatar}" class="w-8 h-8 rounded-full object-cover" />`
        : `<div class="w-8 h-8 rounded-full bg-[#dae1ff] flex items-center justify-center text-primary text-xs font-bold">${(user.fullname?.[0] || "?").toUpperCase()}</div>`}
            <div>
              <span class="font-semibold block">${user.fullname || "Unknown"}</span>
              ${visitedPills}
            </div>
          </div>
        </td>
        <td class="py-3.5 px-4 text-[#64748b] hidden md:table-cell">${user.email || "—"}</td>
        <td class="py-3.5 px-4">${badge}</td>
        <td class="py-3.5 px-4 text-[#64748b] hidden sm:table-cell">${r.checkedInAt ? formatDate(r.checkedInAt) : "—"}</td>
        <td class="py-3.5 px-4 text-right">
          <div class="flex items-center justify-end gap-2">
            <button class="${stationBtnClass}" data-att-id="${r._id}" ${hasVisitedActiveStation ? 'data-already-visited="true"' : ''} title="${hasVisitedActiveStation ? `Đã điểm danh vào trạm ${activeBoothCode}` : 'Điểm danh vào trạm đang chọn'}">
              ${stationBtnText}
            </button>
            ${isPastEvent
        ? (isCheckedIn
          ? `<span class="text-sm text-slate-400 font-semibold cursor-not-allowed select-none">Mark Absent</span>`
          : `<span class="text-sm text-slate-400 font-semibold cursor-not-allowed select-none">Check In</span>`)
        : (isCheckedIn
          ? `<button class="manual-checkout-btn text-sm text-red-600 font-semibold hover:underline bg-transparent border-none cursor-pointer" data-user-id="${user._id || r._id}">Mark Absent</button>`
          : `<button class="manual-checkin-btn text-sm text-primary font-semibold hover:underline bg-transparent border-none cursor-pointer" data-user-id="${user._id || r._id}">Check In</button>`)}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-checkin-station-row").forEach(btn => {
    btn.addEventListener("click", async () => {
      const attId = btn.dataset.attId;
      const eventId = document.getElementById("attendance-event-select")?.value;
      const stationSelect = document.getElementById("multibooth-active-station-select");
      const boothCode = stationSelect?.value;

      if (!boothCode) {
        showAlertDialog({
          titleKey: "common.notice",
          defaultTitle: "Vui lòng chọn trạm",
          messageKey: "org_dashboard.select_station_first",
          defaultMessage: "Hãy chọn Trạm / Gian hàng bạn muốn điểm danh ở thanh trên trước khi bấm Check-in."
        });
        stationSelect?.focus();
        return;
      }

      if (btn.dataset.alreadyVisited === "true") {
        showAlertDialog({
          titleKey: "common.notice",
          defaultTitle: "Đã điểm danh",
          messageKey: "org_dashboard.already_visited_station",
          defaultMessage: `Sinh viên này đã được ghi nhận tham quan tại trạm ${boothCode} rồi.`
        });
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-[10px]"></i>';
      try {
        await manualCheckinBooth(eventId, boothCode, attId);
        showAlertDialog({
          titleKey: "common.success",
          defaultTitle: "Thành công",
          messageKey: "org_dashboard.checkin_station_success",
          defaultMessage: `Điểm danh sinh viên vào trạm ${boothCode} thành công!`
        });
        await loadAttendance(eventId);
      } catch (err) {
        showAlertDialog({
          titleKey: "common.error",
          defaultTitle: "Lỗi điểm danh",
          messageKey: "org_dashboard.checkin_station_error",
          defaultMessage: err.message || "Không thể điểm danh vào trạm"
        });
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-store text-[10px]"></i><span>+ Trạm</span>';
      }
    });
  });

  tbody.querySelectorAll(".manual-checkin-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.userId;
      const eventId = document.getElementById("attendance-event-select").value;
      if (!eventId || !userId) return;
      try {
        await markAttendance(eventId, userId, "present");
        await loadAttendance(eventId);
      } catch (err) {
        alert(err.message || "Check-in failed");
      }
    });
  });

  tbody.querySelectorAll(".manual-checkout-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.userId;
      const eventId = document.getElementById("attendance-event-select").value;
      const confirmed = await showConfirmDialog({
        titleKey: "common.confirm_title",
        messageKey: "org_dashboard.status_absent_confirm",
        confirmTextKey: "common.confirm_btn",
        type: "warning"
      });
      if (!confirmed) return;
      try {
        await markAttendance(eventId, userId, "absent");
        await loadAttendance(eventId);
      } catch (err) {
        alert(err.message || "Operation failed");
      }
    });
  });
}

async function loadAttendance(eventId) {
  try {
    const [attData, statsData, eventData] = await Promise.all([
      getAttendance(eventId).catch(() => ({ attendance: [] })),
      getAttendanceStats(eventId).catch(() => ({ stats: { totalParticipants: 0, present: 0, absent: 0 } })),
      get(`/events/${eventId}`).catch(() => ({ event: {} })),
    ]);
    const cachedEv = currentEvents.find(e => (e._id || e.id) === eventId) || {};
    const event = { ...cachedEv, ...(eventData.event || {}) };
    const eventDate = event.heldDateEnd || event.heldDate;
    let isPastEvent = false;
    if (eventDate) {
      const eventDateString = new Date(eventDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const nowDateString = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      isPastEvent = nowDateString > eventDateString;
    }

    const records = attData.attendance || [];
    rebuildAttendanceCache(eventId, records, event, isPastEvent);

    const scanQrBtn = document.getElementById("scan-qr-btn");
    const openOnlineCheckinBtn = document.getElementById("open-online-checkin-modal-btn");
    const initBtn = document.getElementById("init-attendance-btn");

    const isOnline = isOnlineEvent(event);
    if (isOnline) {
      if (scanQrBtn) scanQrBtn.classList.add("hidden");
      if (openOnlineCheckinBtn) openOnlineCheckinBtn.classList.remove("hidden");
    } else {
      if (scanQrBtn) scanQrBtn.classList.remove("hidden");
      if (openOnlineCheckinBtn) openOnlineCheckinBtn.classList.add("hidden");
    }

    if (scanQrBtn) {
      if (isPastEvent) {
        scanQrBtn.disabled = true;
        scanQrBtn.classList.add("opacity-50", "cursor-not-allowed");
        scanQrBtn.classList.remove("cursor-pointer");
        scanQrBtn.title = "Cannot scan QR code for a past event";
      } else {
        scanQrBtn.disabled = false;
        scanQrBtn.classList.remove("opacity-50", "cursor-not-allowed");
        scanQrBtn.classList.add("cursor-pointer");
        scanQrBtn.title = "";
      }
    }
    if (openOnlineCheckinBtn) {
      if (isPastEvent) {
        openOnlineCheckinBtn.disabled = true;
        openOnlineCheckinBtn.classList.add("opacity-50", "cursor-not-allowed");
        openOnlineCheckinBtn.classList.remove("cursor-pointer");
        openOnlineCheckinBtn.title = "Cannot open check-in gate for a past event";
      } else {
        openOnlineCheckinBtn.disabled = false;
        openOnlineCheckinBtn.classList.remove("opacity-50", "cursor-not-allowed");
        openOnlineCheckinBtn.classList.add("cursor-pointer");
        openOnlineCheckinBtn.title = "";
      }
    }
    if (initBtn) {
      if (isPastEvent) {
        initBtn.disabled = true;
        initBtn.classList.add("opacity-50", "cursor-not-allowed");
        initBtn.classList.remove("cursor-pointer");
        initBtn.title = "Cannot initialize attendance for a past event";
      } else {
        initBtn.disabled = false;
        initBtn.classList.remove("opacity-50", "cursor-not-allowed");
        initBtn.classList.add("cursor-pointer");
        initBtn.title = "";
      }
    }

    // Multi-Booth / Kiosk Mode
    const openMultiBoothBtn = document.getElementById("open-multibooth-mgr-btn");
    const exportMultiBoothBtn = document.getElementById("export-multibooth-excel-btn");
    const multiBoothBanner = document.getElementById("multibooth-checkin-banner");

    if (event.hasMultiBooth) {
      if (openMultiBoothBtn) openMultiBoothBtn.classList.remove("hidden");
      if (exportMultiBoothBtn) exportMultiBoothBtn.classList.remove("hidden");
      if (multiBoothBanner) multiBoothBanner.classList.remove("hidden");
      if (typeof loadMultiBoothStations === "function") {
        loadMultiBoothStations(eventId, event);
      }
    } else {
      if (openMultiBoothBtn) openMultiBoothBtn.classList.add("hidden");
      if (exportMultiBoothBtn) exportMultiBoothBtn.classList.add("hidden");
      if (multiBoothBanner) multiBoothBanner.classList.add("hidden");
    }

    const hasAttendance = event.hasAttendance === true || event.hasAttendance === 'true';

    const attendanceContainer = document.getElementById("attendance-content");
    const attendanceEmpty = document.getElementById("attendance-empty");
    const attendanceTable = document.querySelector("#section-attendance .overflow-x-auto");
    const statsGrid = document.querySelector("#section-attendance .grid.grid-cols-1");
    const actionBtns = document.querySelector("#section-attendance .flex.gap-3.mb-6");
    const attendanceListHeader = document.querySelector("#section-attendance .px-6.py-4");

    if (!hasAttendance) {
      if (attendanceEmpty) {
        attendanceEmpty.classList.remove("hidden");
        attendanceEmpty.innerHTML = `
          <i class="fa-solid fa-triangle-exclamation text-4xl mb-3 block text-[#f59e0b]"></i>
          <p class="text-base font-semibold text-[#64748b]">Attendance tracking is not enabled for this event</p>
          <p class="text-sm text-[#94a3b8] mt-1">You can enable it when creating the event or contact the event organizer.</p>
        `;
      }
      document.getElementById("stat-present").textContent = "0";
      document.getElementById("stat-absent").textContent = "0";
      document.getElementById("stat-total-att").textContent = "0";
      document.getElementById("attendance-count").textContent = "0 record(s)";
      const tbody = document.getElementById("attendance-table-body");
      if (tbody) tbody.innerHTML = "";
      if (statsGrid) statsGrid.style.opacity = "0.4";
      if (actionBtns) actionBtns.style.opacity = "0.4";
      if (attendanceListHeader) attendanceListHeader.style.opacity = "0.4";
      if (attendanceTable) attendanceTable.style.opacity = "0.4";
      const rulesEl = document.getElementById("checkin-rules-display");
      if (rulesEl) rulesEl.innerHTML = "";
      return;
    }

    if (statsGrid) statsGrid.style.opacity = "1";
    if (actionBtns) actionBtns.style.opacity = "1";
    if (attendanceListHeader) attendanceListHeader.style.opacity = "1";
    if (attendanceTable) attendanceTable.style.opacity = "1";
    if (attendanceEmpty) {
      attendanceEmpty.classList.remove("hidden");
      attendanceEmpty.innerHTML = `<i class="fa-solid fa-qrcode text-4xl mb-3 block"></i>
        <p class="text-base font-semibold">No attendance records yet</p>`;
    }

    const lateMin = event.lateCheckinMinutes || 0;
    const expiredMin = event.expiredCheckinMinutes || 0;
    const rulesEl = document.getElementById("checkin-rules-display");
    if (rulesEl) {
      if (lateMin > 0 || expiredMin > 0) {
        const parts = [];
        if (lateMin > 0) parts.push(`Late after <strong>${lateMin} min</strong>`);
        if (expiredMin > 0) parts.push(`Expire after <strong>${expiredMin} min</strong>`);
        rulesEl.innerHTML = 'Check-in Rules: ' + parts.join(' &middot; ');
        rulesEl.className = "text-xs text-[#64748b] mt-1";
      } else {
        rulesEl.innerHTML = "Check-in Rules: disabled (all check-ins accepted)";
        rulesEl.className = "text-xs text-[#64748b] mt-1";
      }
    }
    const stats = statsData.stats || {};

    document.getElementById("stat-present").textContent = stats.present || 0;
    document.getElementById("stat-absent").textContent = stats.absent || 0;
    document.getElementById("stat-total-att").textContent = stats.totalParticipants || records.length;
    document.getElementById("attendance-count").textContent = `${records.length} record(s)`;

    renderAttendanceTableRows(records, isPastEvent);
  } catch (err) {
    console.error("Load attendance error:", err);
  }
}

function initQRScan() {
  let activeStream = null;
  let isScanning = false;
  let isMirrored = false;
  let lastScannedCode = "";
  let lastScannedTime = 0;
  let feedbackTimer = null;
  let sessionHistory = [];
  let lastScanTime = 0;
  const SCAN_INTERVAL = 16; // ~60 FPS — ultra-fast real-time response
  let isProcessingFrame = false;

  let rotCanvas = null;
  let rotCtx = null;
  function getRotatedCanvas(srcCanvas) {
    if (!rotCanvas) {
      rotCanvas = document.createElement("canvas");
      rotCtx = rotCanvas.getContext("2d", { willReadFrequently: true });
    }
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    if (rotCanvas.width !== h || rotCanvas.height !== w) {
      rotCanvas.width = h;
      rotCanvas.height = w;
    }
    rotCtx.save();
    rotCtx.translate(h, 0);
    rotCtx.rotate(Math.PI / 2);
    rotCtx.drawImage(srcCanvas, 0, 0);
    rotCtx.restore();
    return rotCanvas;
  }

  // Lazy-init native BarcodeDetector restricted to required formats for maximum speed & omnidirectional support
  let nativeBarcodeDetector = null;
  async function getNativeBarcodeDetector() {
    if (nativeBarcodeDetector) return nativeBarcodeDetector;
    if (typeof BarcodeDetector === 'undefined') return null;
    try {
      const targetFormats = ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'pdf417', 'data_matrix'];
      nativeBarcodeDetector = new BarcodeDetector({ formats: targetFormats });
      console.log('[Scanner] Native BarcodeDetector ready (multi-format omnidirectional)');
    } catch (e) {
      try {
        nativeBarcodeDetector = new BarcodeDetector();
      } catch (e2) {
        nativeBarcodeDetector = null;
      }
    }
    return nativeBarcodeDetector;
  }
  getNativeBarcodeDetector().catch(() => { });

  // ZXing fallback with TRY_HARDER hint enabled for 360-degree omnidirectional decoding
  let zxingReader = null;
  async function getZXingReader() {
    if (zxingReader) return zxingReader;
    if (typeof BrowserMultiFormatReader === 'undefined') return null;
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
      console.log('[Scanner] ZXing multi-angle omnidirectional reader ready');
      return zxingReader;
    } catch (e) {
      console.warn('[Scanner] ZXing unavailable:', e);
      return null;
    }
  }
  getZXingReader().catch(() => { });

  let scanType = 'qr'; // 'qr' | 'barcode' — updated dynamically per scan result

  function playBeep(success) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (success) {
        // High double-beep for check-in success
        osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
        gain.gain.setValueAtTime(0.06, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.08);

        setTimeout(() => {
          const osc2 = ctx.createOscillator();
          const gain2 = ctx.createGain();
          osc2.connect(gain2);
          gain2.connect(ctx.destination);
          osc2.frequency.setValueAtTime(1174.66, ctx.currentTime); // D6
          gain2.gain.setValueAtTime(0.06, ctx.currentTime);
          osc2.start();
          osc2.stop(ctx.currentTime + 0.12);
        }, 90);
      } else {
        // Low buzz for check-in error
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(130, ctx.currentTime); // C3
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      }
    } catch (e) {
      console.error("Audio synthesis error:", e);
    }
  }

  function showScanFeedback(state, message = "", user = null, ticketCode = "", isLate = false) {
    const container = document.getElementById("scan-feedback-container");
    const defaultView = document.getElementById("scan-feedback-default");
    const successView = document.getElementById("scan-feedback-success");
    const errorView = document.getElementById("scan-feedback-error");

    if (!container || !defaultView || !successView || !errorView) return;

    defaultView.classList.add("hidden");
    successView.classList.add("hidden");
    errorView.classList.add("hidden");

    container.classList.remove("border-emerald-200", "bg-emerald-50/30", "border-amber-200", "bg-amber-50/30", "border-rose-200", "bg-rose-50/30", "border-slate-200/60", "bg-slate-50");

    if (state === "default" || state === "loading") {
      defaultView.classList.remove("hidden");
      container.classList.add("border-slate-200/60", "bg-slate-50");
      const textEl = defaultView.querySelector("p");
      if (textEl) textEl.textContent = message || (state === "loading" ? t("attendance.scan_loading") : t("attendance.scan_placeholder"));

      const formatLabelEl = document.getElementById("scan-feedback-format");
      if (formatLabelEl) {
        formatLabelEl.textContent = t("attendance.format_qr_barcode");
        formatLabelEl.className = "text-[9px] font-semibold text-slate-400 uppercase tracking-wider";
      }

      const placeholderEl = document.getElementById("scan-feedback-avatar-placeholder");
      if (placeholderEl) {
        placeholderEl.textContent = "person";
        placeholderEl.className = "material-symbols-outlined text-4xl text-slate-400";
      }
      const avatarContainer = document.getElementById("scan-feedback-avatar-container");
      if (avatarContainer) {
        avatarContainer.className = "w-20 h-20 rounded-full border-4 border-slate-300 overflow-hidden shadow-md mx-auto bg-slate-200 flex items-center justify-center";
      }
      const avatarEl = document.getElementById("scan-feedback-avatar");
      if (avatarEl) avatarEl.classList.add("hidden");
    } else if (state === "success" && user) {
      successView.classList.remove("hidden");
      const borderClass = isLate ? "border-amber-200" : "border-emerald-200";
      const bgClass = isLate ? "bg-amber-50/30" : "bg-emerald-50/30";
      container.classList.add(borderClass, bgClass);

      const nameEl = document.getElementById("scan-feedback-name");
      const usernameEl = document.getElementById("scan-feedback-username");
      const emailEl = document.getElementById("scan-feedback-email");
      const codeEl = document.getElementById("scan-feedback-code");
      const avatarEl = document.getElementById("scan-feedback-avatar");
      const placeholderEl = document.getElementById("scan-feedback-avatar-placeholder");
      const statusLabel = document.getElementById("scan-feedback-status-label");
      const avatarContainer = document.getElementById("scan-feedback-avatar-container");
      const formatLabel = document.getElementById("scan-feedback-format");

      if (formatLabel) {
        const isBarcode = scanType === 'barcode';
        formatLabel.textContent = isBarcode ? t("attendance.format_barcode") : t("attendance.format_qr");
        formatLabel.className = `text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${isBarcode
            ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
            : 'bg-slate-100 text-slate-600 border-slate-200'
          }`;
      }

      if (nameEl) nameEl.textContent = user.fullname || "Unknown Attendee";
      if (usernameEl) {
        const idText = user.studentId ? `ID: ${user.studentId}` : (user.username ? `@${user.username}` : "");
        usernameEl.textContent = idText;
      }
      if (emailEl) emailEl.textContent = user.email || "";
      if (codeEl) codeEl.textContent = ticketCode ? ticketCode.toUpperCase() : "N/A";
      if (statusLabel) {
        if (isLate) {
          statusLabel.textContent = t("attendance.checked_in_late");
          statusLabel.className = "text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full";
        } else {
          statusLabel.textContent = t("attendance.checked_in");
          statusLabel.className = "text-xs font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full";
        }
      }

      if (avatarContainer) {
        const ringBg = isLate ? 'bg-amber-500' : 'bg-emerald-600';
        avatarContainer.className = `w-24 h-24 rounded-full p-1 ${ringBg} shadow-sm mx-auto flex items-center justify-center overflow-hidden`;
      }

      if (avatarEl && placeholderEl) {
        if (user.avatar) {
          avatarEl.src = user.avatar;
          avatarEl.classList.remove("hidden");
          placeholderEl.classList.add("hidden");
          avatarEl.onerror = () => {
            avatarEl.classList.add("hidden");
            placeholderEl.classList.remove("hidden");
            placeholderEl.textContent = (user.fullname?.[0] || user.username?.[0] || "?").toUpperCase();
            placeholderEl.className = "text-2xl font-bold text-slate-500";
          };
        } else {
          avatarEl.classList.add("hidden");
          placeholderEl.classList.remove("hidden");
          placeholderEl.textContent = (user.fullname?.[0] || user.username?.[0] || "?").toUpperCase();
          placeholderEl.className = "text-2xl font-bold text-slate-500";
        }
      }
    } else if (state === "error") {
      errorView.classList.remove("hidden");
      container.classList.add("border-rose-200", "bg-rose-50/30");

      const errorMsgEl = document.getElementById("scan-feedback-error-message");
      if (errorMsgEl) errorMsgEl.textContent = message || "Invalid or expired ticket code.";
    }
  }

  function setFeedbackWithTimeout(state, message = "", user = null, ticketCode = "", isLate = false) {
    if (feedbackTimer) clearTimeout(feedbackTimer);
    showScanFeedback(state, message, user, ticketCode, isLate);

    if (state === "success" || state === "error") {
      feedbackTimer = setTimeout(() => {
        showScanFeedback("default");
      }, 4000);
    }
  }

  function addToHistory(user, ticketCode, isLate = false) {
    const historyList = document.getElementById("scan-history-list");
    const countEl = document.getElementById("history-count");
    if (!historyList) return;

    const timeStr = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    const newItem = {
      fullname: user.fullname || "Unknown Attendee",
      avatar: user.avatar || "",
      ticketCode: ticketCode,
      time: timeStr,
      isLate
    };

    sessionHistory.unshift(newItem);
    if (sessionHistory.length > 5) sessionHistory.pop();

    if (countEl) countEl.textContent = `${sessionHistory.length} Checked In`;

    historyList.innerHTML = sessionHistory.map(item => `
      <div class="flex items-center justify-between p-3 text-xs bg-white hover:bg-slate-50 transition-colors">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-7 h-7 rounded-full overflow-hidden bg-slate-100 flex-shrink-0 flex items-center justify-center border border-slate-200">
            ${item.avatar
        ? `<img src="${item.avatar}" class="w-full h-full object-cover" />`
        : `<span class="font-bold text-[10px] text-slate-500">${(item.fullname?.[0] || "?").toUpperCase()}</span>`
      }
          </div>
          <div class="min-w-0">
            <p class="font-semibold text-slate-800 truncate">${item.fullname}</p>
            <p class="text-[10px] text-slate-400 font-mono uppercase">${item.ticketCode}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border-emerald-100 border text-[9px] font-semibold">SUCCESS</span>
          <span class="text-[10px] text-slate-400 font-mono">${item.time}</span>
        </div>
      </div>
    `).join("");
  }

  const cameraSelect = document.getElementById("scanner-camera-select");
  const mirrorBtn = document.getElementById("scanner-mirror-btn");
  const viewfinderFlipBtn = document.getElementById("scanner-viewfinder-flip-btn");
  const zoomSlider = document.getElementById("scanner-zoom-slider");
  const zoomVal = document.getElementById("zoom-value");
  const expSlider = document.getElementById("scanner-exposure-slider");
  const expVal = document.getElementById("exposure-value");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  function updateVideoMirrorStyle() {
    const video = document.getElementById("qr-video");
    if (!video) return;
    if (isMirrored) {
      video.style.transform = "scaleX(-1)";
      if (mirrorBtn) {
        mirrorBtn.classList.add("bg-primary/10", "border-primary", "text-primary");
        mirrorBtn.classList.remove("bg-white", "text-slate-700");
      }
      if (viewfinderFlipBtn) {
        viewfinderFlipBtn.classList.add("!bg-primary", "!border-primary", "text-white");
        viewfinderFlipBtn.classList.remove("bg-black/60");
      }
    } else {
      video.style.transform = "none";
      if (mirrorBtn) {
        mirrorBtn.classList.remove("bg-primary/10", "border-primary", "text-primary");
        mirrorBtn.classList.add("bg-white", "text-slate-700");
      }
      if (viewfinderFlipBtn) {
        viewfinderFlipBtn.classList.remove("!bg-primary", "!border-primary");
        viewfinderFlipBtn.classList.add("bg-black/60", "text-white");
      }
    }
  }

  const toggleMirror = () => {
    isMirrored = !isMirrored;
    updateVideoMirrorStyle();
  };

  if (mirrorBtn) {
    mirrorBtn.addEventListener("click", toggleMirror);
  }
  if (viewfinderFlipBtn) {
    viewfinderFlipBtn.addEventListener("click", toggleMirror);
  }

  if (cameraSelect) {
    cameraSelect.addEventListener("change", async (e) => {
      const selectedId = e.target.value;
      if (selectedId && isScanning) {
        await stopScanner();
        await startScanner(selectedId);
      }
    });
  }

  if (zoomSlider && zoomVal) {
    zoomSlider.addEventListener("input", async (e) => {
      const val = parseFloat(e.target.value);
      zoomVal.textContent = `${val.toFixed(1)}x`;
      if (activeStream && isScanning) {
        try {
          const track = activeStream.getVideoTracks()[0];
          if (track) {
            await track.applyConstraints({
              advanced: [{ zoom: val }]
            });
          }
        } catch (err) {
          console.warn("Failed to apply zoom:", err);
        }
      }
    });
  }

  if (expSlider && expVal) {
    expSlider.addEventListener("input", async (e) => {
      const val = parseFloat(e.target.value);
      expVal.textContent = val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1);
      if (activeStream && isScanning) {
        try {
          const track = activeStream.getVideoTracks()[0];
          if (track) {
            await track.applyConstraints({
              advanced: [{ exposureCompensation: val }]
            });
          }
        } catch (err) {
          console.warn("Failed to apply exposure compensation:", err);
        }
      }
    });
  }

  function scanFrame() {
    if (!isScanning) return;
    const video = document.getElementById("qr-video");
    if (!video) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA && !isProcessingFrame) {
      const now = Date.now();
      if (now - lastScanTime >= SCAN_INTERVAL) {
        lastScanTime = now;
        isProcessingFrame = true;

        // Optimal 480px resolution for ultra-fast JS binarization (~180k pixels)
        const maxDim = 480;
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 480;
        const scale = Math.min(maxDim / vw, maxDim / vh, 1.0);
        const targetW = Math.round(vw * scale);
        const targetH = Math.round(vh * scale);

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        // Single-pass draw: if mirrored (front camera), flip horizontally so canvas is ALWAYS in readable left-to-right orientation
        ctx.save();
        if (isMirrored) {
          ctx.translate(targetW, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0, targetW, targetH);
        ctx.restore();

        const finalizeFrame = () => { isProcessingFrame = false; };

        try {
          const detector = nativeBarcodeDetector;
          if (detector) {
            // 1. Native BarcodeDetector (Chrome / Edge / Android) — hardware C++ accelerated (Pass 0: Normal 0 deg)
            const source = isMirrored ? canvas : video;
            detector.detect(source).then(barcodes => {
              if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                const raw = barcodes[0].rawValue;
                const fmt = barcodes[0].format || '';
                scanType = fmt === 'qr_code' ? 'qr' : 'barcode';
                onScanSuccess(raw);
                finalizeFrame();
              } else if (!isScanning) {
                finalizeFrame();
              } else {
                // Pass 90: Rotated 90 deg for vertical & tilted barcodes/cards
                const rCanvas = getRotatedCanvas(canvas);
                detector.detect(rCanvas).then(rBarcodes => {
                  if (rBarcodes && rBarcodes.length > 0 && rBarcodes[0].rawValue) {
                    const raw = rBarcodes[0].rawValue;
                    const fmt = rBarcodes[0].format || '';
                    scanType = fmt === 'qr_code' ? 'qr' : 'barcode';
                    onScanSuccess(raw);
                    finalizeFrame();
                  } else {
                    tryZXingFallback().finally(finalizeFrame);
                  }
                }).catch(() => {
                  tryZXingFallback().finally(finalizeFrame);
                });
              }
            }).catch(() => {
              tryZXingFallback().finally(finalizeFrame);
            });
          } else {
            // 2. ZXing fallback (Safari / iOS)
            tryZXingFallback().finally(finalizeFrame);
          }
        } catch (err) {
          finalizeFrame();
        }

        // Shared ZXing + jsQR multi-angle fallback
        async function tryZXingFallback() {
          const zxing = await getZXingReader();
          if (zxing && isScanning) {
            try {
              let result = zxing.decodeFromCanvas(canvas);
              if (!result || !result.getText || !result.getText()) {
                const rCanvas = getRotatedCanvas(canvas);
                result = zxing.decodeFromCanvas(rCanvas);
              }
              if (result && result.getText && result.getText()) {
                const fmt = result.getBarcodeFormat?.();
                scanType = (fmt === 11) ? 'qr' : 'barcode';
                onScanSuccess(result.getText());
                return;
              }
            } catch (e) { }
          }

          // 3. Fast jsQR multi-angle fallback
          if (isScanning && typeof jsQR !== "undefined") {
            const imageData = ctx.getImageData(0, 0, targetW, targetH);
            let code = jsQR(imageData.data, targetW, targetH, { inversionAttempts: "attemptBoth" });
            if (!code || !code.data) {
              const rCanvas = getRotatedCanvas(canvas);
              const rImageData = rotCtx.getImageData(0, 0, rCanvas.width, rCanvas.height);
              code = jsQR(rImageData.data, rCanvas.width, rCanvas.height, { inversionAttempts: "attemptBoth" });
            }
            if (code && code.data) {
              scanType = 'qr';
              onScanSuccess(code.data);
            }
          }
        }
      }
    }
    requestAnimationFrame(scanFrame);
  }

  async function startScanner(cameraId = null) {
    const video = document.getElementById("qr-video");
    if (!video) return;

    try {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === "videoinput");
        if (videoDevices.length && cameraSelect) {
          cameraSelect.innerHTML = videoDevices.map(d => `<option value="${d.deviceId}">${d.label || `Camera ${d.deviceId}`}</option>`).join("");
          if (cameraId) {
            cameraSelect.value = cameraId;
          } else {
            cameraId = videoDevices[0].deviceId;
            cameraSelect.value = cameraId;
          }
        }
      } catch { }

      const constraints = {
        video: cameraId ? { deviceId: { exact: cameraId } } : { facingMode: { ideal: "environment" } }
      };

      constraints.video.width = { min: 640, ideal: 1280, max: 1920 };
      constraints.video.height = { min: 480, ideal: 720, max: 1080 };
      constraints.video.frameRate = { ideal: 60, min: 30 };

      activeStream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = activeStream;
      await video.play();

      // Enable continuous auto-focus if hardware supports it
      try {
        const track = activeStream.getVideoTracks()[0];
        if (track && track.applyConstraints) {
          await track.applyConstraints({
            advanced: [{ focusMode: "continuous" }]
          }).catch(() => { });
        }
      } catch { }

      isScanning = true;
      requestAnimationFrame(scanFrame);

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === "videoinput");
        if (videoDevices.length && cameraSelect) {
          cameraSelect.innerHTML = videoDevices.map(d => `<option value="${d.deviceId}">${d.label || `Camera ${d.deviceId}`}</option>`).join("");
          const track = activeStream.getVideoTracks()[0];
          const settings = track?.getSettings ? track.getSettings() : {};
          if (settings.deviceId) {
            cameraSelect.value = settings.deviceId;
          } else if (cameraId && typeof cameraId === "string") {
            cameraSelect.value = cameraId;
          }

          const label = track?.label?.toLowerCase() || "";
          const isFrontCamera = settings.facingMode === "user" || label.includes("front") || label.includes("user") || label.includes("selfie");
          isMirrored = isFrontCamera;
          updateVideoMirrorStyle();
        }
      } catch { }

      setupCameraCapabilities();
    } catch (err) {
      console.error("Camera start error:", err);
    }
  }

  async function stopScanner() {
    isScanning = false;
    if (activeStream) {
      try {
        activeStream.getTracks().forEach(t => t.stop());
      } catch { }
      activeStream = null;
    }
    if (zxingReader && typeof zxingReader.reset === 'function') {
      try { zxingReader.reset(); } catch { }
    }
    const video = document.getElementById("qr-video");
    if (video) {
      video.srcObject = null;
    }
    isMirrored = false;
    updateVideoMirrorStyle();
    if (zoomSlider) zoomSlider.disabled = true;
    if (zoomVal) zoomVal.textContent = "N/A";
    if (expSlider) expSlider.disabled = true;
    if (expVal) expVal.textContent = "N/A";
  }

  function setupCameraCapabilities() {
    try {
      if (!activeStream) return;
      const track = activeStream.getVideoTracks()[0];
      if (!track) return;
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};

      if (zoomSlider && zoomVal) {
        if (capabilities.zoom) {
          zoomSlider.disabled = false;
          zoomSlider.min = capabilities.zoom.min;
          zoomSlider.max = capabilities.zoom.max;
          zoomSlider.step = capabilities.zoom.step || 0.1;
          const currentSettings = track.getSettings ? track.getSettings() : {};
          zoomSlider.value = currentSettings.zoom || capabilities.zoom.min;
          zoomVal.textContent = `${parseFloat(zoomSlider.value).toFixed(1)}x`;
        } else {
          zoomSlider.disabled = true;
          zoomVal.textContent = "N/A";
        }
      }

      if (expSlider && expVal) {
        if (capabilities.exposureCompensation) {
          expSlider.disabled = false;
          expSlider.min = capabilities.exposureCompensation.min;
          expSlider.max = capabilities.exposureCompensation.max;
          expSlider.step = capabilities.exposureCompensation.step || 0.5;
          const currentSettings = track.getSettings ? track.getSettings() : {};
          expSlider.value = currentSettings.exposureCompensation || 0;
          expVal.textContent = parseFloat(expSlider.value).toFixed(1);
        } else {
          expSlider.disabled = true;
          expVal.textContent = "N/A";
        }
      }
    } catch (err) {
      console.warn("Failed to set up camera capabilities:", err);
    }
  }

  function triggerScanSuccessAnimation() {
    const container = document.getElementById("scanner-viewfinder-container");
    const viewfinder = document.getElementById("scanner-viewfinder");
    if (!container || !viewfinder) return;

    container.classList.add("!border-emerald-500", "ring-2", "ring-emerald-500/30", "scale-[1.02]");
    viewfinder.classList.add("!border-emerald-500", "!border-solid", "scale-105");
    viewfinder.classList.remove("animate-pulse", "border-primary/40");

    setTimeout(() => {
      container.classList.remove("!border-emerald-500", "ring-2", "ring-emerald-500/30", "scale-[1.02]");
      viewfinder.classList.remove("!border-emerald-500", "!border-solid", "scale-105");
      viewfinder.classList.add("animate-pulse", "border-primary/40");
    }, 600);
  }

  async function onScanSuccess(decodedText) {
    const now = Date.now();
    if (decodedText === lastScannedCode && now - lastScannedTime < 3000) {
      // Cooldown to avoid duplicate scanning of the same code
      return;
    }
    lastScannedCode = decodedText;
    lastScannedTime = now;

    triggerScanSuccessAnimation();

    // Process check-in continuously WITHOUT stopping the camera feed
    await processCheckIn(decodedText);
  }

  document.getElementById("scan-qr-btn").addEventListener("click", () => {
    if (document.getElementById("scan-qr-btn").disabled) return;
    const eventId = document.getElementById("attendance-event-select").value;
    if (!eventId) return alert("Select an event first");
    const overlay = document.getElementById("scan-overlay");
    overlay.removeAttribute("hidden");
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";
    setTimeout(startScanner, 500);
  });

  function closeScan() {
    stopScanner();

    // Reset scanner UI state
    sessionHistory = [];
    const historyList = document.getElementById("scan-history-list");
    if (historyList) {
      historyList.innerHTML = `<div class="p-4 text-center text-xs text-slate-400 italic">No scans recorded in this session.</div>`;
    }
    const countEl = document.getElementById("history-count");
    if (countEl) countEl.textContent = "0 Checked In";

    if (feedbackTimer) clearTimeout(feedbackTimer);
    showScanFeedback("default");

    const overlay = document.getElementById("scan-overlay");
    overlay.classList.remove("active");
    document.body.style.overflow = "";
    setTimeout(() => overlay.setAttribute("hidden", ""), 300);
  }

  document.getElementById("scan-backdrop").addEventListener("click", closeScan);
  document.getElementById("scan-close").addEventListener("click", closeScan);
  document.getElementById("scan-cancel").addEventListener("click", closeScan);

  const manualInput = document.getElementById("manual-ticket-input");
  const manualBtn = document.getElementById("manual-checkin-btn");

  const handleManualCheckIn = async () => {
    const ticketCode = manualInput.value.trim();
    if (!ticketCode) return;
    await processCheckIn(ticketCode);
  };

  if (manualBtn && manualInput) {
    manualBtn.addEventListener("click", handleManualCheckIn);
    manualInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        await handleManualCheckIn();
      }
    });
  }

  async function processCheckIn(ticketCode) {
    const eventId = document.getElementById("attendance-event-select").value;
    if (!ticketCode) return;
    if (!eventId) return alert("Select an event first");

    const codeClean = String(ticketCode).trim().toLowerCase();
    const cachedRecord = attendanceCache.eventId === eventId ? attendanceCache.lookupMap.get(codeClean) : null;

    if (cachedRecord) {
      const currentStatus = cachedRecord.status;
      if (currentStatus === "present" || currentStatus === "late") {
        playBeep(false);
        setFeedbackWithTimeout("error", "Participant is already checked in!");
        if (manualInput) manualInput.value = "";
        return;
      }

      let newStatus = "present";
      const rules = attendanceCache.eventRules;
      if (rules.lateCheckinMinutes > 0 && rules.heldDate) {
        const start = new Date(rules.heldDate);
        const lateThreshold = new Date(start.getTime() + rules.lateCheckinMinutes * 60000);
        if (new Date() > lateThreshold) newStatus = "late";
      }

      cachedRecord.status = newStatus;
      cachedRecord.checkedInAt = new Date().toISOString();

      playBeep(true);
      const isLate = newStatus === "late";
      const userPayload = cachedRecord.isExternal ? {
        fullname: cachedRecord.externalParticipant?.fullname,
        studentId: cachedRecord.externalParticipant?.studentId
      } : (cachedRecord.user || {});

      setFeedbackWithTimeout("success", `Checked in ${userPayload.fullname || 'participant'}`, userPayload, ticketCode, isLate);
      addToHistory(userPayload, ticketCode, isLate);
      if (manualInput) manualInput.value = "";

      const presentEl = document.getElementById("stat-present");
      const absentEl = document.getElementById("stat-absent");
      if (presentEl && absentEl) {
        let p = parseInt(presentEl.textContent) || 0;
        let a = parseInt(absentEl.textContent) || 0;
        presentEl.textContent = p + 1;
        if (a > 0) absentEl.textContent = a - 1;
      }
      renderAttendanceTableRows(attendanceCache.records, attendanceCache.isPastEvent);

      totalQueueEnqueued++;
      backgroundQueue.push({ eventId, code: ticketCode, attempts: 0 });
      updateQueueBadgeUI();
      processBackgroundQueue();
      return;
    }

    setFeedbackWithTimeout("loading", "Processing check-in...");

    try {
      const response = await scanAttendance(eventId, ticketCode);
      playBeep(true);
      const isLate = response.attendance?.status === "late";
      setFeedbackWithTimeout("success", response.message || "", response.user, ticketCode, isLate);
      addToHistory(response.user || {}, ticketCode, isLate);

      if (manualInput) manualInput.value = "";

      if (response.attendance && attendanceCache.lookupMap) {
        const newRec = response.attendance;
        newRec.user = response.user || newRec.user || {};
        const codeClean = String(ticketCode).trim().toLowerCase();
        attendanceCache.lookupMap.set(codeClean, newRec);
        if (response.user?.studentId) {
          attendanceCache.lookupMap.set(String(response.user.studentId).trim().toLowerCase(), newRec);
        }
      }

      await loadAttendance(eventId);
    } catch (err) {
      playBeep(false);
      setFeedbackWithTimeout("error", err.message || "Check-in failed");
    }
  }
}

function initAttendanceButtons() {
  const initBtn = document.getElementById("init-attendance-btn");
  if (initBtn) {
    initBtn.addEventListener("click", async () => {
      if (initBtn.disabled) return;
      const eventId = document.getElementById("attendance-event-select")?.value;
      if (!eventId) return alert(t("org_dashboard.select_event_first", "Select an event first"));
      const confirmed = await showConfirmDialog({
        titleKey: "common.confirm_title",
        messageKey: "org_dashboard.init_attendance_confirm",
        confirmTextKey: "common.confirm_btn",
        type: "primary"
      });
      if (!confirmed) return;
      try {
        await initAttendance(eventId);
        await loadAttendance(eventId);
        alert(t("attendance.init_success", "Attendance initialized"));
      } catch (err) {
        alert(err.message || "Failed to init attendance");
      }
    });
  }
}

function initOnlineCheckinHostModal() {
  const openModalBtn = document.getElementById("open-online-checkin-modal-btn");
  const overlay = document.getElementById("online-checkin-host-modal");
  const backdrop = document.getElementById("online-checkin-host-backdrop");
  const closeBtn = document.getElementById("online-checkin-host-close");
  const eventTitleEl = document.getElementById("online-host-event-title");
  const statusBadgeEl = document.getElementById("online-host-status-badge");
  const closedStateEl = document.getElementById("online-host-closed-state");
  const openStateEl = document.getElementById("online-host-open-state");
  const openBtn = document.getElementById("online-host-open-btn");
  const closeGateBtn = document.getElementById("online-host-close-btn");
  const regenBtn = document.getElementById("online-host-regen-btn");
  const durationSelect = document.getElementById("online-host-duration");
  const pinDisplayEl = document.getElementById("online-host-pin-display");
  const copyBtn = document.getElementById("online-host-copy-btn");
  const copyTextEl = document.getElementById("online-host-copy-text");
  const countdownEl = document.getElementById("online-host-countdown");

  if (!openModalBtn || !overlay) return;

  let countdownInterval = null;
  let currentActiveEventId = null;

  function stopCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  function startCountdown(expiresAt) {
    stopCountdown();
    if (!expiresAt || !countdownEl) return;

    function update() {
      const remainingMs = new Date(expiresAt).getTime() - Date.now();
      if (remainingMs <= 0) {
        countdownEl.textContent = `00:00 (${t("org_dashboard.expired_label", "Hết hạn")})`;
        stopCountdown();
        renderState({ isOpen: false });
        return;
      }
      const totalSec = Math.floor(remainingMs / 1000);
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      countdownEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }

    update();
    countdownInterval = setInterval(update, 1000);
  }

  function renderState(onlineCheckin) {
    const isOpen = Boolean(onlineCheckin && onlineCheckin.isOpen && onlineCheckin.expiresAt && (new Date() < new Date(onlineCheckin.expiresAt)));

    if (isOpen) {
      closedStateEl?.classList.add("hidden");
      openStateEl?.classList.remove("hidden");
      if (statusBadgeEl) {
        statusBadgeEl.textContent = t("org_dashboard.gate_status_open", "Đang mở");
        statusBadgeEl.dataset.i18n = "org_dashboard.gate_status_open";
        statusBadgeEl.className = "px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 bg-emerald-50 text-emerald-700 border border-emerald-200";
      }
      if (pinDisplayEl) {
        pinDisplayEl.textContent = onlineCheckin.code || "------";
      }
      startCountdown(onlineCheckin.expiresAt);
    } else {
      stopCountdown();
      openStateEl?.classList.add("hidden");
      closedStateEl?.classList.remove("hidden");
      if (statusBadgeEl) {
        statusBadgeEl.textContent = t("org_dashboard.gate_status_closed", "Đang đóng");
        statusBadgeEl.dataset.i18n = "org_dashboard.gate_status_closed";
        statusBadgeEl.className = "px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 bg-slate-100 text-slate-600 border border-slate-200";
      }
    }
  }

  async function openModal() {
    const eventId = document.getElementById("attendance-event-select")?.value || attendanceCache?.eventId;
    if (!eventId) {
      alert(t("org_dashboard.select_event_first", "Select an event first"));
      return;
    }
    currentActiveEventId = eventId;

    const event = currentEvents.find(e => (e._id || e.id) === eventId);
    if (eventTitleEl) {
      eventTitleEl.textContent = event?.title || `Event #${eventId}`;
    }

    overlay.removeAttribute("hidden");
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";

    // Show loading state directly in the open gate view
    closedStateEl?.classList.add("hidden");
    openStateEl?.classList.remove("hidden");
    if (pinDisplayEl) {
      pinDisplayEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-2xl text-slate-400"></i>`;
    }
    if (statusBadgeEl) {
      statusBadgeEl.textContent = t("common.loading", "Đang tải...");
      statusBadgeEl.dataset.i18n = "common.loading";
      statusBadgeEl.className = "px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 bg-slate-100 text-slate-600 border border-slate-200";
    }
    if (countdownEl) {
      countdownEl.textContent = "--:--";
    }

    try {
      // 1. Check if gate is currently active with a valid PIN
      const res = await getOnlineCheckinStatus(eventId);
      const isCurrentlyOpen = Boolean(
        res?.onlineCheckin?.isOpen &&
        res?.onlineCheckin?.code &&
        res?.onlineCheckin?.expiresAt &&
        (new Date() < new Date(res.onlineCheckin.expiresAt))
      );

      if (isCurrentlyOpen) {
        renderState(res.onlineCheckin);
      } else {
        // Gate is not active or expired: automatically create a new PIN code immediately!
        const durationMinutes = parseInt(durationSelect?.value || "15", 10);
        const openRes = await toggleOnlineCheckin(eventId, { isOpen: true, durationMinutes });
        if (openRes && openRes.onlineCheckin) {
          renderState(openRes.onlineCheckin);
        } else {
          renderState({ isOpen: false });
        }
      }
    } catch (err) {
      console.error("Failed to load or generate online checkin:", err);
      renderState({ isOpen: false });
      alert(err.message || t("org_dashboard.init_gate_failed", "Khởi tạo cổng điểm danh thất bại"));
    }
  }

  function closeModal() {
    stopCountdown();
    overlay.classList.remove("active");
    document.body.style.overflow = "";
    setTimeout(() => overlay.setAttribute("hidden", ""), 300);
  }

  openModalBtn.addEventListener("click", openModal);
  backdrop?.addEventListener("click", closeModal);
  closeBtn?.addEventListener("click", closeModal);

  // Button to regenerate / create a new PIN while the gate is open
  regenBtn?.addEventListener("click", async () => {
    if (!currentActiveEventId) return;
    const durationMinutes = parseInt(durationSelect?.value || "15", 10);
    const originalContent = regenBtn.innerHTML;
    try {
      regenBtn.disabled = true;
      regenBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-xs"></i> <span>${t("org_dashboard.generating_pin", "Đang tạo mã...")}</span>`;
      const res = await toggleOnlineCheckin(currentActiveEventId, { isOpen: true, durationMinutes });
      if (res && res.onlineCheckin) {
        renderState(res.onlineCheckin);
      }
    } catch (err) {
      alert(err.message || t("org_dashboard.regen_pin_failed", "Không thể tạo mã PIN mới"));
    } finally {
      regenBtn.disabled = false;
      regenBtn.innerHTML = originalContent;
    }
  });

  openBtn?.addEventListener("click", async () => {
    if (!currentActiveEventId) return;
    const durationMinutes = parseInt(durationSelect?.value || "15", 10);
    const originalText = openBtn.innerHTML;
    try {
      openBtn.disabled = true;
      openBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-xs"></i> <span>${t("org_dashboard.opening_gate", "Đang mở cổng...")}</span>`;
      const res = await toggleOnlineCheckin(currentActiveEventId, { isOpen: true, durationMinutes });
      if (res && res.onlineCheckin) {
        renderState(res.onlineCheckin);
      }
    } catch (err) {
      alert(err.message || t("org_dashboard.open_gate_failed", "Mở cổng điểm danh thất bại"));
    } finally {
      openBtn.disabled = false;
      openBtn.innerHTML = originalText;
    }
  });

  closeGateBtn?.addEventListener("click", async () => {
    if (!currentActiveEventId) return;
    const confirmed = await showConfirmDialog({
      titleKey: "common.confirm_title",
      messageKey: "org_dashboard.close_gate_confirm",
      confirmTextKey: "common.confirm_btn",
      type: "danger"
    });
    if (!confirmed) return;

    const originalText = closeGateBtn.innerHTML;
    try {
      closeGateBtn.disabled = true;
      closeGateBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-xs"></i> <span>${t("org_dashboard.closing_gate", "Đang đóng...")}</span>`;
      const res = await toggleOnlineCheckin(currentActiveEventId, { isOpen: false });
      if (res && res.onlineCheckin) {
        renderState(res.onlineCheckin);
      }
    } catch (err) {
      alert(err.message || t("org_dashboard.close_gate_failed", "Đóng cổng điểm danh thất bại"));
    } finally {
      closeGateBtn.disabled = false;
      closeGateBtn.innerHTML = originalText;
    }
  });

  copyBtn?.addEventListener("click", async () => {
    const code = pinDisplayEl?.textContent?.trim();
    if (!code || code === "------" || code.includes("<")) return;
    try {
      await navigator.clipboard.writeText(code);
      if (copyTextEl) {
        copyTextEl.textContent = t("common.copied", "Đã sao chép!");
        setTimeout(() => {
          copyTextEl.textContent = t("org_dashboard.copy_pin", "Sao chép mã PIN");
        }, 2000);
      }
    } catch (e) {
      console.error("Clipboard copy failed:", e);
    }
  });

  window.addEventListener("language-changed", () => {
    if (!overlay.hasAttribute("hidden") && currentActiveEventId) {
      const isCurrentlyOpen = !openStateEl?.classList.contains("hidden");
      if (statusBadgeEl) {
        statusBadgeEl.textContent = isCurrentlyOpen
          ? t("org_dashboard.gate_status_open", "Đang mở")
          : t("org_dashboard.gate_status_closed", "Đang đóng");
      }
    }
  });
}

// ─── Certificates ───

let selectedCertEventId = null;
const certState = {
  eventId: null,
  unissuedPresent: [],
  certificates: [],
  selectedUserIds: new Set(),
  searchQuery: ""
};

function normalizeSearchText(str) {
  return (str || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .trim();
}

function matchesCertSearch(query, { userName, userEmail, studentId, certCode }) {
  if (!query) return true;
  const q = normalizeSearchText(query);
  const qRaw = query.toLowerCase().trim();

  const normName = normalizeSearchText(userName);
  const normEmail = (userEmail || "").toLowerCase();
  const normSid = (studentId || "").toLowerCase();
  const normCode = (certCode || "").toLowerCase();

  return normName.includes(q) ||
         (userName || "").toLowerCase().includes(qRaw) ||
         normEmail.includes(qRaw) ||
         normSid.includes(qRaw) ||
         normCode.includes(qRaw);
}

function setCertSearchEnabled(enabled) {
  const input = document.getElementById("certs-search-input");
  if (!input) return;
  input.disabled = !enabled;
  if (!enabled) {
    input.value = "";
    certState.searchQuery = "";
    const clearBtn = document.getElementById("certs-search-clear");
    if (clearBtn) clearBtn.classList.add("hidden");
  }
}

function initCertSearch() {
  const input = document.getElementById("certs-search-input");
  const clearBtn = document.getElementById("certs-search-clear");
  if (!input) return;

  input.addEventListener("input", (e) => {
    certState.searchQuery = e.target.value;
    if (clearBtn) {
      if (e.target.value) {
        clearBtn.classList.remove("hidden");
      } else {
        clearBtn.classList.add("hidden");
      }
    }
    renderCertificatesTable();
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      input.value = "";
      certState.searchQuery = "";
      clearBtn.classList.add("hidden");
      input.focus();
      renderCertificatesTable();
    });
  }
}

function renderCertBgPanel(event) {
  const panel = document.getElementById("cert-bg-manage-panel");
  const preview = document.getElementById("cert-bg-manage-preview");
  const placeholder = document.getElementById("cert-bg-manage-placeholder");
  const badge = document.getElementById("cert-bg-status-badge");
  const resetBtn = document.getElementById("reset-cert-bg-btn");
  if (!panel) return;

  if (!event || !(event.hasCertificate === true || event.hasCertificate === 'true')) {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  const bgUrl = event.certificateBackground;

  if (bgUrl && bgUrl.trim() !== '') {
    if (preview) {
      preview.src = bgUrl;
      preview.classList.remove("hidden");
    }
    if (placeholder) placeholder.classList.add("hidden");
    if (badge) {
      badge.textContent = t("cert_designer.custom_bg_badge");
      badge.className = "px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200";
    }
    if (resetBtn) resetBtn.classList.remove("hidden");
  } else {
    if (preview) {
      preview.src = "";
      preview.classList.add("hidden");
    }
    if (placeholder) placeholder.classList.remove("hidden");
    if (badge) {
      badge.textContent = t("cert_designer.default_royal_theme");
      badge.className = "px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200";
    }
    if (resetBtn) resetBtn.classList.add("hidden");
  }
}

function initCertBackgroundManager() {
  const input = document.getElementById("cert-bg-manage-input");
  const uploadBtn = document.getElementById("upload-cert-bg-btn");
  const resetBtn = document.getElementById("reset-cert-bg-btn");

  uploadBtn?.addEventListener("click", () => {
    if (!selectedCertEventId) {
      showAlertDialog({
        titleKey: "common.confirm_title",
        messageKey: "org_dashboard.cert_designer.select_event_first",
        type: "warning"
      });
      return;
    }
    input?.click();
  });

  input?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file || !selectedCertEventId) return;

    if (file.size > 10 * 1024 * 1024) {
      showAlertDialog({
        titleKey: "common.error",
        messageKey: "org_dashboard.cert_designer.img_size_limit",
        type: "error"
      });
      input.value = "";
      return;
    }

    const origText = uploadBtn.innerHTML;
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>${t("common.loading", "Uploading...")}</span>`;

    try {
      const formData = new FormData();
      formData.append("certificateBackground", file);
      const res = await updateActivity(selectedCertEventId, formData);
      const updatedEv = res.event || res.activity || {};

      const newBgUrl = updatedEv.certificateBackground || URL.createObjectURL(file);
      const idx = currentEvents.findIndex(ev => ev._id === selectedCertEventId);
      if (idx !== -1) {
        currentEvents[idx].certificateBackground = newBgUrl;
        renderCertBgPanel(currentEvents[idx]);
      }

      await showAlertDialog({
        titleKey: "org_dashboard.cert_designer.save_success_title",
        messageKey: "org_dashboard.cert_designer.bg_upload_success",
        type: "success"
      });
    } catch (err) {
      console.error("Update certificate background error:", err);
      showAlertDialog({
        titleKey: "common.error",
        message: `${t("org_dashboard.cert_designer.bg_upload_failed", "Failed to update certificate background")}: ${err.message || "Unknown error"}`,
        type: "error"
      });
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = origText;
      input.value = "";
    }
  });

  resetBtn?.addEventListener("click", async () => {
    if (!selectedCertEventId) return;
    const confirmed = await showConfirmDialog({
      titleKey: "common.confirm_title",
      messageKey: "org_dashboard.reset_cert_template_confirm",
      confirmTextKey: "common.confirm_btn",
      type: "warning"
    });
    if (!confirmed) return;

    const origText = resetBtn.innerHTML;
    resetBtn.disabled = true;
    resetBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>${t("common.loading", "Resetting...")}</span>`;

    try {
      const formData = new FormData();
      formData.append("certificateBackground", "");
      await updateActivity(selectedCertEventId, formData);

      const idx = currentEvents.findIndex(ev => ev._id === selectedCertEventId);
      if (idx !== -1) {
        currentEvents[idx].certificateBackground = "";
        renderCertBgPanel(currentEvents[idx]);
      }

      await showAlertDialog({
        titleKey: "org_dashboard.cert_designer.save_success_title",
        messageKey: "org_dashboard.cert_designer.bg_reset_success",
        type: "success"
      });
    } catch (err) {
      console.error("Reset certificate background error:", err);
      showAlertDialog({
        titleKey: "common.error",
        message: `${t("org_dashboard.cert_designer.bg_reset_failed", "Failed to reset certificate background")}: ${err.message || "Unknown error"}`,
        type: "error"
      });
    } finally {
      resetBtn.disabled = false;
      resetBtn.innerHTML = origText;
    }
  });
}

// ─── Canva Certificate Layout Designer ───

const DEFAULT_CERT_CONFIG = {
  isCustom: true,
  fields: {
    userName: {
      enabled: true,
      x: 50.0,
      y: 42.0,
      fontFamily: 'Playfair Display',
      fontSize: 44,
      fontWeight: '700',
      color: '#0f172a',
      align: 'center',
      letterSpacing: 0,
      uppercase: false,
    },
    qrCode: {
      enabled: true,
      x: 10.0,
      y: 82.0,
      size: 80,
      qrStyle: 'standard',
      qrFrame: 'box',
      qrColorDark: '#0f172a',
      qrColorLight: '#ffffff',
      qrTransparentBg: false,
      qrBorderColor: '#cbd5e1',
      qrBorderWidth: 1,
      qrRadius: 8,
    },
    certCode: {
      enabled: true,
      x: 18.0,
      y: 85.0,
      fontFamily: 'monospace',
      fontSize: 12,
      fontWeight: '700',
      color: '#334155',
      align: 'left',
      letterSpacing: 1,
      uppercase: true,
    },
    issueDate: {
      enabled: true,
      x: 88.0,
      y: 85.0,
      fontFamily: 'Plus Jakarta Sans',
      fontSize: 12,
      fontWeight: '500',
      color: '#475569',
      align: 'right',
      letterSpacing: 0,
      uppercase: false,
    },
    eventTitle: {
      enabled: false,
      x: 50.0,
      y: 54.0,
      fontFamily: 'Plus Jakarta Sans',
      fontSize: 22,
      fontWeight: '700',
      color: '#0f172a',
      align: 'center',
      letterSpacing: 0,
      uppercase: false,
    },
    customText: {
      enabled: false,
      isCustomText: true,
      text: 'Đã hoàn thành xuất sắc hoạt động',
      x: 50.0,
      y: 49.0,
      fontFamily: 'Plus Jakarta Sans',
      fontSize: 14,
      fontWeight: '500',
      color: '#475569',
      align: 'center',
      letterSpacing: 0,
      uppercase: false,
    },
  },
};

function initCertLayoutDesigner() {
  const overlay = document.getElementById("cert-designer-overlay");
  const openBtn = document.getElementById("open-cert-designer-btn");
  const closeBtn = document.getElementById("cert-designer-close-btn");
  const backdrop = document.getElementById("cert-designer-backdrop");
  const resetBtn = document.getElementById("cert-designer-reset-btn");
  const saveBtn = document.getElementById("cert-designer-save-btn");
  const sampleBtn = document.getElementById("cert-designer-sample-btn");
  const sampleBtnText = document.getElementById("cert-sample-btn-text");
  const undoBtn = document.getElementById("cert-designer-undo-btn");
  const redoBtn = document.getElementById("cert-designer-redo-btn");

  const stage = document.getElementById("cert-canvas-stage");
  const artboardWrapper = document.getElementById("cert-artboard-wrapper");
  const artboard = document.getElementById("cert-artboard");
  const bgImg = document.getElementById("cert-artboard-bg-img");
  const noBgNotice = document.getElementById("cert-artboard-no-bg-notice");
  const scaleIndicator = document.getElementById("cert-scale-indicator");

  const customFieldsContainer = document.getElementById("cert-artboard-custom-fields");
  const layersContainer = document.getElementById("cert-layers-container");
  const layersTotalCount = document.getElementById("cert-layers-total-count");
  const fieldActiveName = document.getElementById("field-active-name");
  const fieldActiveBadge = document.getElementById("field-active-type-badge");
  const addCustomTextBtn = document.getElementById("btn-add-custom-text");
  const deleteFieldBtn = document.getElementById("field-ctrl-delete-btn");
  const duplicateFieldBtn = document.getElementById("field-ctrl-duplicate-btn");
  const quickCenterBtn = document.getElementById("btn-quick-center-x");
  const quickCenterYBtn = document.getElementById("btn-quick-center-y");
  const spacingSelect = document.getElementById("field-ctrl-spacing");
  const uppercaseBtn = document.getElementById("field-ctrl-uppercase-btn");
  const artboardQrCanvas = document.getElementById("cert-artboard-qr-canvas");
  const guideLineX = document.getElementById("cert-guide-line-x");
  const guideLineY = document.getElementById("cert-guide-line-y");
  const magnetLineX = document.getElementById("cert-magnet-line-x");
  const magnetLineY = document.getElementById("cert-magnet-line-y");
  const snapBadge = document.getElementById("cert-snap-badge");

  // QR Inspector Controls
  const qrGroup = document.getElementById("field-ctrl-qrcode-group");
  const qrSizeSlider = document.getElementById("field-ctrl-qr-size");
  const qrSizeVal = document.getElementById("field-ctrl-qr-size-val");
  const qrFrameSelect = document.getElementById("field-ctrl-qr-frame");
  const qrColorInput = document.getElementById("field-ctrl-qr-color");
  const qrColorHex = document.getElementById("field-ctrl-qr-color-hex");
  const qrBorderColorInput = document.getElementById("field-ctrl-qr-border-color");
  const qrBorderHex = document.getElementById("field-ctrl-qr-border-hex");
  const qrTransparentInput = document.getElementById("field-ctrl-qr-transparent");
  const qrFrameOptions = document.getElementById("field-ctrl-qr-frame-options");

  const toggleGridBtn = document.getElementById("cert-toggle-grid-btn");
  const gridStatusText = document.getElementById("cert-grid-status-text");
  const gridSizeSelect = document.getElementById("cert-grid-size-select");
  const toggleMagnetBtn = document.getElementById("cert-toggle-magnet-btn");
  const magnetStatusText = document.getElementById("cert-magnet-status-text");
  const artboardGrid = document.getElementById("cert-artboard-grid");

  if (!overlay || !openBtn) return;

  let currentConfig = JSON.parse(JSON.stringify(DEFAULT_CERT_CONFIG));
  let activeFieldKey = "userName";
  let isSampleMode = true;
  let currentArtboardScale = 1;

  let isGridVisible = false;
  let currentGridType = "50";
  let isMagnetActive = true;

  // History Stack for Undo / Forward (Ctrl+Z / Ctrl+Y)
  const MAX_HISTORY = 40;
  let history = [];
  let historyIndex = -1;
  let isRestoringHistory = false;
  let arrowNudgeDebounce = null;

  function createSnapshot() {
    return {
      config: JSON.parse(JSON.stringify(currentConfig)),
      activeFieldKey: activeFieldKey,
    };
  }

  function updateUndoRedoUI() {
    const canUndo = historyIndex > 0;
    const canRedo = historyIndex >= 0 && historyIndex < history.length - 1;

    if (undoBtn) {
      undoBtn.disabled = !canUndo;
    }
    if (redoBtn) {
      redoBtn.disabled = !canRedo;
    }
  }

  function pushHistoryState() {
    if (isRestoringHistory) return;

    const snapshot = createSnapshot();

    if (historyIndex >= 0 && history[historyIndex]) {
      const currStr = JSON.stringify(history[historyIndex].config);
      const newStr = JSON.stringify(snapshot.config);
      if (currStr === newStr) {
        history[historyIndex].activeFieldKey = activeFieldKey;
        return;
      }
    }

    if (historyIndex >= 0) {
      history = history.slice(0, historyIndex + 1);
    } else {
      history = [];
    }

    history.push(snapshot);
    if (history.length > MAX_HISTORY) {
      history.shift();
    }
    historyIndex = history.length - 1;
    updateUndoRedoUI();
  }

  function restoreHistoryState(snapshot) {
    if (!snapshot || !snapshot.config) return;

    isRestoringHistory = true;
    try {
      currentConfig = JSON.parse(JSON.stringify(snapshot.config));
      activeFieldKey = snapshot.activeFieldKey || "userName";
      if (!currentConfig.fields[activeFieldKey]) {
        activeFieldKey = "userName";
      }

      renderArtboardCustomFields();
      renderLayersPanel();
      applyAllFieldsToDOM();
      syncInspectorUI();
      updateUndoRedoUI();
    } finally {
      isRestoringHistory = false;
    }
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    restoreHistoryState(history[historyIndex]);
  }

  function redo() {
    if (historyIndex < 0 || historyIndex >= history.length - 1) return;
    historyIndex++;
    restoreHistoryState(history[historyIndex]);
  }

  const STATIC_FIELD_KEYS = new Set(["userName", "qrCode", "certCode", "issueDate", "eventTitle"]);

  const STATIC_CHIP_META = {
    userName: { labelKey: "org_dashboard.cert_designer.field_userName", defaultLabel: "Họ và tên", icon: "fa-user", badge: "User" },
    qrCode: { labelKey: "org_dashboard.cert_designer.field_qrCode", defaultLabel: "Mã QR Check", icon: "fa-qrcode", badge: "QR" },
    certCode: { labelKey: "org_dashboard.cert_designer.field_certCode", defaultLabel: "Mã chứng chỉ", icon: "fa-barcode", badge: "Code" },
    issueDate: { labelKey: "org_dashboard.cert_designer.field_issueDate", defaultLabel: "Ngày cấp", icon: "fa-calendar-days", badge: "Date" },
    eventTitle: { labelKey: "org_dashboard.cert_designer.field_eventTitle", defaultLabel: "Tên sự kiện", icon: "fa-award", badge: "Event" },
  };

  function getFieldLabel(key) {
    const meta = STATIC_CHIP_META[key];
    if (meta) {
      return t(meta.labelKey, meta.defaultLabel);
    }
    const field = currentConfig?.fields?.[key];
    if (field && field.text) {
      const txt = field.text.replace(/\n/g, " ").trim();
      return txt ? (txt.length > 20 ? txt.slice(0, 18) + "..." : txt) : t("org_dashboard.cert_designer.field_customText", "Văn bản tùy chỉnh");
    }
    return t("org_dashboard.cert_designer.field_customText", "Văn bản tùy chỉnh");
  }

  // Render & Update Grid Overlay
  function renderArtboardGrid() {
    if (!artboardGrid || !toggleGridBtn || !gridStatusText) return;

    if (!isGridVisible) {
      artboardGrid.classList.add("hidden");
      toggleGridBtn.className = "px-2.5 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold spring-ease flex items-center gap-1.5 cursor-pointer shadow-2xs";
      gridStatusText.textContent = t("org_dashboard.cert_designer.status_off", "TẮT");
      gridStatusText.className = "text-slate-500 font-bold";
      const icon = toggleGridBtn.querySelector("i");
      if (icon) icon.className = "fa-solid fa-border-all text-slate-400";
      return;
    }

    artboardGrid.classList.remove("hidden");
    toggleGridBtn.className = "px-2.5 py-1.5 rounded-xl border border-sky-400 bg-sky-50 text-sky-700 font-semibold spring-ease flex items-center gap-1.5 cursor-pointer shadow-2xs active";
    gridStatusText.textContent = t("org_dashboard.cert_designer.status_on", "BẬT");
    gridStatusText.className = "text-sky-600 font-bold";
    const icon = toggleGridBtn.querySelector("i");
    if (icon) icon.className = "fa-solid fa-border-all text-sky-600";

    if (currentGridType === "20") {
      artboardGrid.style.backgroundSize = "20px 20px";
      artboardGrid.style.backgroundImage = "linear-gradient(to right, rgba(148, 163, 184, 0.22) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.22) 1px, transparent 1px)";
    } else if (currentGridType === "50") {
      artboardGrid.style.backgroundSize = "50px 50px";
      artboardGrid.style.backgroundImage = "linear-gradient(to right, rgba(148, 163, 184, 0.28) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.28) 1px, transparent 1px)";
    } else if (currentGridType === "100") {
      artboardGrid.style.backgroundSize = "100px 100px";
      artboardGrid.style.backgroundImage = "linear-gradient(to right, rgba(148, 163, 184, 0.35) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.35) 1px, transparent 1px)";
    } else if (currentGridType === "5pct") {
      artboardGrid.style.backgroundSize = "5% 5%";
      artboardGrid.style.backgroundImage = "linear-gradient(to right, rgba(56, 189, 248, 0.25) 1px, transparent 1px), linear-gradient(to bottom, rgba(56, 189, 248, 0.25) 1px, transparent 1px)";
    } else if (currentGridType === "thirds") {
      artboardGrid.style.backgroundSize = "100% 100%";
      artboardGrid.style.backgroundImage = "linear-gradient(to right, transparent calc(33.333% - 1px), rgba(245, 158, 11, 0.45) calc(33.333% - 1px), rgba(245, 158, 11, 0.45) calc(33.333% + 1px), transparent calc(33.333% + 1px), transparent calc(66.667% - 1px), rgba(245, 158, 11, 0.45) calc(66.667% - 1px), rgba(245, 158, 11, 0.45) calc(66.667% + 1px), transparent calc(66.667% + 1px)), linear-gradient(to bottom, transparent calc(33.333% - 1px), rgba(245, 158, 11, 0.45) calc(33.333% - 1px), rgba(245, 158, 11, 0.45) calc(33.333% + 1px), transparent calc(33.333% + 1px), transparent calc(66.667% - 1px), rgba(245, 158, 11, 0.45) calc(66.667% - 1px), rgba(245, 158, 11, 0.45) calc(66.667% + 1px), transparent calc(66.667% + 1px))";
    }
  }

  // Update Magnet Toggle Button UI
  function updateMagnetBtnUI() {
    if (!toggleMagnetBtn || !magnetStatusText) return;

    if (isMagnetActive) {
      toggleMagnetBtn.className = "px-3 py-1.5 rounded-xl bg-primary text-white font-bold spring-ease flex items-center gap-1.5 cursor-pointer shadow-2xs active";
      magnetStatusText.textContent = t("org_dashboard.cert_designer.status_on", "BẬT");
    } else {
      toggleMagnetBtn.className = "px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-500 font-semibold spring-ease flex items-center gap-1.5 cursor-pointer shadow-2xs";
      magnetStatusText.textContent = t("org_dashboard.cert_designer.status_off", "TẮT");
    }
  }

  // Responsive scaling of 1200 x 850 artboard inside stage
  function updateArtboardScale() {
    if (!stage || !artboardWrapper || overlay.hasAttribute("hidden")) return;
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    if (!stageWidth || !stageHeight) return;

    const pad = 36;
    const artboardH = artboard.offsetHeight || 850;
    const scaleX = (stageWidth - pad) / 1200;
    const scaleY = (stageHeight - pad) / artboardH;
    currentArtboardScale = Math.min(scaleX, scaleY, 1);
    if (currentArtboardScale < 0.2) currentArtboardScale = 0.2;

    artboardWrapper.style.transform = `scale(${currentArtboardScale})`;
    artboardWrapper.style.transformOrigin = "center center";
    if (scaleIndicator) {
      scaleIndicator.textContent = `${Math.round(currentArtboardScale * 100)}%`;
    }
  }

  window.addEventListener("resize", () => {
    if (!overlay.hidden) updateArtboardScale();
  });

  // Render dynamic custom field elements on the artboard
  function renderArtboardCustomFields() {
    if (!customFieldsContainer) return;
    customFieldsContainer.innerHTML = "";

    Object.entries(currentConfig.fields).forEach(([key, field]) => {
      if (STATIC_FIELD_KEYS.has(key)) return;

      const box = document.createElement("div");
      box.id = `field-box-${key}`;
      box.className = "cert-draggable-field group absolute cursor-move p-2 rounded-lg border-2 border-transparent hover:border-primary/50 transition-colors flex items-center gap-1.5 max-w-[800px]";
      box.innerHTML = `
        <span class="cert-field-content font-bold whitespace-pre-line break-words text-center"></span>
        <span class="cert-field-badge absolute -top-5 left-1/2 -translate-x-1/2 px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-primary text-white pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">${t("org_dashboard.cert_designer.field_customText", "Văn bản")}</span>
      `;
      customFieldsContainer.appendChild(box);
      attachDragToElement(box);
    });
  }

  // Highlight selected element on artboard
  function highlightLayerOnArtboard(key) {
    document.querySelectorAll(".cert-draggable-field").forEach(el => {
      el.classList.remove("ring-2", "ring-primary", "ring-offset-2", "!border-primary", "bg-primary/5");
    });
    const activeEl = document.getElementById(`field-box-${key}`);
    if (activeEl) {
      activeEl.classList.add("ring-2", "ring-primary", "ring-offset-2", "!border-primary", "bg-primary/5");
    }
  }

  // Duplicate a custom field
  function duplicateCustomField(key) {
    const source = currentConfig.fields[key];
    if (!source) return;

    const newKey = `custom_${Date.now()}`;
    currentConfig.fields[newKey] = JSON.parse(JSON.stringify(source));
    currentConfig.fields[newKey].x = Math.min(90, (source.x || 50) + 2.0);
    currentConfig.fields[newKey].y = Math.min(92, (source.y || 50) + 3.5);
    currentConfig.fields[newKey].enabled = true;
    currentConfig.fields[newKey].isCustomText = true;

    renderArtboardCustomFields();
    activeFieldKey = newKey;
    renderLayersPanel();
    applyAllFieldsToDOM();
    syncInspectorUI();
    pushHistoryState();
  }

  async function deleteCustomField(key) {
    const field = currentConfig.fields[key];
    const isCustom = key.startsWith("custom") || field?.isCustomText;
    if (!isCustom) {
      alert(t("cert_designer.only_custom_text_deletable", "Chỉ có thể xóa các khối text tùy chỉnh."));
      return;
    }

    const confirmed = await showConfirmDialog({
      titleKey: "common.delete_confirm_title",
      messageKey: "org_dashboard.delete_text_block_confirm",
      confirmTextKey: "common.delete_btn",
      type: "danger"
    });
    if (!confirmed) return;

    const el = document.getElementById(`field-box-${key}`);
    if (el) el.remove();

    delete currentConfig.fields[key];
    activeFieldKey = "userName";
    renderLayersPanel();
    applyAllFieldsToDOM();
    syncInspectorUI();
    pushHistoryState();
  }

  // Quick preset add button handler
  function addPresetCustomText(presetType) {
    const newKey = `custom_${Date.now()}`;
    let config = {
      enabled: true,
      isCustomText: true,
      x: 50.0,
      align: "center",
      letterSpacing: 0,
      uppercase: false,
    };

    const isEn = getLang() === "en";
    if (presetType === "heading") {
      config = {
        ...config,
        text: isEn ? "CERTIFICATE OF RECOGNITION" : "GIẤY CHỨNG NHẬN",
        y: 28.0,
        fontFamily: "Playfair Display",
        fontSize: 32,
        fontWeight: "800",
        color: "#0f172a",
        letterSpacing: 2,
        uppercase: true,
      };
    } else if (presetType === "award") {
      config = {
        ...config,
        text: isEn ? "OUTSTANDING RECOGNITION" : "DANH HIỆU XUẤT SẮC",
        y: 48.0,
        fontFamily: "Playfair Display",
        fontSize: 20,
        fontWeight: "700",
        color: "#b45309",
        letterSpacing: 1,
        uppercase: true,
      };
    } else if (presetType === "body") {
      config = {
        ...config,
        text: isEn
          ? "Has successfully completed all training requirements\nand actively contributed to the program"
          : "Đã hoàn thành xuất sắc các nội dung đào tạo\nvà đóng góp tích cực cho chương trình",
        y: 56.0,
        fontFamily: "Plus Jakarta Sans",
        fontSize: 14,
        fontWeight: "500",
        color: "#475569",
      };
    } else if (presetType === "signature") {
      config = {
        ...config,
        text: isEn
          ? "Head of Organization\n(Signature & Full Name)"
          : "Trưởng Ban Tổ Chức\n(Ký và ghi rõ họ tên)",
        y: 74.0,
        fontFamily: "Playfair Display",
        fontSize: 13,
        fontWeight: "700",
        color: "#0f172a",
      };
    } else {
      config = {
        ...config,
        text: isEn ? "New text block" : "Đoạn văn bản mới",
        y: 60.0,
        fontFamily: "Playfair Display",
        fontSize: 22,
        fontWeight: "700",
        color: "#0f172a",
      };
    }

    currentConfig.fields[newKey] = config;
    renderArtboardCustomFields();
    activeFieldKey = newKey;
    renderLayersPanel();
    applyAllFieldsToDOM();
    syncInspectorUI();
    pushHistoryState();
  }

  // Render comprehensive Layers Panel (Custom Layers & System Fields)
  function renderLayersPanel() {
    if (!layersContainer) return;
    layersContainer.innerHTML = "";

    const allKeys = Object.keys(currentConfig.fields);
    const customKeys = allKeys.filter(k => !STATIC_FIELD_KEYS.has(k));
    const systemKeys = allKeys.filter(k => STATIC_FIELD_KEYS.has(k));

    if (layersTotalCount) {
      layersTotalCount.textContent = `${allKeys.length} ${t("org_dashboard.cert_designer.layers_count_suffix", "lớp")}`;
    }

    // 1. Custom Text Layers Section
    const customSection = document.createElement("div");
    customSection.className = "space-y-1.5";

    const customHeader = document.createElement("div");
    customHeader.className = "flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1 pt-1";
    customHeader.innerHTML = `
      <div class="flex items-center gap-1">
        <i class="fa-solid fa-pen-nib text-[9px] text-amber-500"></i>
        <span>${t("org_dashboard.cert_designer.custom_layers_header", "Lớp tùy chỉnh")}</span>
      </div>
      <span class="font-mono text-slate-500">${customKeys.length}</span>
    `;
    customSection.appendChild(customHeader);

    if (customKeys.length === 0) {
      const emptyNote = document.createElement("div");
      emptyNote.className = "p-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 text-center";
      emptyNote.innerHTML = `<span class="text-[11px] text-slate-400">${t("org_dashboard.cert_designer.no_custom_text", "Chưa có text tùy chỉnh. Bấm <strong>+ Thêm Text</strong> ở trên để tạo.")}</span>`;
      customSection.appendChild(emptyNote);
    } else {
      customKeys.forEach(key => {
        const field = currentConfig.fields[key];
        const isCurrent = key === activeFieldKey;
        const isHidden = field.enabled === false;

        const row = document.createElement("div");
        row.dataset.layerKey = key;
        row.className = `layer-item-row group flex items-center justify-between p-2 rounded-xl border text-xs font-semibold spring-ease cursor-pointer ${isCurrent
            ? "border-primary bg-primary/5 shadow-2xs ring-1 ring-primary/30"
            : isHidden
              ? "border-slate-200 bg-slate-50/50 opacity-60 hover:opacity-100"
              : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/70"
          }`;

        let textSnippet = field.text ? field.text.replace(/\n/g, " ").trim() : t("org_dashboard.cert_designer.field_customText", "Văn bản tùy chỉnh");
        if (textSnippet.length > 20) textSnippet = textSnippet.slice(0, 18) + "...";

        row.innerHTML = `
          <div class="flex items-center gap-2 min-w-0 flex-1 pr-1.5 pointer-events-none">
            <i class="fa-solid fa-font text-[11px] shrink-0 ${isCurrent ? 'text-primary' : 'text-slate-400'}"></i>
            <div class="min-w-0">
              <div class="layer-title font-bold text-slate-800 truncate text-[11px]">${textSnippet}</div>
              <div class="text-[9px] font-mono text-slate-400">X: ${Math.round(field.x)}% Y: ${Math.round(field.y)}%</div>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button type="button" class="btn-layer-toggle-eye w-6 h-6 rounded-md hover:bg-slate-200/80 flex items-center justify-center cursor-pointer text-slate-500 hover:text-slate-800" title="${isHidden ? t("org_dashboard.cert_designer.show_layer", "Hiện lớp này") : t("org_dashboard.cert_designer.hide_layer", "Ẩn lớp này")}">
              <i class="fa-solid ${isHidden ? 'fa-eye-slash text-slate-400' : 'fa-eye text-primary'} text-[11px]"></i>
            </button>
            <button type="button" class="btn-layer-duplicate w-6 h-6 rounded-md hover:bg-slate-200/80 flex items-center justify-center cursor-pointer text-slate-400 hover:text-primary" title="${t("org_dashboard.cert_designer.duplicate_layer", "Nhân bản lớp")}">
              <i class="fa-regular fa-copy text-[11px]"></i>
            </button>
            <button type="button" class="btn-layer-delete w-6 h-6 rounded-md hover:bg-red-100 flex items-center justify-center cursor-pointer text-slate-400 hover:text-red-600" title="${t("org_dashboard.cert_designer.delete_layer", "Xóa lớp")}">
              <i class="fa-solid fa-trash-can text-[11px]"></i>
            </button>
          </div>
        `;

        row.addEventListener("click", (e) => {
          if (e.target.closest("button")) return;
          activeFieldKey = key;
          syncInspectorUI();
          highlightLayerOnArtboard(key);
        });

        row.querySelector(".btn-layer-toggle-eye").addEventListener("click", (e) => {
          e.stopPropagation();
          field.enabled = field.enabled === false ? true : false;
          applyFieldStyleToDOM(key);
          renderLayersPanel();
          syncInspectorUI();
          pushHistoryState();
        });

        row.querySelector(".btn-layer-duplicate").addEventListener("click", (e) => {
          e.stopPropagation();
          duplicateCustomField(key);
        });

        row.querySelector(".btn-layer-delete").addEventListener("click", (e) => {
          e.stopPropagation();
          deleteCustomField(key);
        });

        customSection.appendChild(row);
      });
    }

    layersContainer.appendChild(customSection);

    // 2. System Fields Section
    const systemSection = document.createElement("div");
    systemSection.className = "space-y-1.5 pt-2 border-t border-slate-100";

    const systemHeader = document.createElement("div");
    systemHeader.className = "flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1";
    systemHeader.innerHTML = `
      <div class="flex items-center gap-1">
        <i class="fa-solid fa-shield-halved text-[9px] text-primary"></i>
        <span>${t("org_dashboard.cert_designer.system_layers_header", "Trường hệ thống")}</span>
      </div>
      <span class="font-mono text-slate-500">${systemKeys.length}</span>
    `;
    systemSection.appendChild(systemHeader);

    systemKeys.forEach(key => {
      const field = currentConfig.fields[key];
      const meta = STATIC_CHIP_META[key] || { labelKey: "", defaultLabel: key, icon: "fa-font", badge: "SYS" };
      const fieldLabel = getFieldLabel(key);
      const isCurrent = key === activeFieldKey;
      const isHidden = field.enabled === false;

      const row = document.createElement("div");
      row.dataset.layerKey = key;
      row.className = `layer-item-row group flex items-center justify-between p-2 rounded-xl border text-xs font-semibold spring-ease cursor-pointer ${isCurrent
          ? "border-primary bg-primary/5 shadow-2xs ring-1 ring-primary/30"
          : isHidden
            ? "border-slate-200 bg-slate-50/50 opacity-60 hover:opacity-100"
            : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/70"
        }`;

      row.innerHTML = `
        <div class="flex items-center gap-2 min-w-0 flex-1 pr-1.5 pointer-events-none">
          <i class="fa-solid ${meta.icon} text-[11px] shrink-0 ${isCurrent ? 'text-primary' : 'text-slate-400'}"></i>
          <div class="min-w-0">
            <div class="layer-title font-bold text-slate-800 truncate text-[11px]">${fieldLabel}</div>
            <div class="text-[9px] font-mono text-slate-400">X: ${Math.round(field.x)}% Y: ${Math.round(field.y)}%</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-[9px] font-mono px-1.5 py-0.2 rounded ${isCurrent ? 'bg-primary/10 text-primary font-bold' : 'bg-slate-100 text-slate-500'}">${meta.badge}</span>
          <button type="button" class="btn-layer-toggle-eye w-6 h-6 rounded-md hover:bg-slate-200/80 flex items-center justify-center cursor-pointer text-slate-500 hover:text-slate-800" title="${isHidden ? t("org_dashboard.cert_designer.show_field", "Hiện trường này") : t("org_dashboard.cert_designer.hide_field", "Ẩn trường này")}">
            <i class="fa-solid ${isHidden ? 'fa-eye-slash text-slate-400' : 'fa-eye text-primary'} text-[11px]"></i>
          </button>
        </div>
      `;

      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        activeFieldKey = key;
        syncInspectorUI();
        highlightLayerOnArtboard(key);
      });

      row.querySelector(".btn-layer-toggle-eye").addEventListener("click", (e) => {
        e.stopPropagation();
        field.enabled = field.enabled === false ? true : false;
        applyFieldStyleToDOM(key);
        renderLayersPanel();
        syncInspectorUI();
        pushHistoryState();
      });

      systemSection.appendChild(row);
    });

    layersContainer.appendChild(systemSection);
  }

  // Apply visual styling to an artboard field element
  function applyFieldStyleToDOM(key) {
    const field = currentConfig.fields[key];
    const el = document.getElementById(`field-box-${key}`);
    if (!field || !el) return;

    // Visibility
    if (field.enabled === false) {
      el.classList.add("hidden");
    } else {
      el.classList.remove("hidden");
    }

    // Position & Transform Anchor
    el.style.left = `${field.x}%`;
    el.style.top = `${field.y}%`;

    const align = field.align || "center";
    let translateX = "-50%";
    if (align === "left") translateX = "0%";
    else if (align === "right") translateX = "-100%";

    el.style.transform = `translate(${translateX}, -50%)`;

    // Content element inside
    const contentEl = el.querySelector(".cert-field-content");

    if (key === "qrCode") {
      const sz = field.size || 80;
      el.style.width = `${sz}px`;
      el.style.height = `${sz}px`;
      el.style.transform = `translate(-50%, -50%)`;

      // Live styled QR drawing on canvas
      const qrCanvas = el.querySelector("canvas") || artboardQrCanvas || document.getElementById("cert-artboard-qr-canvas");
      if (qrCanvas) {
        const sampleUrl = "https://springwave.io.vn/certificate.html?code=SW-202609-SAMPLE";
        drawStyledQR(qrCanvas, sampleUrl, {
          size: sz,
          style: field.qrStyle || "standard",
          frame: field.qrFrame || "box",
          colorDark: field.qrColorDark || "#0f172a",
          colorLight: field.qrColorLight || "#ffffff",
          transparentBg: !!field.qrTransparentBg,
          borderColor: field.qrBorderColor || "#cbd5e1",
          borderWidth: field.qrBorderWidth || 1,
          borderRadius: field.qrRadius || 8,
        });
      }
      return;
    }

    if (contentEl) {
      let family = field.fontFamily || "Playfair Display";
      if (family === "Cinzel") family = "Lora";
      contentEl.style.fontFamily = `'${family}', sans-serif`;
      contentEl.style.fontSize = `${field.fontSize || 16}px`;
      contentEl.style.fontWeight = field.fontWeight || "700";
      contentEl.style.color = field.color || "#0f172a";
      contentEl.style.textAlign = align;
      contentEl.style.letterSpacing = field.letterSpacing ? `${field.letterSpacing}px` : "normal";
      contentEl.style.textTransform = field.uppercase ? "uppercase" : "none";
      contentEl.style.whiteSpace = "pre-line";
      contentEl.style.wordBreak = "break-word";

      const isCustom = key.startsWith("custom") || field.isCustomText;
      const sampleUser = t("org_dashboard.cert_designer.sample_user", "Nguyễn Văn A");
      const sampleEvent = t("org_dashboard.cert_designer.sample_event", "Hội Thảo Công Nghệ 2026");
      const sampleDate = t("org_dashboard.cert_designer.sample_date", "Cấp ngày: 15/09/2026");
      const sampleCustomFallback = t("org_dashboard.cert_designer.sample_custom", "Đoạn văn bản mẫu");

      if (isCustom) {
        let textVal = field.text !== undefined ? field.text : (isSampleMode ? sampleCustomFallback : "{{customText}}");
        if (isSampleMode && typeof textVal === "string") {
          textVal = textVal
            .replace(/\{\{fullName\}\}/g, sampleUser)
            .replace(/\{\{eventTitle\}\}/g, sampleEvent)
            .replace(/\{\{issueDate\}\}/g, "15/09/2026")
            .replace(/\{\{certificateCode\}\}/g, "SW-202609-SAMPLE");
        }
        contentEl.textContent = textVal;
      } else if (key === "userName") {
        contentEl.textContent = isSampleMode ? sampleUser : "{{fullName}}";
      } else if (key === "certCode") {
        contentEl.textContent = isSampleMode ? "SW-202609-SAMPLE" : "{{certificateCode}}";
      } else if (key === "issueDate") {
        contentEl.textContent = isSampleMode ? sampleDate : "{{issueDate}}";
      } else if (key === "eventTitle") {
        const ev = currentEvents.find(e => e._id === selectedCertEventId);
        contentEl.textContent = isSampleMode ? (ev?.title || sampleEvent) : "{{eventTitle}}";
      }
    }
  }

  function applyAllFieldsToDOM() {
    Object.keys(currentConfig.fields).forEach(applyFieldStyleToDOM);
  }

  // Sync right-side inspector controls to match activeFieldKey
  function syncInspectorUI() {
    const field = currentConfig.fields[activeFieldKey] || {};
    const isCustomText = activeFieldKey.startsWith("custom") || field.isCustomText;
    const meta = STATIC_CHIP_META[activeFieldKey];

    // Active field indicator
    if (fieldActiveName) {
      fieldActiveName.textContent = getFieldLabel(activeFieldKey);
    }
    if (fieldActiveBadge) {
      fieldActiveBadge.textContent = isCustomText
        ? t("org_dashboard.cert_designer.badge_custom", "Custom")
        : (meta?.badge || t("org_dashboard.cert_designer.badge_system", "System"));
      fieldActiveBadge.className = isCustomText
        ? "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-50 text-amber-700 border border-amber-200 shrink-0"
        : "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-primary/10 text-primary shrink-0";
    }

    // Layers highlight in Layers Panel
    document.querySelectorAll("#cert-layers-container .layer-item-row").forEach(row => {
      const isCurrent = row.dataset.layerKey === activeFieldKey;
      row.classList.toggle("border-primary", isCurrent);
      row.classList.toggle("bg-primary/5", isCurrent);
      row.classList.toggle("shadow-2xs", isCurrent);
      row.classList.toggle("ring-1", isCurrent);
      row.classList.toggle("ring-primary/30", isCurrent);
    });

    // Artboard field box highlight
    highlightLayerOnArtboard(activeFieldKey);

    // Toggle enabled
    const enabledInput = document.getElementById("field-ctrl-enabled");
    if (enabledInput) enabledInput.checked = field.enabled !== false;

    // Groups
    const fontGroup = document.getElementById("field-ctrl-font-group");
    const sizeGroup = document.getElementById("field-ctrl-size-group");
    const colorGroup = document.getElementById("field-ctrl-color-group");
    const styleGroup = document.getElementById("field-ctrl-style-group");
    const typographyGroup = document.getElementById("field-ctrl-typography-group");
    const customTextGroup = document.getElementById("field-ctrl-customtext-group");
    const sizeLabel = document.getElementById("field-ctrl-size-label");
    const sizeVal = document.getElementById("field-ctrl-size-val");
    const sizeInput = document.getElementById("field-ctrl-size");

    if (activeFieldKey === "qrCode") {
      fontGroup?.classList.add("hidden");
      sizeGroup?.classList.add("hidden");
      colorGroup?.classList.add("hidden");
      styleGroup?.classList.add("hidden");
      typographyGroup?.classList.add("hidden");
      customTextGroup?.classList.add("hidden");
      qrGroup?.classList.remove("hidden");

      // Sync QR Inspector values
      const sz = field.size || 80;
      if (qrSizeSlider) qrSizeSlider.value = sz;
      if (qrSizeVal) qrSizeVal.textContent = `${sz}px`;

      if (qrFrameSelect) qrFrameSelect.value = field.qrFrame || "box";
      if (qrFrameOptions) qrFrameOptions.classList.toggle("hidden", (field.qrFrame || "box") === "none");

      const darkCol = field.qrColorDark || "#0f172a";
      if (qrColorInput) qrColorInput.value = darkCol.length === 7 ? darkCol : "#0f172a";
      if (qrColorHex) qrColorHex.value = darkCol;

      const borderCol = field.qrBorderColor || "#cbd5e1";
      if (qrBorderColorInput) qrBorderColorInput.value = borderCol.length === 7 ? borderCol : "#cbd5e1";
      if (qrBorderHex) qrBorderHex.value = borderCol;

      if (qrTransparentInput) qrTransparentInput.checked = !!field.qrTransparentBg;

      const currentStyle = field.qrStyle || "standard";
      document.querySelectorAll("#field-ctrl-qr-style-group .qr-style-btn").forEach(btn => {
        const isMatch = btn.dataset.style === currentStyle;
        btn.classList.toggle("active", isMatch);
        btn.classList.toggle("border-primary", isMatch);
        btn.classList.toggle("bg-primary/10", isMatch);
        btn.classList.toggle("text-primary", isMatch);
        btn.classList.toggle("text-slate-700", !isMatch);
      });
    } else {
      qrGroup?.classList.add("hidden");
      fontGroup?.classList.remove("hidden");
      sizeGroup?.classList.remove("hidden");
      colorGroup?.classList.remove("hidden");
      styleGroup?.classList.remove("hidden");
      typographyGroup?.classList.remove("hidden");

      if (isCustomText) {
        customTextGroup?.classList.remove("hidden");
        const customValInput = document.getElementById("field-ctrl-custom-val");
        if (customValInput) customValInput.value = field.text || "";
      } else {
        customTextGroup?.classList.add("hidden");
      }

      if (sizeLabel) sizeLabel.textContent = t("org_dashboard.cert_designer.font_size", "Cỡ chữ (Font Size)");
      const fs = field.fontSize || 16;
      if (sizeInput) {
        sizeInput.min = "10";
        sizeInput.max = "90";
        sizeInput.value = fs;
      }
      if (sizeVal) sizeVal.textContent = `${fs}px`;

      const fontSelect = document.getElementById("field-ctrl-font");
      let selectedFamily = field.fontFamily || "Playfair Display";
      if (selectedFamily === "Cinzel") selectedFamily = "Lora";
      if (fontSelect) fontSelect.value = selectedFamily;

      const weightSelect = document.getElementById("field-ctrl-weight");
      if (weightSelect) weightSelect.value = field.fontWeight || "700";

      const colorInput = document.getElementById("field-ctrl-color");
      const hexInput = document.getElementById("field-ctrl-color-hex");
      const colorVal = field.color || "#0f172a";
      if (colorInput) colorInput.value = colorVal.length === 7 ? colorVal : "#0f172a";
      if (hexInput) hexInput.value = colorVal;

      // Spacing
      if (spacingSelect) spacingSelect.value = String(field.letterSpacing || 0);

      // Uppercase
      if (uppercaseBtn) {
        const isUpper = !!field.uppercase;
        uppercaseBtn.classList.toggle("bg-primary", isUpper);
        uppercaseBtn.classList.toggle("text-white", isUpper);
        uppercaseBtn.classList.toggle("border-primary", isUpper);
        uppercaseBtn.classList.toggle("bg-white", !isUpper);
        uppercaseBtn.classList.toggle("text-slate-700", !isUpper);
      }

      // Align buttons
      const currentAlign = field.align || "center";
      document.querySelectorAll("#field-ctrl-align-group .align-btn").forEach(btn => {
        const isMatch = btn.dataset.align === currentAlign;
        btn.classList.toggle("active", isMatch);
        btn.classList.toggle("bg-white", isMatch);
        btn.classList.toggle("text-primary", isMatch);
        btn.classList.toggle("shadow-2xs", isMatch);
        btn.classList.toggle("text-slate-600", !isMatch);
      });
    }

    // Coordinates X & Y
    const xInput = document.getElementById("field-ctrl-x");
    const yInput = document.getElementById("field-ctrl-y");
    if (xInput) xInput.value = field.x !== undefined ? field.x : 50;
    if (yInput) yInput.value = field.y !== undefined ? field.y : 50;
  }

  // Setup Drag-and-Drop using Native Pointer Events on all artboard fields
  function attachDragToElement(el) {
    if (!el || el.dataset.dragAttached === "true") return;
    el.dataset.dragAttached = "true";

    const fieldKey = el.id.replace("field-box-", "");

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialFieldX = 0;
    let initialFieldY = 0;

    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      activeFieldKey = fieldKey;
      syncInspectorUI();

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      initialFieldX = currentConfig.fields[fieldKey]?.x || 50;
      initialFieldY = currentConfig.fields[fieldKey]?.y || 50;

      el.setPointerCapture(e.pointerId);
      el.classList.add("opacity-90", "scale-105", "shadow-xl");
    });

    el.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      e.preventDefault();

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const effectiveScale = currentArtboardScale > 0 ? currentArtboardScale : 1;
      const deltaXPercent = (dx / effectiveScale) / 1200 * 100;
      const deltaYPercent = (dy / effectiveScale) / 850 * 100;

      let newX = Math.round((initialFieldX + deltaXPercent) * 10) / 10;
      let newY = Math.round((initialFieldY + deltaYPercent) * 10) / 10;

      let snappedX = false;
      let snappedY = false;
      let snapLabel = "";

      if (isMagnetActive && !e.altKey) {
        const SNAP_THRESHOLD_X = 1.0;
        const SNAP_THRESHOLD_Y = 1.2;

        // 1. Center Canvas Snap (X=50% and Y=50%)
        if (Math.abs(newX - 50.0) <= SNAP_THRESHOLD_X) {
          newX = 50.0;
          snappedX = true;
          if (guideLineX) {
            guideLineX.style.left = "50%";
            guideLineX.classList.remove("hidden");
          }
          snapLabel = `🎯 ${t("org_dashboard.cert_designer.snap_center_x", "Giữa Canvas (X: 50%)")}`;
        }

        if (Math.abs(newY - 50.0) <= SNAP_THRESHOLD_Y) {
          newY = 50.0;
          snappedY = true;
          if (guideLineY) {
            guideLineY.style.top = "50%";
            guideLineY.classList.remove("hidden");
          }
          snapLabel = snapLabel
            ? `🎯 ${t("org_dashboard.cert_designer.snap_center_both", "Tâm Canvas (50%, 50%)")}`
            : `🎯 ${t("org_dashboard.cert_designer.snap_center_y", "Giữa Canvas (Y: 50%)")}`;
        }

        // 2. Inter-Element Smart Guides (Align with other active fields)
        const otherEntries = Object.entries(currentConfig.fields).filter(
          ([k, f]) => k !== fieldKey && f && f.enabled !== false
        );

        for (const [otherKey, otherField] of otherEntries) {
          const otherLabel = getFieldLabel(otherKey);

          if (!snappedX && Math.abs(newX - otherField.x) <= SNAP_THRESHOLD_X) {
            newX = otherField.x;
            snappedX = true;
            if (magnetLineX) {
              magnetLineX.style.left = `${newX}%`;
              magnetLineX.classList.remove("hidden");
            }
            snapLabel = snapLabel || `🧲 ${t("org_dashboard.cert_designer.align_col", "Cột dọc thẳng")}: ${otherLabel}`;
          }

          if (!snappedY && Math.abs(newY - otherField.y) <= SNAP_THRESHOLD_Y) {
            newY = otherField.y;
            snappedY = true;
            if (magnetLineY) {
              magnetLineY.style.top = `${newY}%`;
              magnetLineY.classList.remove("hidden");
            }
            snapLabel = snapLabel || `🧲 ${t("org_dashboard.cert_designer.align_row", "Hàng ngang thẳng")}: ${otherLabel}`;
          }
        }

        // 3. Grid Snapping (when Grid is active and not already snapped)
        if (isGridVisible) {
          if (!snappedX) {
            let stepX = 0;
            if (currentGridType === "20") stepX = (20 / 1200) * 100;
            else if (currentGridType === "50") stepX = (50 / 1200) * 100;
            else if (currentGridType === "100") stepX = (100 / 1200) * 100;
            else if (currentGridType === "thirds") stepX = 33.333;
            else if (currentGridType === "5pct") stepX = 5.0;

            if (stepX > 0) {
              const nearestStep = Math.round(newX / stepX) * stepX;
              if (Math.abs(newX - nearestStep) <= 0.6) {
                newX = Math.round(nearestStep * 10) / 10;
                snappedX = true;
                if (guideLineX) {
                  guideLineX.style.left = `${newX}%`;
                  guideLineX.classList.remove("hidden");
                }
                snapLabel = snapLabel || `📐 ${t("org_dashboard.cert_designer.grid_label", "Lưới")} X: ${newX}%`;
              }
            }
          }

          if (!snappedY) {
            let stepY = 0;
            if (currentGridType === "20") stepY = (20 / 850) * 100;
            else if (currentGridType === "50") stepY = (50 / 850) * 100;
            else if (currentGridType === "100") stepY = (100 / 850) * 100;
            else if (currentGridType === "thirds") stepY = 33.333;
            else if (currentGridType === "5pct") stepY = 5.0;

            if (stepY > 0) {
              const nearestStep = Math.round(newY / stepY) * stepY;
              if (Math.abs(newY - nearestStep) <= 0.7) {
                newY = Math.round(nearestStep * 10) / 10;
                snappedY = true;
                if (guideLineY) {
                  guideLineY.style.top = `${newY}%`;
                  guideLineY.classList.remove("hidden");
                }
                snapLabel = snapLabel || `📐 ${t("org_dashboard.cert_designer.grid_label", "Lưới")} Y: ${newY}%`;
              }
            }
          }
        }
      }

      // Hide guide lines if not snapped
      if (!snappedX) {
        guideLineX?.classList.add("hidden");
        magnetLineX?.classList.add("hidden");
      }
      if (!snappedY) {
        guideLineY?.classList.add("hidden");
        magnetLineY?.classList.add("hidden");
      }

      // Snap badge tooltip positioning
      if (snapBadge) {
        if (snappedX || snappedY) {
          snapBadge.textContent = snapLabel;
          snapBadge.style.left = `${newX}%`;
          snapBadge.style.top = `${Math.max(4, newY - 4)}%`;
          snapBadge.classList.remove("hidden");
        } else {
          snapBadge.classList.add("hidden");
        }
      }

      newX = Math.max(0.5, Math.min(99.5, newX));
      newY = Math.max(0.5, Math.min(99.5, newY));

      if (currentConfig.fields[fieldKey]) {
        currentConfig.fields[fieldKey].x = newX;
        currentConfig.fields[fieldKey].y = newY;
      }

      applyFieldStyleToDOM(fieldKey);

      const xInput = document.getElementById("field-ctrl-x");
      const yInput = document.getElementById("field-ctrl-y");
      if (xInput && activeFieldKey === fieldKey) xInput.value = newX;
      if (yInput && activeFieldKey === fieldKey) yInput.value = newY;
    });

    const handleEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      guideLineX?.classList.add("hidden");
      guideLineY?.classList.add("hidden");
      magnetLineX?.classList.add("hidden");
      magnetLineY?.classList.add("hidden");
      snapBadge?.classList.add("hidden");
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch { }
      el.classList.remove("opacity-90", "scale-105", "shadow-xl");

      const finalX = currentConfig.fields[fieldKey]?.x;
      const finalY = currentConfig.fields[fieldKey]?.y;
      if (finalX !== initialFieldX || finalY !== initialFieldY) {
        pushHistoryState();
      }
    };

    el.addEventListener("pointerup", handleEnd);
    el.addEventListener("pointercancel", handleEnd);
  }

  function setupAllPointerDragging() {
    document.querySelectorAll(".cert-draggable-field").forEach(attachDragToElement);
  }

  // Setup Inspector form inputs
  function setupInspectorEvents() {
    // Enabled switch
    document.getElementById("field-ctrl-enabled")?.addEventListener("change", (e) => {
      if (!currentConfig.fields[activeFieldKey]) return;
      currentConfig.fields[activeFieldKey].enabled = e.target.checked;
      applyFieldStyleToDOM(activeFieldKey);
      pushHistoryState();
    });

    // Font select
    document.getElementById("field-ctrl-font")?.addEventListener("change", (e) => {
      if (!currentConfig.fields[activeFieldKey]) return;
      currentConfig.fields[activeFieldKey].fontFamily = e.target.value;
      applyFieldStyleToDOM(activeFieldKey);
      pushHistoryState();
    });

    // Font / QR Size range
    const sizeInput = document.getElementById("field-ctrl-size");
    const sizeVal = document.getElementById("field-ctrl-size-val");
    sizeInput?.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      if (sizeVal) sizeVal.textContent = `${val}px`;
      if (!currentConfig.fields[activeFieldKey]) return;

      if (activeFieldKey === "qrCode") {
        currentConfig.fields[activeFieldKey].size = val;
      } else {
        currentConfig.fields[activeFieldKey].fontSize = val;
      }
      applyFieldStyleToDOM(activeFieldKey);
    });
    sizeInput?.addEventListener("change", () => {
      pushHistoryState();
    });

    // Color picker & hex text
    const colorInput = document.getElementById("field-ctrl-color");
    const hexInput = document.getElementById("field-ctrl-color-hex");

    colorInput?.addEventListener("input", (e) => {
      const val = e.target.value;
      if (hexInput) hexInput.value = val;
      if (currentConfig.fields[activeFieldKey]) {
        currentConfig.fields[activeFieldKey].color = val;
        applyFieldStyleToDOM(activeFieldKey);
      }
    });
    colorInput?.addEventListener("change", () => {
      pushHistoryState();
    });

    hexInput?.addEventListener("change", (e) => {
      let val = e.target.value.trim();
      if (!val.startsWith("#")) val = `#${val}`;
      if (colorInput && /^#[0-9A-Fa-f]{6}$/.test(val)) colorInput.value = val;
      if (currentConfig.fields[activeFieldKey]) {
        currentConfig.fields[activeFieldKey].color = val;
        applyFieldStyleToDOM(activeFieldKey);
        pushHistoryState();
      }
    });

    // Swatches
    document.querySelectorAll(".color-swatch-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const c = btn.dataset.color;
        if (!c || !currentConfig.fields[activeFieldKey]) return;
        if (colorInput) colorInput.value = c;
        if (hexInput) hexInput.value = c;
        currentConfig.fields[activeFieldKey].color = c;
        applyFieldStyleToDOM(activeFieldKey);
        pushHistoryState();
      });
    });

    // Weight
    document.getElementById("field-ctrl-weight")?.addEventListener("change", (e) => {
      if (!currentConfig.fields[activeFieldKey]) return;
      currentConfig.fields[activeFieldKey].fontWeight = e.target.value;
      applyFieldStyleToDOM(activeFieldKey);
      pushHistoryState();
    });

    // Spacing
    spacingSelect?.addEventListener("change", (e) => {
      if (!currentConfig.fields[activeFieldKey]) return;
      currentConfig.fields[activeFieldKey].letterSpacing = parseInt(e.target.value, 10) || 0;
      applyFieldStyleToDOM(activeFieldKey);
      pushHistoryState();
    });

    // Uppercase toggle
    uppercaseBtn?.addEventListener("click", () => {
      if (!currentConfig.fields[activeFieldKey]) return;
      currentConfig.fields[activeFieldKey].uppercase = !currentConfig.fields[activeFieldKey].uppercase;
      syncInspectorUI();
      applyFieldStyleToDOM(activeFieldKey);
      pushHistoryState();
    });

    // Align buttons
    document.querySelectorAll("#field-ctrl-align-group .align-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const align = btn.dataset.align;
        if (!currentConfig.fields[activeFieldKey]) return;
        currentConfig.fields[activeFieldKey].align = align;
        syncInspectorUI();
        applyFieldStyleToDOM(activeFieldKey);
        pushHistoryState();
      });
    });

    // Custom Text textarea input (supports multiline Enter)
    document.getElementById("field-ctrl-custom-val")?.addEventListener("input", (e) => {
      if (!currentConfig.fields[activeFieldKey]) return;
      currentConfig.fields[activeFieldKey].text = e.target.value;
      applyFieldStyleToDOM(activeFieldKey);

      // Update live text snippet in Layers Panel
      const fallbackTxt = t("org_dashboard.cert_designer.field_customText", "Văn bản tùy chỉnh");
      const activeRowSnippet = document.querySelector(`.layer-item-row[data-layer-key="${activeFieldKey}"] .layer-title`);
      if (activeRowSnippet) {
        const txt = e.target.value.replace(/\n/g, " ").trim();
        activeRowSnippet.textContent = txt ? (txt.length > 20 ? txt.slice(0, 18) + "..." : txt) : fallbackTxt;
      }
      if (fieldActiveName) {
        const txt = e.target.value.replace(/\n/g, " ").trim();
        fieldActiveName.textContent = txt ? (txt.length > 22 ? txt.slice(0, 20) + "..." : txt) : fallbackTxt;
      }
    });
    document.getElementById("field-ctrl-custom-val")?.addEventListener("change", () => {
      pushHistoryState();
    });

    // Dynamic Tokens Inserter
    document.querySelectorAll(".token-insert-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const token = btn.dataset.token;
        const textarea = document.getElementById("field-ctrl-custom-val");
        if (!textarea || !currentConfig.fields[activeFieldKey] || !token) return;

        const start = textarea.selectionStart || 0;
        const end = textarea.selectionEnd || 0;
        const currentVal = textarea.value || "";
        const newVal = currentVal.substring(0, start) + token + currentVal.substring(end);
        textarea.value = newVal;
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + token.length;

        currentConfig.fields[activeFieldKey].text = newVal;
        applyFieldStyleToDOM(activeFieldKey);
        renderLayersPanel();
        pushHistoryState();
      });
    });

    // Quick Presets
    document.querySelectorAll(".preset-tag-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const val = btn.textContent.trim();
        if (!currentConfig.fields[activeFieldKey]) return;
        currentConfig.fields[activeFieldKey].text = val;
        const customValInput = document.getElementById("field-ctrl-custom-val");
        if (customValInput) customValInput.value = val;
        applyFieldStyleToDOM(activeFieldKey);
        renderLayersPanel();
        pushHistoryState();
      });
    });

    // Quick Add Preset Buttons (+ Tiêu đề, + Danh hiệu, + Nội dung, + Chữ ký)
    document.querySelectorAll(".btn-quick-add-preset").forEach(btn => {
      btn.addEventListener("click", () => {
        const presetType = btn.dataset.preset;
        addPresetCustomText(presetType);
      });
    });

    // Add new custom text field button
    addCustomTextBtn?.addEventListener("click", () => {
      addPresetCustomText("default");
    });

    // Duplicate custom field button in inspector
    duplicateFieldBtn?.addEventListener("click", () => {
      duplicateCustomField(activeFieldKey);
    });

    // Delete custom field button in inspector
    deleteFieldBtn?.addEventListener("click", () => {
      deleteCustomField(activeFieldKey);
    });

    // QR Code Inspector Controls
    qrSizeSlider?.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10) || 80;
      if (qrSizeVal) qrSizeVal.textContent = `${val}px`;
      if (currentConfig.fields.qrCode) {
        currentConfig.fields.qrCode.size = val;
        applyFieldStyleToDOM("qrCode");
      }
    });
    qrSizeSlider?.addEventListener("change", () => {
      pushHistoryState();
    });

    qrFrameSelect?.addEventListener("change", (e) => {
      const val = e.target.value;
      if (currentConfig.fields.qrCode) {
        currentConfig.fields.qrCode.qrFrame = val;
        if (qrFrameOptions) {
          qrFrameOptions.classList.toggle("hidden", val === "none");
        }
        applyFieldStyleToDOM("qrCode");
        pushHistoryState();
      }
    });

    qrColorInput?.addEventListener("input", (e) => {
      const val = e.target.value;
      if (qrColorHex) qrColorHex.value = val;
      if (currentConfig.fields.qrCode) {
        currentConfig.fields.qrCode.qrColorDark = val;
        applyFieldStyleToDOM("qrCode");
      }
    });
    qrColorInput?.addEventListener("change", () => {
      pushHistoryState();
    });

    qrColorHex?.addEventListener("change", (e) => {
      let val = e.target.value.trim();
      if (!val.startsWith("#")) val = `#${val}`;
      if (qrColorInput && /^#[0-9A-Fa-f]{6}$/.test(val)) qrColorInput.value = val;
      if (currentConfig.fields.qrCode) {
        currentConfig.fields.qrCode.qrColorDark = val;
        applyFieldStyleToDOM("qrCode");
        pushHistoryState();
      }
    });

    document.querySelectorAll(".qr-color-swatch").forEach(btn => {
      btn.addEventListener("click", () => {
        const color = btn.dataset.color;
        if (!color || !currentConfig.fields.qrCode) return;
        if (qrColorInput) qrColorInput.value = color;
        if (qrColorHex) qrColorHex.value = color;
        currentConfig.fields.qrCode.qrColorDark = color;
        applyFieldStyleToDOM("qrCode");
        pushHistoryState();
      });
    });

    qrBorderColorInput?.addEventListener("input", (e) => {
      const val = e.target.value;
      if (qrBorderHex) qrBorderHex.value = val;
      if (currentConfig.fields.qrCode) {
        currentConfig.fields.qrCode.qrBorderColor = val;
        applyFieldStyleToDOM("qrCode");
      }
    });
    qrBorderColorInput?.addEventListener("change", () => {
      pushHistoryState();
    });

    qrBorderHex?.addEventListener("change", (e) => {
      let val = e.target.value.trim();
      if (!val.startsWith("#")) val = `#${val}`;
      if (qrBorderColorInput && /^#[0-9A-Fa-f]{6}$/.test(val)) qrBorderColorInput.value = val;
      if (currentConfig.fields.qrCode) {
        currentConfig.fields.qrCode.qrBorderColor = val;
        applyFieldStyleToDOM("qrCode");
        pushHistoryState();
      }
    });

    qrTransparentInput?.addEventListener("change", (e) => {
      const checked = e.target.checked;
      if (currentConfig.fields.qrCode) {
        currentConfig.fields.qrCode.qrTransparentBg = checked;
        applyFieldStyleToDOM("qrCode");
        pushHistoryState();
      }
    });

    document.querySelectorAll("#field-ctrl-qr-style-group .qr-style-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const style = btn.dataset.style;
        if (currentConfig.fields.qrCode) {
          currentConfig.fields.qrCode.qrStyle = style;
        }
        document.querySelectorAll("#field-ctrl-qr-style-group .qr-style-btn").forEach(b => {
          const isMatch = b.dataset.style === style;
          b.classList.toggle("active", isMatch);
          b.classList.toggle("border-primary", isMatch);
          b.classList.toggle("bg-primary/10", isMatch);
          b.classList.toggle("text-primary", isMatch);
          b.classList.toggle("text-slate-700", !isMatch);
        });
        applyFieldStyleToDOM("qrCode");
        pushHistoryState();
      });
    });

    // Quick Center X button
    quickCenterBtn?.addEventListener("click", () => {
      const field = currentConfig.fields[activeFieldKey];
      if (!field) return;
      field.x = 50.0;
      field.align = "center";
      applyFieldStyleToDOM(activeFieldKey);
      syncInspectorUI();
      pushHistoryState();
    });

    // Quick Center Y button
    quickCenterYBtn?.addEventListener("click", () => {
      const field = currentConfig.fields[activeFieldKey];
      if (!field) return;
      field.y = 50.0;
      applyFieldStyleToDOM(activeFieldKey);
      syncInspectorUI();
      pushHistoryState();
    });

    // Grid toggle button
    toggleGridBtn?.addEventListener("click", () => {
      isGridVisible = !isGridVisible;
      renderArtboardGrid();
    });

    // Grid size select
    gridSizeSelect?.addEventListener("change", (e) => {
      currentGridType = e.target.value;
      if (!isGridVisible) {
        isGridVisible = true;
      }
      renderArtboardGrid();
    });

    // Magnet toggle button
    toggleMagnetBtn?.addEventListener("click", () => {
      isMagnetActive = !isMagnetActive;
      updateMagnetBtnUI();
    });

    // Coordinates direct typing
    document.getElementById("field-ctrl-x")?.addEventListener("change", (e) => {
      const val = parseFloat(e.target.value);
      if (isNaN(val) || !currentConfig.fields[activeFieldKey]) return;
      currentConfig.fields[activeFieldKey].x = Math.max(0, Math.min(100, val));
      applyFieldStyleToDOM(activeFieldKey);
      pushHistoryState();
    });

    document.getElementById("field-ctrl-y")?.addEventListener("change", (e) => {
      const val = parseFloat(e.target.value);
      if (isNaN(val) || !currentConfig.fields[activeFieldKey]) return;
      currentConfig.fields[activeFieldKey].y = Math.max(0, Math.min(100, val));
      applyFieldStyleToDOM(activeFieldKey);
      pushHistoryState();
    });

    // Keyboard Shortcuts & Arrow Nudge
    window.addEventListener("keydown", (e) => {
      if (overlay.hasAttribute("hidden") || !overlay.classList.contains("active")) return;

      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

      // Handle Undo / Redo shortcuts
      if (cmdOrCtrl) {
        const isZ = e.key === "z" || e.key === "Z";
        const isY = e.key === "y" || e.key === "Y";

        if (isZ || isY) {
          const activeEl = document.activeElement;
          const tag = activeEl?.tagName;
          const isTextInput = (tag === "INPUT" && ["text", "number", "search"].includes(activeEl.type)) || tag === "TEXTAREA";

          // If actively typing inside a text input or textarea, let browser handle native text editing undo/redo
          if (isTextInput) return;

          if (isZ) {
            if (e.shiftKey) {
              // Ctrl + Shift + Z -> Redo
              e.preventDefault();
              redo();
            } else {
              // Ctrl + Z -> Undo
              e.preventDefault();
              undo();
            }
            return;
          }

          if (isY) {
            // Ctrl + Y -> Redo
            e.preventDefault();
            redo();
            return;
          }
        }
      }

      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // Shortcut: G for Toggle Grid
      if (e.key === "g" || e.key === "G") {
        isGridVisible = !isGridVisible;
        renderArtboardGrid();
        return;
      }

      // Shortcut: M for Toggle Magnet
      if (e.key === "m" || e.key === "M") {
        isMagnetActive = !isMagnetActive;
        updateMagnetBtnUI();
        return;
      }

      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        const field = currentConfig.fields[activeFieldKey];
        if (!field) return;

        e.preventDefault();
        const step = e.shiftKey ? 2.0 : 0.5;

        if (e.key === "ArrowLeft") {
          field.x = Math.max(0, Math.min(100, Math.round((field.x - step) * 10) / 10));
        } else if (e.key === "ArrowRight") {
          field.x = Math.max(0, Math.min(100, Math.round((field.x + step) * 10) / 10));
        } else if (e.key === "ArrowUp") {
          field.y = Math.max(0, Math.min(100, Math.round((field.y - step) * 10) / 10));
        } else if (e.key === "ArrowDown") {
          field.y = Math.max(0, Math.min(100, Math.round((field.y + step) * 10) / 10));
        }

        applyFieldStyleToDOM(activeFieldKey);

        const xInput = document.getElementById("field-ctrl-x");
        const yInput = document.getElementById("field-ctrl-y");
        if (xInput) xInput.value = field.x;
        if (yInput) yInput.value = field.y;

        // Debounced history push on arrow key nudge
        clearTimeout(arrowNudgeDebounce);
        arrowNudgeDebounce = setTimeout(() => {
          pushHistoryState();
        }, 350);
      }
    });
  }

  // Open Designer Modal
  openBtn.addEventListener("click", () => {
    const certSelect = document.getElementById("cert-event-select");
    if (!selectedCertEventId && certSelect && certSelect.value) {
      selectedCertEventId = certSelect.value;
    }
    if (!selectedCertEventId) {
      showAlertDialog({
        titleKey: "common.confirm_title",
        messageKey: "org_dashboard.cert_designer.select_event_first",
        type: "warning"
      });
      return;
    }

    const event = currentEvents.find(ev => ev._id === selectedCertEventId || String(ev._id) === String(selectedCertEventId));
    if (!event) {
      showAlertDialog({
        titleKey: "common.error",
        messageKey: "org_dashboard.event_not_found",
        type: "error"
      });
      return;
    }

    // Load background image
    const bgUrl = event.certificateBackground;
    if (bgUrl && bgUrl.trim() !== "") {
      bgImg.src = bgUrl;
      bgImg.classList.remove("hidden");
      noBgNotice.classList.add("hidden");
      bgImg.onload = () => {
        if (bgImg.naturalWidth && bgImg.naturalHeight) {
          const aspect = bgImg.naturalWidth / bgImg.naturalHeight;
          const targetH = Math.round(1200 / aspect);
          artboard.style.height = `${targetH}px`;
          updateArtboardScale();
        }
      };
      if (bgImg.complete && bgImg.naturalWidth && bgImg.naturalHeight) {
        const aspect = bgImg.naturalWidth / bgImg.naturalHeight;
        const targetH = Math.round(1200 / aspect);
        artboard.style.height = `${targetH}px`;
      }
    } else {
      bgImg.src = "";
      bgImg.classList.add("hidden");
      noBgNotice.classList.remove("hidden");
      artboard.style.height = "850px";
    }

    // Load existing certificateConfig or fallback to DEFAULT_CERT_CONFIG
    if (event.certificateConfig && event.certificateConfig.fields) {
      currentConfig = {
        isCustom: true,
        fields: JSON.parse(JSON.stringify(event.certificateConfig.fields)),
      };
      // Ensure essential default fields exist if missing, and merge missing properties (e.g. newly added QR style/color properties)
      Object.keys(DEFAULT_CERT_CONFIG.fields).forEach(k => {
        if (!currentConfig.fields[k]) {
          currentConfig.fields[k] = JSON.parse(JSON.stringify(DEFAULT_CERT_CONFIG.fields[k]));
        } else {
          currentConfig.fields[k] = {
            ...JSON.parse(JSON.stringify(DEFAULT_CERT_CONFIG.fields[k])),
            ...currentConfig.fields[k],
          };
        }
      });
    } else {
      currentConfig = JSON.parse(JSON.stringify(DEFAULT_CERT_CONFIG));
    }

    applyTranslation(overlay);
    if (sampleBtnText) {
      sampleBtnText.textContent = isSampleMode
        ? t("org_dashboard.cert_designer.sample_student", "Sample Student")
        : t("org_dashboard.cert_designer.variable_tokens", "Variable Tokens");
    }

    activeFieldKey = "userName";
    renderArtboardCustomFields();
    renderLayersPanel();
    applyAllFieldsToDOM();
    syncInspectorUI();
    renderArtboardGrid();
    updateMagnetBtnUI();

    // Initialize history stack on modal open
    history = [createSnapshot()];
    historyIndex = 0;
    updateUndoRedoUI();

    overlay.removeAttribute("hidden");
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";

    setTimeout(updateArtboardScale, 60);
  });

  // Close Modal
  function closeModal() {
    overlay.classList.remove("active");
    setTimeout(() => overlay.setAttribute("hidden", ""), 300);
    document.body.style.overflow = "";
  }

  closeBtn?.addEventListener("click", closeModal);
  backdrop?.addEventListener("click", closeModal);

  // Undo & Redo (Forward) Button handlers
  undoBtn?.addEventListener("click", undo);
  redoBtn?.addEventListener("click", redo);

  // Toggle Sample Data / Tokens
  sampleBtn?.addEventListener("click", () => {
    isSampleMode = !isSampleMode;
    if (sampleBtnText) {
      sampleBtnText.textContent = isSampleMode
        ? t("org_dashboard.cert_designer.sample_student", "Sample Student")
        : t("org_dashboard.cert_designer.variable_tokens", "Variable Tokens");
    }
    applyAllFieldsToDOM();
  });

  // Reset to default layout
  resetBtn?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog({
      titleKey: "common.confirm_title",
      messageKey: "org_dashboard.reset_fields_position_confirm",
      confirmTextKey: "common.confirm_btn",
      type: "warning"
    });
    if (!confirmed) return;
    currentConfig = JSON.parse(JSON.stringify(DEFAULT_CERT_CONFIG));
    renderArtboardCustomFields();
    renderLayersPanel();
    activeFieldKey = "userName";
    applyAllFieldsToDOM();
    syncInspectorUI();
    pushHistoryState();
  });

  // Save Layout
  saveBtn?.addEventListener("click", async () => {
    if (!selectedCertEventId) return;

    const origHTML = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>${t("org_dashboard.cert_designer.saving", "Đang lưu...")}</span>`;

    try {
      const formData = new FormData();
      formData.append("certificateConfig", JSON.stringify(currentConfig));

      const res = await updateActivity(selectedCertEventId, formData);
      const updatedEv = res.event || res.activity || {};

      const idx = currentEvents.findIndex(ev => ev._id === selectedCertEventId);
      if (idx !== -1) {
        currentEvents[idx].certificateConfig = currentConfig;
      }

      await showAlertDialog({
        titleKey: "org_dashboard.cert_designer.save_success_title",
        messageKey: "org_dashboard.cert_designer.save_success_msg",
        type: "success"
      });
      closeModal();
    } catch (err) {
      console.error("Save certificateConfig error:", err);
      await showAlertDialog({
        titleKey: "org_dashboard.cert_designer.save_failed_title",
        message: `${t("org_dashboard.cert_designer.save_failed_msg", "Lưu bố cục thất bại")}: ${err.message || "Unknown error"}`,
        type: "error"
      });
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = origHTML;
    }
  });

  // Re-translate dynamic designer components if language switches while active
  window.addEventListener("language-changed", () => {
    if (overlay && !overlay.hasAttribute("hidden") && overlay.classList.contains("active")) {
      applyTranslation(overlay);
      if (sampleBtnText) {
        sampleBtnText.textContent = isSampleMode
          ? t("org_dashboard.cert_designer.sample_student", "Sample Student")
          : t("org_dashboard.cert_designer.variable_tokens", "Variable Tokens");
      }
      renderArtboardCustomFields();
      renderLayersPanel();
      applyAllFieldsToDOM();
      syncInspectorUI();
      renderArtboardGrid();
      updateMagnetBtnUI();
    }
  });

  setupAllPointerDragging();
  setupInspectorEvents();
}

function initCertEventSelect() {
  const wrapper = document.getElementById("cert-event-select-wrapper");
  if (!wrapper || wrapper.dataset.certInitialized === "true") return;
  wrapper.dataset.certInitialized = "true";
  wrapper.addEventListener("change", (e) => {
    if (e.target.id === "cert-event-select") {
      selectedCertEventId = e.target.value || null;
      const searchInput = document.getElementById("certs-search-input");
      const clearBtn = document.getElementById("certs-search-clear");
      if (searchInput) searchInput.value = "";
      if (clearBtn) clearBtn.classList.add("hidden");
      certState.searchQuery = "";
      certState.eventId = selectedCertEventId;
      if (e.target.value) {
        loadCertificates(e.target.value);
      } else {
        document.getElementById("certs-table-body").innerHTML = "";
        renderCertBgPanel(null);
        setCertSearchEnabled(false);
        const countEl = document.getElementById("certs-count");
        if (countEl) countEl.textContent = "0 records";
        const empty = document.getElementById("certs-empty");
        if (empty) {
          empty.classList.remove("hidden");
          empty.innerHTML = `
            <i class="fa-solid fa-award text-4xl mb-3 block"></i>
            <p class="text-base font-semibold" data-i18n="org_dashboard.select_event_view_certs">Select an event</p>
            <p class="text-xs text-slate-500 mt-1 max-w-xs mx-auto" data-i18n="org_dashboard.select_event_view_certs_desc">Pick an event from the selector to view issued certificates</p>
          `;
          applyTranslation(empty);
        }
      }
    }
  });
}

function showCertsNotSupported() {
  const tbody = document.getElementById("certs-table-body");
  const empty = document.getElementById("certs-empty");
  renderCertBgPanel(null);
  setCertSearchEnabled(false);
  const countEl = document.getElementById("certs-count");
  if (countEl) countEl.textContent = "0 records";
  if (tbody) tbody.innerHTML = "";
  if (empty) {
    empty.classList.remove("hidden");
    empty.innerHTML = `
      <i class="fa-solid fa-triangle-exclamation text-4xl mb-3 block text-[#f59e0b]"></i>
      <p class="text-base font-semibold text-[#64748b]" data-i18n="org_dashboard.certs_not_supported">Certificates not supported for this event</p>
      <p class="text-sm text-[#94a3b8] mt-1" data-i18n="org_dashboard.certs_not_supported_desc">Enable the certificate option when creating or editing the event.</p>
    `;
    applyTranslation(empty);
  }
}

async function loadCertificates(eventId) {
  try {
    selectedCertEventId = eventId;
    const event = currentEvents.find(ev => ev._id === eventId);
    if (!event || !(event.hasCertificate === true || event.hasCertificate === 'true')) {
      showCertsNotSupported();
      return;
    }

    setCertSearchEnabled(true);
    renderCertBgPanel(event);

    const [{ certificates = [] }, attendanceRes] = await Promise.all([
      getEventCertificates(eventId).catch(() => ({ certificates: [] })),
      getAttendance(eventId).catch(() => ({ attendance: [] }))
    ]);

    const attendances = attendanceRes?.attendance || [];
    const presentAttendees = attendances.filter(a => a.status === 'present' && !a.isExternal && a.user && a.user._id);

    const certByUser = new Map();
    certificates.forEach(c => {
      const uId = c.user?._id ? c.user._id.toString() : (c.user?.toString() || '');
      if (uId) certByUser.set(uId, c);
    });

    const unissuedPresent = presentAttendees.filter(a => {
      const uId = a.user._id.toString();
      return !certByUser.has(uId);
    });

    certState.eventId = eventId;
    certState.unissuedPresent = unissuedPresent;
    certState.certificates = certificates;

    // By default, select all unissued present attendees
    certState.selectedUserIds = new Set(unissuedPresent.map(a => a.user._id.toString()));

    const searchInput = document.getElementById("certs-search-input");
    certState.searchQuery = searchInput ? searchInput.value.trim() : "";

    renderCertificatesTable();

  } catch (err) {
    console.error("Load certificates error:", err);
  }
}

function renderCertificatesTable() {
  const tbody = document.getElementById("certs-table-body");
  const empty = document.getElementById("certs-empty");
  const selectAllCheckbox = document.getElementById("cert-select-all");
  const countEl = document.getElementById("certs-count");
  if (!tbody) return;

  const eventId = certState.eventId;
  const totalCount = certState.unissuedPresent.length + certState.certificates.length;
  const isVi = getLang() === "vi";
  const recordsWord = isVi ? "người tham gia" : "records";

  if (totalCount === 0) {
    if (countEl) countEl.textContent = `0 ${recordsWord}`;
    tbody.innerHTML = "";
    if (empty) {
      empty.classList.remove("hidden");
      empty.innerHTML = `
        <i class="fa-solid fa-award text-4xl mb-3 block"></i>
        <p class="text-base font-semibold" data-i18n="org_dashboard.no_certs_yet">No eligible attendees or certificates found</p>
        <p class="text-sm text-[#94a3b8] mt-1" data-i18n="org_dashboard.mark_attendance_first_desc">Make sure attendees are marked as present in Attendance.</p>
      `;
      applyTranslation(empty);
    }
    if (selectAllCheckbox) {
      selectAllCheckbox.disabled = true;
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    }
    return;
  }

  // Filter based on search query
  const q = certState.searchQuery ? certState.searchQuery.trim() : "";
  const filteredUnissued = certState.unissuedPresent.filter(a => {
    const u = a.user || {};
    const userName = u.fullname || u.username || "Attendee";
    const userEmail = u.email || "";
    const studentId = u.studentId || u.username || "";
    return matchesCertSearch(q, { userName, userEmail, studentId, certCode: "" });
  });

  const filteredCerts = certState.certificates.filter(c => {
    const user = c.user || {};
    const userName = user.fullname || c.metadata?.userName || "Unknown";
    const userEmail = user.email || "";
    const studentId = user.studentId || user.username || "";
    const certCode = c.certificateCode || "";
    return matchesCertSearch(q, { userName, userEmail, studentId, certCode });
  });

  const filteredTotal = filteredUnissued.length + filteredCerts.length;

  // Update count badge
  if (countEl) {
    if (q) {
      countEl.textContent = `${filteredTotal} / ${totalCount} ${recordsWord}`;
    } else {
      countEl.textContent = `${totalCount} ${recordsWord}`;
    }
  }

  // If search returned 0 items
  if (filteredTotal === 0) {
    if (empty) empty.classList.add("hidden");
    if (selectAllCheckbox) {
      selectAllCheckbox.disabled = true;
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    }
    const safeQ = escapeHtml(q);
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-14 px-4 text-slate-400">
          <div class="w-12 h-12 rounded-2xl bg-slate-50 text-slate-400 flex items-center justify-center mx-auto mb-3 text-lg border border-slate-100">
            <i class="fa-solid fa-magnifying-glass"></i>
          </div>
          <p class="text-sm font-bold text-slate-700" data-i18n="org_dashboard.no_participants_found">No participants found</p>
          <p class="text-xs text-slate-400 mt-1 max-w-xs mx-auto" data-i18n="org_dashboard.no_participants_found_desc">No participant matches "${safeQ}".</p>
        </td>
      </tr>
    `;
    applyTranslation(tbody);
    return;
  }

  if (empty) empty.classList.add("hidden");

  // Update select all checkbox state
  if (selectAllCheckbox) {
    if (filteredUnissued.length === 0) {
      selectAllCheckbox.disabled = true;
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else {
      selectAllCheckbox.disabled = false;
      const allChecked = filteredUnissued.every(a => certState.selectedUserIds.has(a.user._id.toString()));
      const someChecked = filteredUnissued.some(a => certState.selectedUserIds.has(a.user._id.toString()));
      selectAllCheckbox.checked = allChecked;
      selectAllCheckbox.indeterminate = !allChecked && someChecked;
    }
  }

  const isOwner = isOrgOwner();

  // 1. Render unissued attendees (ready to be issued)
  const unissuedHtml = filteredUnissued.map(a => {
    const u = a.user || {};
    const uId = u._id ? u._id.toString() : "";
    const userName = u.fullname || u.username || "Attendee";
    const userEmail = u.email || "";
    const isChecked = certState.selectedUserIds.has(uId);

    return `
      <tr class="border-b border-[#ecedfa] hover:bg-blue-50/30 transition-colors bg-blue-50/10" data-attendee-user-id="${uId}">
        <td class="py-3.5 px-3 sm:px-4 text-center">
          <input type="checkbox" class="cert-select-item w-4 h-4 rounded border-slate-300 text-primary focus:ring-primary cursor-pointer accent-primary align-middle" data-user-id="${uId}" ${isChecked ? 'checked' : ''} />
        </td>
        <td class="py-3.5 px-4">
          <div class="font-semibold text-slate-900">${escapeHtml(userName)}</div>
          <div class="text-[11px] text-slate-400 font-mono">${escapeHtml(userEmail)}</div>
        </td>
        <td class="py-3.5 px-4 text-[#94a3b8] font-mono text-[13px] hidden md:table-cell">—</td>
        <td class="py-3.5 px-4 text-[#94a3b8] text-xs">—</td>
        <td class="py-3.5 px-4">
          <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
            <i class="fa-solid fa-user-check text-[10px]"></i> <span data-i18n="org_dashboard.attended_ready">Attended</span>
          </span>
        </td>
        <td class="py-3.5 px-4 text-right">
          <button class="issue-single-cert-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white bg-primary hover:bg-primary-hover shadow-2xs border-none cursor-pointer spring-ease active:scale-95" data-user-id="${uId}" data-user-name="${escapeHtml(userName)}">
            <i class="fa-solid fa-award text-[11px]"></i> <span data-i18n="org_dashboard.issue_single">Issue</span>
          </button>
        </td>
      </tr>
    `;
  }).join("");

  // 2. Render already issued certificates
  const issuedHtml = filteredCerts.map(c => {
    const user = c.user || {};
    const userName = user.fullname || c.metadata?.userName || "Unknown";
    const userEmail = user.email || "";
    const isRevoked = c.status === 'revoked';
    const statusBadge = isRevoked
      ? `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200" title="Reason: ${escapeHtml(c.revocationReason || 'Revoked')}"><i class="fa-solid fa-ban text-[10px]"></i> Revoked</span>`
      : `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"><i class="fa-solid fa-circle-check text-[10px]"></i> Active</span>`;

    const actionButtons = isRevoked
      ? (isOwner
        ? `<button class="restore-cert-btn inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 cursor-pointer spring-ease active:scale-95" data-cert-id="${c._id}" data-user-name="${escapeHtml(userName)}">
               <i class="fa-solid fa-rotate-left"></i> Restore
             </button>`
        : `<span class="text-xs text-slate-400 italic">—</span>`)
      : `<div class="flex items-center justify-end gap-2">
           <a href="/certificate.html?code=${encodeURIComponent(c.certificateCode)}" target="_blank" class="p-1.5 rounded-lg text-slate-500 hover:text-primary hover:bg-slate-50 transition-colors text-xs font-semibold" title="View Certificate">
             <i class="fa-solid fa-arrow-up-right-from-square"></i>
           </a>
           ${isOwner ? `
           <button class="revoke-cert-btn inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 cursor-pointer spring-ease active:scale-95" data-cert-id="${c._id}" data-user-name="${escapeHtml(userName)}" data-cert-code="${escapeHtml(c.certificateCode)}">
             <i class="fa-solid fa-ban text-[11px]"></i> Revoke
           </button>` : ''}
         </div>`;

    return `
      <tr class="border-b border-[#ecedfa] hover:bg-slate-50/50 transition-colors">
        <td class="py-3.5 px-3 sm:px-4 text-center">
          <input type="checkbox" class="w-4 h-4 rounded border-slate-200 text-slate-300 cursor-not-allowed accent-slate-300 align-middle" disabled title="Certificate already issued" />
        </td>
        <td class="py-3.5 px-4">
          <div class="font-semibold text-slate-900">${escapeHtml(userName)}</div>
          <div class="text-[11px] text-slate-400 font-mono">${escapeHtml(userEmail)}</div>
        </td>
        <td class="py-3.5 px-4 text-[#64748b] font-mono text-[13px] hidden md:table-cell">${escapeHtml(c.certificateCode || "—")}</td>
        <td class="py-3.5 px-4 text-[#64748b] text-xs">${formatDate(c.createdAt)}</td>
        <td class="py-3.5 px-4">${statusBadge}</td>
        <td class="py-3.5 px-4 text-right">${actionButtons}</td>
      </tr>
    `;
  }).join("");

  tbody.innerHTML = unissuedHtml + issuedHtml;
  applyTranslation(tbody);

  // Master checkbox change handler
  if (selectAllCheckbox) {
    selectAllCheckbox.onchange = (e) => {
      const checked = e.target.checked;
      filteredUnissued.forEach(a => {
        const uId = a.user._id.toString();
        if (checked) {
          certState.selectedUserIds.add(uId);
        } else {
          certState.selectedUserIds.delete(uId);
        }
      });
      tbody.querySelectorAll(".cert-select-item").forEach(cb => {
        cb.checked = checked;
      });
    };
  }

  // Individual checkbox change handlers
  tbody.querySelectorAll(".cert-select-item").forEach(cb => {
    cb.addEventListener("change", (e) => {
      const uId = e.target.dataset.userId;
      if (e.target.checked) {
        certState.selectedUserIds.add(uId);
      } else {
        certState.selectedUserIds.delete(uId);
      }
      if (selectAllCheckbox) {
        const allChecked = filteredUnissued.length > 0 && filteredUnissued.every(a => certState.selectedUserIds.has(a.user._id.toString()));
        const someChecked = filteredUnissued.some(a => certState.selectedUserIds.has(a.user._id.toString()));
        selectAllCheckbox.checked = allChecked;
        selectAllCheckbox.indeterminate = !allChecked && someChecked;
      }
    });
  });

  // Attach Single Issue action
  tbody.querySelectorAll(".issue-single-cert-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.userId;
      const userName = btn.dataset.userName || "Attendee";
      if (!userId || !eventId) return;

      const confirmed = await showConfirmDialog({
        titleKey: "common.confirm_title",
        messageKey: "org_dashboard.issue_cert_single_confirm",
        params: { name: userName },
        confirmTextKey: "common.confirm_btn",
        type: "primary"
      });
      if (!confirmed) return;

      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-[11px]"></i> Issuing...`;
      try {
        await issueCertificates(eventId, [userId]);
        await showAlertDialog({
          titleKey: "org_dashboard.cert_designer.save_success_title",
          messageKey: "org_dashboard.cert_designer.certs_issued_success",
          type: "success"
        });
        await loadCertificates(eventId);
      } catch (err) {
        showAlertDialog({
          titleKey: "common.error",
          message: err.message || t("org_dashboard.cert_designer.certs_issued_failed", "Failed to issue certificate"),
          type: "error"
        });
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-award text-[11px]"></i> <span data-i18n="org_dashboard.issue_single">Issue</span>`;
      }
    });
  });

  // Attach Revoke modal openers
  tbody.querySelectorAll(".revoke-cert-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!isOrgOwner()) return alert("Only the organization owner can revoke certificates");
      const certId = btn.dataset.certId;
      const userName = btn.dataset.userName;
      const certCode = btn.dataset.certCode;
      openRevokeModal(certId, userName, certCode, eventId);
    });
  });

  // Attach Restore actions
  tbody.querySelectorAll(".restore-cert-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!isOrgOwner()) return alert("Only the organization owner can restore certificates");
      const certId = btn.dataset.certId;
      const userName = btn.dataset.userName;
      const confirmed = await showConfirmDialog({
        titleKey: "common.confirm_title",
        messageKey: "org_dashboard.restore_cert_confirm",
        params: { name: userName },
        confirmTextKey: "common.confirm_btn",
        type: "primary"
      });
      if (!confirmed) return;
      try {
        await restoreCertificate(certId);
        await loadCertificates(eventId);
      } catch (err) {
        alert(err.message || "Failed to restore certificate");
      }
    });
  });
}

function openRevokeModal(certId, userName, certCode, eventId) {
  const overlay = document.getElementById("revoke-cert-overlay");
  const idInput = document.getElementById("revoke-cert-id");
  const desc = document.getElementById("revoke-cert-recipient-desc");
  const reasonInput = document.getElementById("revoke-cert-reason");

  if (!overlay || !idInput) return;
  idInput.value = certId;
  idInput.dataset.eventId = eventId;
  if (desc) desc.textContent = `Revoke certificate for ${userName} (${certCode})? This action will invalidate the certificate.`;
  if (reasonInput) reasonInput.value = "";

  overlay.removeAttribute("hidden");
  overlay.classList.add("active");
}

function closeRevokeModal() {
  const overlay = document.getElementById("revoke-cert-overlay");
  if (overlay) {
    overlay.classList.remove("active");
    setTimeout(() => overlay.setAttribute("hidden", ""), 300);
  }
}

function initIssueCerts() {
  document.getElementById("issue-certs-btn")?.addEventListener("click", async () => {
    const eventId = document.getElementById("cert-event-select")?.value;
    if (!eventId) {
      showAlertDialog({
        titleKey: "common.confirm_title",
        messageKey: "org_dashboard.cert_designer.select_event_first",
        type: "warning"
      });
      return;
    }
    const event = currentEvents.find(ev => ev._id === eventId);
    if (!event || !(event.hasCertificate === true || event.hasCertificate === 'true')) {
      showAlertDialog({
        titleKey: "common.error",
        messageKey: "org_dashboard.event_no_cert_support",
        type: "error"
      });
      return;
    }

    // Collect all checked eligible attendees
    const checkedItems = Array.from(document.querySelectorAll("#certs-table-body .cert-select-item:checked"));
    const selectedUserIds = checkedItems.map(cb => cb.dataset.userId).filter(Boolean);

    if (selectedUserIds.length === 0) {
      showAlertDialog({
        titleKey: "common.notice",
        messageKey: "org_dashboard.no_attendees_selected",
        type: "warning"
      });
      return;
    }

    const confirmed = await showConfirmDialog({
      titleKey: "common.confirm_title",
      messageKey: "org_dashboard.issue_certs_selected_confirm",
      params: { count: selectedUserIds.length },
      confirmTextKey: "common.confirm_btn",
      type: "primary"
    });
    if (!confirmed) return;

    const issueBtn = document.getElementById("issue-certs-btn");
    const originalText = issueBtn ? issueBtn.innerHTML : "";
    if (issueBtn) {
      issueBtn.disabled = true;
      issueBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Processing...</span>`;
    }

    try {
      await issueCertificates(eventId, selectedUserIds);
      await showAlertDialog({
        titleKey: "org_dashboard.cert_designer.save_success_title",
        messageKey: "org_dashboard.cert_designer.certs_issued_success",
        type: "success"
      });
      await loadCertificates(eventId);
    } catch (err) {
      showAlertDialog({
        titleKey: "common.error",
        message: err.message || t("org_dashboard.cert_designer.certs_issued_failed", "Failed to issue certificates"),
        type: "error"
      });
    } finally {
      if (issueBtn) {
        issueBtn.disabled = false;
        issueBtn.innerHTML = originalText;
      }
    }
  });

  // Revoke modal controls
  document.getElementById("revoke-cert-close-btn")?.addEventListener("click", closeRevokeModal);
  document.getElementById("revoke-cert-cancel-btn")?.addEventListener("click", closeRevokeModal);
  document.getElementById("revoke-cert-backdrop")?.addEventListener("click", closeRevokeModal);

  document.getElementById("revoke-cert-confirm-btn")?.addEventListener("click", async () => {
    if (!isOrgOwner()) return alert("Only the organization owner can revoke certificates");
    const idInput = document.getElementById("revoke-cert-id");
    const reasonInput = document.getElementById("revoke-cert-reason");
    const certId = idInput?.value;
    const eventId = idInput?.dataset?.eventId;
    const reason = reasonInput?.value?.trim() || "";

    if (!reason) {
      alert(t("org_dashboard.cert_designer.reason_required", "Vui lòng nhập lý do thu hồi chứng nhận"));
      reasonInput?.focus();
      reasonInput?.classList.add("!border-red-500");
      return;
    }
    reasonInput?.classList.remove("!border-red-500");

    if (!certId) return;
    const btn = document.getElementById("revoke-cert-confirm-btn");
    btn.disabled = true;
    btn.textContent = "Revoking...";
    try {
      await revokeCertificate(certId, reason);
      closeRevokeModal();
      if (eventId) await loadCertificates(eventId);
    } catch (err) {
      alert(err.message || "Failed to revoke certificate");
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-ban text-[11px]"></i> Confirm Revoke`;
    }
  });
}

// ─── Managers ───

async function loadManagers() {
  if (!currentOrgId) return;
  try {
    const { managers = [] } = await getManagers(currentOrgId);
    const tbody = document.getElementById("managers-table-body");
    const empty = document.getElementById("managers-empty");
    const addManagerBtn = document.getElementById("add-manager-btn");

    if (addManagerBtn) {
      addManagerBtn.classList.toggle("hidden", !isOrgOwner());
    }

    if (!managers.length) {
      tbody.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    const isOwner = isOrgOwner();

    tbody.innerHTML = managers.map(m => {
      const actions = isOwner
        ? `
            <button class="transfer-owner-btn text-sm text-[#1755ba] font-semibold hover:underline bg-transparent border-none cursor-pointer mr-4" data-user-id="${m._id}" data-fullname="${m.fullname || m.username || 'this user'}" data-email="${m.email}">Transfer Ownership</button>
            <button class="remove-manager-btn text-sm text-red-500 font-semibold hover:underline bg-transparent border-none cursor-pointer" data-user-id="${m._id}">Remove</button>
          `
        : `<span class="text-xs text-slate-400 italic" data-i18n="org_dashboard.no_permission">No permission</span>`;
      return `
        <tr class="border-b border-[#ecedfa]">
          <td class="py-3.5 px-4"><span class="font-semibold">${m.fullname || "Unknown"}</span></td>
          <td class="py-3.5 px-4 text-[#64748b] hidden md:table-cell">${m.email || "—"}</td>
          <td class="py-3.5 px-4"><span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background:#dae1ff;color:#1755ba">Manager</span></td>
          <td class="py-3.5 px-4 text-right">
            ${actions}
          </td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll(".remove-manager-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!isOrgOwner()) return alert("Only the organization owner can remove managers");
        const confirmed = await showConfirmDialog({
          titleKey: "common.delete_confirm_title",
          messageKey: "org_dashboard.remove_manager_confirm",
          confirmTextKey: "common.delete_btn",
          type: "danger"
        });
        if (!confirmed) return;
        try {
          await removeManager(currentOrgId, btn.dataset.userId);
          await loadManagers();
        } catch (err) {
          alert(err.message || "Failed to remove manager");
        }
      });
    });

    tbody.querySelectorAll(".transfer-owner-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!isOrgOwner()) return alert("Only the organization owner can transfer ownership");
        const fullname = btn.dataset.fullname;
        const email = btn.dataset.email;
        if (!email) return alert(t("org_dashboard.manager_no_email", "This manager does not have an email address set."));
        const confirmed = await showConfirmDialog({
          titleKey: "common.confirm_title",
          messageKey: "org_dashboard.transfer_ownership_confirm",
          params: { name: fullname, email: email },
          confirmTextKey: "common.confirm_btn",
          type: "warning"
        });
        if (!confirmed) return;
        try {
          await transferOwnership(currentOrgId, email);
          alert("Ownership transferred successfully!");
          window.location.reload();
        } catch (err) {
          alert(err.message || "Failed to transfer ownership");
        }
      });
    });
  } catch (err) {
    console.error("Load managers error:", err);
  }
}

function initAddManager() {
  const overlay = document.getElementById("manager-overlay");

  document.getElementById("add-manager-btn").addEventListener("click", () => {
    if (!currentOrgId) return alert("Select an organization first");
    if (!isOrgOwner()) return alert("Only the organization owner can add managers");
    document.getElementById("manager-email-input").value = "";
    overlay.removeAttribute("hidden");
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";
  });

  function close() {
    overlay.classList.remove("active");
    document.body.style.overflow = "";
    setTimeout(() => overlay.setAttribute("hidden", ""), 300);
  }

  document.getElementById("manager-backdrop").addEventListener("click", close);
  document.getElementById("manager-cancel").addEventListener("click", close);

  document.getElementById("manager-confirm").addEventListener("click", async () => {
    if (!isOrgOwner()) return alert("Only the organization owner can add managers");
    const email = document.getElementById("manager-email-input").value.trim();
    if (!email) return alert("Enter an email address");
    try {
      await addManager(currentOrgId, email);
      close();
      await loadManagers();
      alert("Manager added!");
    } catch (err) {
      alert(err.message || "Failed to add manager");
    }
  });
}

// ─── Settings ───

function loadSettings(org) {
  if (!org) return;
  document.getElementById("settings-name").value = org.name || "";
  document.getElementById("settings-desc").value = org.description || "";
  document.getElementById("settings-phone").value = org.contactInfo?.phoneNo || "";
  document.getElementById("settings-email").value = org.contactInfo?.email || "";
  document.getElementById("settings-website").value = org.website || "";
  document.getElementById("settings-facebook").value = org.socialLinks?.facebook || "";
  document.getElementById("settings-linkedin").value = org.socialLinks?.linkedin || "";
  document.getElementById("settings-instagram").value = org.socialLinks?.instagram || "";
  document.getElementById("settings-twitter").value = org.socialLinks?.twitter || "";

  const universityVal = org.university?._id || org.university || "";
  populateOrgUniversitySelect("settings-university", universityVal).catch(e =>
    console.error("Failed to populate settings university:", e)
  );

  const avatarPreview = document.getElementById("settings-avatar-preview");
  if (avatarPreview) {
    avatarPreview.src = org.avatar || "/assets/images/default-org-avatar.png";
  }

  // Permission checks: Only owner or platform admin can edit settings or delete org
  const isOwner = isOrgOwner();
  const notice = document.getElementById("settings-manager-notice");
  if (notice) {
    notice.classList.toggle("hidden", isOwner);
  }

  const inputs = [
    "settings-name",
    "settings-university",
    "settings-desc",
    "settings-phone",
    "settings-email",
    "settings-website",
    "settings-facebook",
    "settings-linkedin",
    "settings-instagram",
    "settings-twitter"
  ];
  inputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = !isOwner;
      if (!isOwner) {
        el.classList.add("opacity-60", "cursor-not-allowed", "bg-slate-50");
      } else {
        el.classList.remove("opacity-60", "cursor-not-allowed", "bg-slate-50");
      }
    }
  });

  const submitBtn = document.querySelector("#org-settings-form button[type='submit']");
  if (submitBtn) {
    submitBtn.classList.toggle("hidden", !isOwner);
  }

  const deleteOrgBtn = document.getElementById("delete-org-btn");
  if (deleteOrgBtn) {
    deleteOrgBtn.classList.toggle("hidden", !isOwner);
  }

  const changeAvatarBtn = document.getElementById("change-org-avatar-btn");
  if (changeAvatarBtn) {
    changeAvatarBtn.classList.toggle("hidden", !isOwner);
  }

  const avatarInputLabel = document.querySelector("label[for='settings-avatar-input']");
  if (avatarInputLabel) {
    avatarInputLabel.classList.toggle("hidden", !isOwner);
  }
}

function initSettingsForm() {
  const avatarInput = document.getElementById("settings-avatar-input");
  const changeAvatarBtn = document.getElementById("change-org-avatar-btn");
  const avatarStatus = document.getElementById("org-avatar-status");
  const avatarPreview = document.getElementById("settings-avatar-preview");

  if (changeAvatarBtn && avatarInput) {
    changeAvatarBtn.addEventListener("click", () => {
      if (!isOrgOwner()) return alert("Only the organization owner can change the organization logo");
      avatarInput.click();
    });
  }

  if (avatarInput) {
    avatarInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file || !currentOrgId) return;
      if (!isOrgOwner()) return alert("Only the organization owner can change the organization logo");

      if (file.size > 5 * 1024 * 1024) {
        alert("Image must be smaller than 5MB");
        return;
      }

      if (avatarStatus) {
        avatarStatus.textContent = "Uploading...";
        avatarStatus.className = "text-xs text-blue-600 font-medium";
        avatarStatus.classList.remove("hidden");
      }

      try {
        const res = await uploadOrgAvatar(currentOrgId, file);
        if (res.avatar && avatarPreview) {
          avatarPreview.src = res.avatar;
        }
        if (avatarStatus) {
          avatarStatus.textContent = t("org_dashboard.avatar_updated_success");
          avatarStatus.className = "text-xs text-green-600 font-medium";
          setTimeout(() => avatarStatus.classList.add("hidden"), 3000);
        }
        await loadOrgs();
      } catch (err) {
        if (avatarStatus) {
          avatarStatus.textContent = err.message || t("org_dashboard.upload_failed");
          avatarStatus.className = "text-xs text-red-600 font-medium";
        }
      }
    });
  }

  document.getElementById("org-settings-form").addEventListener("submit", async e => {
    e.preventDefault();
    if (!currentOrgId) return;
    if (!isOrgOwner()) return alert("Only the organization owner can update organization settings");
    const uniInput = document.getElementById("settings-university");
    const data = {
      name: document.getElementById("settings-name").value.trim(),
      university: uniInput ? (uniInput.value || null) : null,
      description: document.getElementById("settings-desc").value.trim(),
      contactInfo: {
        phoneNo: document.getElementById("settings-phone").value.trim(),
        email: document.getElementById("settings-email").value.trim(),
      },
      website: document.getElementById("settings-website").value.trim(),
      socialLinks: {
        facebook: document.getElementById("settings-facebook").value.trim(),
        linkedin: document.getElementById("settings-linkedin").value.trim(),
        instagram: document.getElementById("settings-instagram").value.trim(),
        twitter: document.getElementById("settings-twitter").value.trim(),
      }
    };
    try {
      await updateOrganization(currentOrgId, data);
      alert("Settings saved!");
      await loadOrgs();
    } catch (err) {
      alert(err.message || "Failed to save settings");
    }
  });

  document.getElementById("delete-org-btn").addEventListener("click", async () => {
    if (!currentOrgId) return;
    if (!isOrgOwner()) return alert("Only the organization owner can delete the organization");
    const confirmed = await showConfirmDialog({
      titleKey: "common.delete_confirm_title",
      messageKey: "org_dashboard.delete_org_confirm",
      confirmTextKey: "common.delete_btn",
      type: "danger"
    });
    if (!confirmed) return;
    try {
      await deleteOrganization(currentOrgId);
      alert("Organization deleted");
      window.location.reload();
    } catch (err) {
      alert(err.message || "Failed to delete organization");
    }
  });
}

// ─── Create Org ───

function initCreateOrg() {
  const overlay = document.getElementById("create-org-overlay");
  const createBtn = document.getElementById("create-org-btn");
  const nameInput = document.getElementById("create-org-name");
  const backdrop = document.getElementById("create-org-backdrop");
  const cancelBtn = document.getElementById("create-org-cancel");
  const confirmBtn = document.getElementById("create-org-confirm");

  if (!overlay || !createBtn) return;

  function open() {
    if (nameInput) nameInput.value = "";
    overlay.removeAttribute("hidden");
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";
    setTimeout(() => nameInput?.focus(), 50);
  }

  function close() {
    overlay.classList.remove("active");
    document.body.style.overflow = "";
    setTimeout(() => overlay.setAttribute("hidden", ""), 300);
  }

  function handleConfirm() {
    const name = nameInput?.value?.trim();
    if (!name) return alert("Please enter an organization name");
    close();
    window.location.href = `/register-host.html?orgName=${encodeURIComponent(name)}&createMode=true`;
  }

  createBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  });

  backdrop?.addEventListener("click", close);
  cancelBtn?.addEventListener("click", close);
  confirmBtn?.addEventListener("click", handleConfirm);

  nameInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleConfirm();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("active")) {
      close();
    }
  });
}

// ─── Reviews ───

let globalEventRatings = [];
let allEventRatingsCache = [];
let orgTotalAvgRating = "0.0";
let orgTotalReviewsCount = 0;
let currentEventRatingsPage = 1;
const EVENTS_RATINGS_PER_PAGE = 5;

function initReviewRatingsEventSelect() {
  const wrapper = document.getElementById("analytics-event-select-wrapper");
  if (!wrapper || wrapper.dataset.reviewRatingsInitialized === "true") return;
  wrapper.dataset.reviewRatingsInitialized = "true";
  wrapper.addEventListener("change", (e) => {
    if (e.target.id === "analytics-event-select") {
      filterAnalyticsBySelectedEvent(e.target.value);
    }
  });
}

function initAnalyticsReportEventSelect() {
  const wrapper = document.getElementById("analytics-report-event-select-wrapper");
  if (!wrapper || wrapper.dataset.analyticsInitialized === "true") return;
  wrapper.dataset.analyticsInitialized = "true";
  wrapper.addEventListener("change", (e) => {
    if (e.target.id === "analytics-report-event-select") {
      analyticsEventId = e.target.value || null;
      if (currentSection === "analytics") {
        loadOrgAnalytics();
      }
    }
  });
}

function initAnalyticsScopeControls() {
  const buttons = document.querySelectorAll(".analytics-scope-btn");
  if (!buttons.length) return;

  buttons.forEach(btn => {
    if (btn.dataset.scopeInitialized === "true") return;
    btn.dataset.scopeInitialized = "true";
    btn.addEventListener("click", () => {
      analyticsScope = btn.dataset.analyticsScope || "all";
      updateAnalyticsScopeUI();
      if (currentSection === "analytics") {
        loadOrgAnalytics();
      }
    });
  });

  updateAnalyticsScopeUI();
}

function updateAnalyticsScopeUI() {
  document.querySelectorAll(".analytics-scope-btn").forEach(btn => {
    const active = btn.dataset.analyticsScope === analyticsScope;
    btn.classList.toggle("active", active);
    btn.classList.toggle("bg-primary", active);
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("text-[#64748b]", !active);
    btn.classList.toggle("hover:bg-[#f8f9fc]", !active);
  });

  const wrapper = document.getElementById("analytics-report-event-select-wrapper");
  if (wrapper) wrapper.classList.toggle("hidden", analyticsScope !== "event");

  // Hide "Total Events" KPI when viewing a single event
  const totalEventsCard = document.getElementById("analytics-kpi-total-events");
  if (totalEventsCard) {
    totalEventsCard.classList.toggle("hidden", analyticsScope === "event");
  }

  const selectedEvent = currentEvents.find(e => e._id === analyticsEventId);
  const exportBtn = document.getElementById("export-org-excel-btn");
  if (exportBtn) {
    exportBtn.innerHTML = analyticsScope === "event"
      ? `<i class="fa-solid fa-file-excel"></i> Export Event Report (.xlsx)`
      : `<i class="fa-solid fa-file-excel"></i> Export Excel Report (.xlsx)`;
    exportBtn.disabled = analyticsScope === "event" && !selectedEvent;
    exportBtn.classList.toggle("opacity-50", exportBtn.disabled);
    exportBtn.classList.toggle("cursor-not-allowed", exportBtn.disabled);
  }
}

function filterAnalyticsBySelectedEvent(eventId) {
  const avgEl = document.getElementById("review-avg-rating");
  const countEl = document.getElementById("review-total-count");

  if (!eventId) {
    globalEventRatings = [...allEventRatingsCache];
    if (avgEl) avgEl.textContent = orgTotalAvgRating;
    if (countEl) countEl.textContent = orgTotalReviewsCount;
  } else {
    const selectedEvent = allEventRatingsCache.find(e => e._id === eventId);
    if (selectedEvent) {
      globalEventRatings = [selectedEvent];
      if (avgEl) avgEl.textContent = selectedEvent.averageRating;
      if (countEl) countEl.textContent = selectedEvent.reviewCount;
    } else {
      globalEventRatings = [];
      if (avgEl) avgEl.textContent = "0.0";
      if (countEl) countEl.textContent = "0";
    }
  }

  currentEventRatingsPage = 1;
  renderEventRatingsPage(1);
}

async function loadReviews() {
  try {
    initReviewRatingsEventSelect();
    const data = await getHostReviews(currentOrgId);
    const reviews = data.reviews || [];

    // Filter reviews to only show those for the currently selected org
    const orgReviews = reviews.filter(r => r.organization === currentOrgId || r.organization?._id === currentOrgId);

    // Calculate total org summary
    let orgTotalRating = 0;
    orgReviews.forEach(r => { orgTotalRating += r.rating; });
    orgTotalAvgRating = orgReviews.length > 0 ? (orgTotalRating / orgReviews.length).toFixed(1) : "0.0";
    orgTotalReviewsCount = orgReviews.length;

    const avgEl = document.getElementById("review-avg-rating");
    const countEl = document.getElementById("review-total-count");
    if (avgEl) avgEl.textContent = orgTotalAvgRating;
    if (countEl) countEl.textContent = orgTotalReviewsCount;

    // Fetch org events to show all organized events
    const { events: rawEvents = [] } = await getOrgActivities(currentOrgId);

    // Map events with their reviews
    allEventRatingsCache = rawEvents.map(event => {
      const evReviews = orgReviews.filter(r => r.event?._id === event._id || r.event === event._id);
      const totalScore = evReviews.reduce((sum, r) => sum + r.rating, 0);
      const avg = evReviews.length > 0 ? (totalScore / evReviews.length).toFixed(1) : "0.0";
      return {
        ...event,
        reviews: evReviews,
        averageRating: avg,
        reviewCount: evReviews.length
      };
    }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const selectedEventId = document.getElementById("analytics-event-select")?.value;
    filterAnalyticsBySelectedEvent(selectedEventId);

  } catch (err) {
    console.error("Failed to load reviews:", err);
    document.getElementById("events-ratings-list").innerHTML = `<div class="p-8 text-center text-red-500">Failed to load events.</div>`;
  }
}

function renderEventRatingsPage(page) {
  const list = document.getElementById("events-ratings-list");
  const pagination = document.getElementById("events-ratings-pagination");
  const prevBtn = document.getElementById("events-ratings-prev");
  const nextBtn = document.getElementById("events-ratings-next");
  const pageInfo = document.getElementById("events-ratings-page-info");

  if (!list) return;

  if (globalEventRatings.length === 0) {
    list.innerHTML = `<div class="p-8 text-center text-gray-500 italic">No events found for this organization.</div>`;
    pagination.classList.add("hidden");
    return;
  }

  const totalPages = Math.ceil(globalEventRatings.length / EVENTS_RATINGS_PER_PAGE);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  currentEventRatingsPage = page;

  const startIdx = (page - 1) * EVENTS_RATINGS_PER_PAGE;
  const endIdx = startIdx + EVENTS_RATINGS_PER_PAGE;
  const pageItems = globalEventRatings.slice(startIdx, endIdx);

  list.innerHTML = pageItems.map(e => `
        <div class="p-6 hover:bg-gray-50/50 transition-colors flex items-center justify-between gap-4 cursor-pointer" onclick="openReviewDetailsModal('${e._id}')">
            <div class="flex items-center gap-4 flex-1 min-w-0">
                <div class="w-16 h-16 rounded-xl bg-gray-100 overflow-hidden shrink-0 border border-gray-200">
                    <img src="${e.thumbnail || '/img/placeholder.png'}" class="w-full h-full object-cover" alt="Event" />
                </div>
                <div class="flex-1 min-w-0">
                    <h4 class="font-bold text-gray-900 truncate text-base">${e.title}</h4>
                    <p class="text-xs text-gray-500 mt-1">${formatDate(e.heldDate || e.createdAt)}</p>
                </div>
            </div>
            <div class="text-right shrink-0 flex flex-col items-end">
                <div class="flex items-center gap-2 mb-1">
                    <div class="flex text-yellow-400 text-sm">
                        <i class="fa-solid fa-star"></i>
                    </div>
                    <span class="text-lg font-bold text-gray-900">${e.averageRating}</span>
                </div>
                <span class="text-xs font-semibold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-md">${e.reviewCount} review${e.reviewCount !== 1 ? 's' : ''}</span>
            </div>
        </div>
    `).join("");

  if (totalPages > 1) {
    pagination.classList.remove("hidden");
    pageInfo.textContent = `Page ${page} of ${totalPages}`;

    prevBtn.disabled = page === 1;
    nextBtn.disabled = page === totalPages;

    prevBtn.onclick = () => renderEventRatingsPage(page - 1);
    nextBtn.onclick = () => renderEventRatingsPage(page + 1);
  } else {
    pagination.classList.add("hidden");
  }
}

window.openReviewDetailsModal = function (eventId) {
  const eventData = globalEventRatings.find(e => e._id === eventId);
  if (!eventData) return;

  const modal = document.getElementById("review-details-modal");
  const content = document.getElementById("review-details-content");
  const title = document.getElementById("review-modal-title");
  const list = document.getElementById("review-modal-list");

  title.textContent = `Reviews: ${eventData.title}`;

  if (!eventData.reviews || eventData.reviews.length === 0) {
    list.innerHTML = `<div class="py-12 text-center text-gray-500 italic">No reviews yet for this event.</div>`;
  } else {
    list.innerHTML = eventData.reviews.map(r => `
            <div class="py-5 border-b border-gray-100 last:border-0 flex items-start gap-4">
                <div class="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold flex-shrink-0">
                    ${(r.user?.fullname || r.user?.username || '?').charAt(0).toUpperCase()}
                </div>
                <div class="flex-1">
                    <div class="flex items-center justify-between mb-1">
                        <h4 class="font-bold text-gray-900">${r.user?.fullname || r.user?.username || 'Unknown User'}</h4>
                        <span class="text-xs text-gray-500">${formatDate(r.createdAt)}</span>
                    </div>
                    <div class="flex text-yellow-400 text-sm mb-2">
                        ${Array.from({ length: 5 }, (_, i) => `<i class="fa-solid fa-star ${i < r.rating ? '' : 'text-gray-200'}"></i>`).join('')}
                    </div>
                    <p class="text-gray-700 text-sm leading-relaxed">${r.content || '<em class="text-gray-400">No comment provided</em>'}</p>
                </div>
            </div>
        `).join("");
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  // trigger animation
  setTimeout(() => {
    content.classList.remove("scale-95", "opacity-0");
    content.classList.add("scale-100", "opacity-100");
  }, 10);
  document.body.style.overflow = "hidden";
}

function closeReviewDetailsModal() {
  const modal = document.getElementById("review-details-modal");
  const content = document.getElementById("review-details-content");
  if (!modal || modal.classList.contains("hidden")) return;

  content.classList.remove("scale-100", "opacity-100");
  content.classList.add("scale-95", "opacity-0");

  setTimeout(() => {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    document.body.style.overflow = "";
  }, 300);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("close-review-modal-btn")?.addEventListener("click", closeReviewDetailsModal);
  document.getElementById("review-details-backdrop")?.addEventListener("click", closeReviewDetailsModal);
});

let orgDonutChartInstance = null;
let orgMethodsChartInstance = null;

function renderAnalyticsData(data) {
  const summary = data.summary || {};
  const att = data.attendanceBreakdown || {};
  const methods = data.checkinMethods || {};

  const elEvents = document.getElementById("analytics-stat-events");
  if (elEvents) elEvents.textContent = summary.totalEvents || 0;
  const elRegs = document.getElementById("analytics-stat-regs");
  if (elRegs) elRegs.textContent = summary.totalRegistrations || 0;
  const elRate = document.getElementById("analytics-stat-att-rate");
  if (elRate) elRate.textContent = `${summary.overallAttendanceRate || 0}%`;
  const elRating = document.getElementById("analytics-stat-rating");
  if (elRating) elRating.textContent = `${summary.averageRating || 0} ★`;

  const totalAtt = (att.present || 0) + (att.late || 0) + (att.absent || 0);
  const donutCanvas = document.getElementById("chart-attendance-donut");
  const donutEmptyEl = document.getElementById("chart-attendance-donut-empty");
  const donutCtx = donutCanvas?.getContext("2d");

  if (totalAtt === 0) {
    if (donutEmptyEl) donutEmptyEl.classList.remove("hidden");
    if (donutCanvas) donutCanvas.classList.add("hidden");
    if (orgDonutChartInstance) {
      orgDonutChartInstance.destroy();
      orgDonutChartInstance = null;
    }
  } else if (donutCtx && typeof Chart !== "undefined") {
    if (donutEmptyEl) donutEmptyEl.classList.add("hidden");
    if (donutCanvas) donutCanvas.classList.remove("hidden");
    if (orgDonutChartInstance) orgDonutChartInstance.destroy();

    const labelPresent = t("org_dashboard.att_present", "Present");
    const labelLate = t("org_dashboard.att_late", "Late");
    const labelAbsent = t("org_dashboard.att_absent", "Absent");

    orgDonutChartInstance = new Chart(donutCtx, {
      type: "doughnut",
      data: {
        labels: [labelPresent, labelLate, labelAbsent],
        datasets: [{
          data: [att.present || 0, att.late || 0, att.absent || 0],
          backgroundColor: ["#10b981", "#f59e0b", "#ef4444"],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              label: function (context) {
                const val = context.raw || 0;
                const pct = totalAtt > 0 ? ((val / totalAtt) * 100).toFixed(1) : "0.0";
                return ` ${context.label}: ${val} (${pct}%)`;
              }
            }
          }
        }
      }
    });
  }

  const methodsCanvas = document.getElementById("chart-checkin-methods");
  const methodsEmptyEl = document.getElementById("chart-checkin-methods-empty");
  const methodsCtx = methodsCanvas?.getContext("2d");
  const totalCheckins = (methods.ticket_qr || 0) + (methods.student_card || 0) + (methods.manual || 0) + (methods.excel_import || 0);

  if (totalCheckins === 0 && totalAtt === 0) {
    if (methodsEmptyEl) methodsEmptyEl.classList.remove("hidden");
    if (methodsCanvas) methodsCanvas.classList.add("hidden");
    if (orgMethodsChartInstance) {
      orgMethodsChartInstance.destroy();
      orgMethodsChartInstance = null;
    }
  } else if (methodsCtx && typeof Chart !== "undefined") {
    if (methodsEmptyEl) methodsEmptyEl.classList.add("hidden");
    if (methodsCanvas) methodsCanvas.classList.remove("hidden");
    if (orgMethodsChartInstance) orgMethodsChartInstance.destroy();

    const methodLabels = [
      t("org_dashboard.method_ticket_qr", "Ticket QR"),
      t("org_dashboard.method_student_card", "Student Card"),
      t("org_dashboard.method_manual", "Manual"),
      t("org_dashboard.method_excel_import", "Excel Import")
    ];

    orgMethodsChartInstance = new Chart(methodsCtx, {
      type: "bar",
      data: {
        labels: methodLabels,
        datasets: [{
          label: t("org_dashboard.chart_checkins_label", "Check-ins"),
          data: [methods.ticket_qr || 0, methods.student_card || 0, methods.manual || 0, methods.excel_import || 0],
          backgroundColor: "#3b6fd4",
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              precision: 0,
              stepSize: 1
            }
          }
        }
      }
    });
  }

  const schoolsContainer = document.getElementById("top-schools-container");
  if (schoolsContainer) {
    const topSchools = data.topSchools || [];
    if (!topSchools.length) {
      schoolsContainer.innerHTML = `<p class="text-xs text-[#94a3b8]">${t("org_dashboard.no_schools_data", "No university data recorded yet.")}</p>`;
    } else {
      const maxCount = Math.max(...topSchools.map(s => s.count), 1);
      schoolsContainer.innerHTML = topSchools.map(s => {
        const attendeeLabel = s.count === 1 ? t("org_dashboard.attendee", "attendee") : t("org_dashboard.attendees", "attendees");
        return `
        <div>
          <div class="flex justify-between text-xs font-semibold mb-1">
            <span class="truncate max-w-[70%]">${s.name}</span>
            <span class="text-primary">${s.count} ${attendeeLabel}</span>
          </div>
          <div class="w-full h-2 bg-[#ecedfa] rounded-full overflow-hidden">
            <div class="h-full bg-primary rounded-full" style="width: ${Math.round((s.count / maxCount) * 100)}%"></div>
          </div>
        </div>
      `;
      }).join("");
    }
  }

  const majorsContainer = document.getElementById("top-majors-container");
  if (majorsContainer) {
    const topMajors = data.topMajors || [];
    if (!topMajors.length) {
      majorsContainer.innerHTML = `<p class="text-xs text-[#94a3b8]">${t("org_dashboard.no_majors_data", "No major data recorded yet.")}</p>`;
    } else {
      const maxCount = Math.max(...topMajors.map(m => m.count), 1);
      majorsContainer.innerHTML = topMajors.map(m => {
        const attendeeLabel = m.count === 1 ? t("org_dashboard.attendee", "attendee") : t("org_dashboard.attendees", "attendees");
        return `
        <div>
          <div class="flex justify-between text-xs font-semibold mb-1">
            <span class="truncate max-w-[70%]">${m.name}</span>
            <span class="text-emerald-600">${m.count} ${attendeeLabel}</span>
          </div>
          <div class="w-full h-2 bg-[#ecedfa] rounded-full overflow-hidden">
            <div class="h-full bg-emerald-500 rounded-full" style="width: ${Math.round((m.count / maxCount) * 100)}%"></div>
          </div>
        </div>
      `;
      }).join("");
    }
  }
}

function setAnalyticsEmptyState(show) {
  const empty = document.getElementById("analytics-scope-empty");
  const content = document.getElementById("analytics-content");
  if (empty) empty.classList.toggle("hidden", !show);
  if (content) content.classList.toggle("hidden", show);
  const exportBtn = document.getElementById("export-org-excel-btn");
  if (exportBtn) exportBtn.disabled = show;
}

async function loadOrgAnalytics() {
  if (!currentOrgId) return;
  initAnalyticsScopeControls();
  initAnalyticsReportEventSelect();
  try {
    updateAnalyticsScopeUI();

    // Event scope with no event picked → show empty state, hide report
    if (analyticsScope === "event" && !analyticsEventId) {
      setAnalyticsEmptyState(true);
      return;
    }
    setAnalyticsEmptyState(false);

    const data = analyticsScope === "event"
      ? await getEventAnalytics(currentOrgId, analyticsEventId)
      : await getOrgAnalytics(currentOrgId);

    renderAnalyticsData(data);

    const exportBtn = document.getElementById("export-org-excel-btn");
    if (exportBtn) {
      exportBtn.onclick = async () => {
        try {
          if (analyticsScope === "event") {
            const eventName = data.event?.title || currentEvents.find(e => e._id === analyticsEventId)?.title || "Event";
            await downloadEventExcelReport(currentOrgId, analyticsEventId, eventName);
          } else {
            const orgName = data.organization?.name || "Org";
            await downloadOrgExcelReport(currentOrgId, orgName);
          }
        } catch (err) {
          alert(err.message || "Failed to download Excel report");
        }
      };
    }
  } catch (err) {
    console.error("Load Org Analytics error:", err);
  }
}

// =============================================================================
// MULTI-STATION & KIOSK MANAGEMENT MODULE
// =============================================================================
let currentMultiBoothEvent = null;
let currentBooths = [];
let activeDesignerBooth = null;
let activeDesignerConfig = null;

const DEFAULT_KIOSK_TEMPLATE = {
  isCustom: false,
  bannerUrl: '',
  logoUrl: '',
  primaryColor: '#2563eb',
  accentColor: '#10b981',
  backgroundColor: '#090d16',
  welcomeTitle: 'Chào mừng bạn đến với sự kiện!',
  welcomeSubtitle: 'Vui lòng đưa thẻ sinh viên trước camera để điểm danh',
  layout: {
    logoPosition: 'top-left',
    cameraBox: { position: 'center', borderColor: '#10b981', borderRadius: 24 },
    showLiveCounter: true,
    counterPosition: 'top-right',
    sponsorQrUrl: '',
    sponsorQrLabel: ''
  },
  feedbackMessage: {
    title: 'Điểm danh thành công!',
    subtitle: 'Chúc bạn có một trải nghiệm tuyệt vời!',
    autoDismissSeconds: 1.2
  },
  soundTone: 'beep_high'
};

async function loadMultiBoothStations(eventId, event) {
  currentMultiBoothEvent = event;
  try {
    const res = await getBoothsByEvent(eventId);
    currentBooths = res.booths || [];

    // 1. Populate Dropdown in Attendance section
    const stationSelect = document.getElementById("multibooth-active-station-select");
    const totalBadge = document.getElementById("multibooth-total-count-badge");
    const summaryCount = document.getElementById("booth-summary-count");
    const summaryCheckins = document.getElementById("booth-summary-checkins");

    if (totalBadge) totalBadge.textContent = `${currentBooths.length} trạm`;

    let totalCheckinCount = 0;
    currentBooths.forEach(b => totalCheckinCount += (b.checkinCount || 0));

    if (summaryCount) summaryCount.textContent = `${currentBooths.length} trạm hoạt động`;
    if (summaryCheckins) summaryCheckins.textContent = `${totalCheckinCount} lượt quẹt thẻ`;

    if (stationSelect) {
      const prevVal = stationSelect.value;
      stationSelect.innerHTML = `<option value="">-- Chọn Trạm / Gian Hàng (${currentBooths.length} trạm) --</option>` +
        currentBooths.map(b => `
          <option value="${b.boothCode}" ${prevVal === b.boothCode ? 'selected' : ''}>
            ${escapeHtml(b.name)} [${b.boothCode}] • ${b.checkinCount || 0} lượt
          </option>
        `).join("");

      if (!stationSelect.value && currentBooths.length > 0) {
        stationSelect.value = currentBooths[0].boothCode;
      }
    }

    // 2. Render Cards inside Booth Management Modal if open
    renderBoothCards();
  } catch (err) {
    console.error("loadMultiBoothStations error:", err);
  }
}

function renderBoothCards() {
  const container = document.getElementById("booth-items-container");
  if (!container) return;

  if (currentBooths.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 px-4 text-slate-400">
        <i class="fa-solid fa-store text-4xl mb-3 block text-slate-300"></i>
        <p class="text-sm font-bold text-slate-600 mb-1">Chưa có trạm nào được thiết lập</p>
        <p class="text-xs text-slate-400 max-w-sm mx-auto mb-4">Nhấn nút "Thêm Trạm" ở góc trên để tạo trạm đầu tiên (VD: Gian hàng FPT, Bàn Check-in Cổng A...).</p>
      </div>
    `;
    return;
  }

  container.innerHTML = currentBooths.map(b => {
    const hasCustomLook = b.kioskConfig && b.kioskConfig.isCustom;
    return `
      <div class="p-4 sm:p-5 rounded-2xl bg-white border border-slate-200/80 hover:border-indigo-300 transition-all shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div class="flex items-start gap-3.5 min-w-0">
          <div class="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-100 flex flex-col items-center justify-center shrink-0">
            <span class="text-[9px] uppercase font-bold text-indigo-500 leading-none">MÃ TRẠM</span>
            <span class="text-base font-black font-mono text-indigo-700 leading-tight">${b.boothCode}</span>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h4 class="text-sm sm:text-base font-extrabold text-slate-900 truncate">${escapeHtml(b.name)}</h4>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${b.isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60' : 'bg-slate-100 text-slate-500'}">
                ${b.isActive ? 'Hoạt động' : 'Tạm dừng'}
              </span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${hasCustomLook ? 'bg-purple-50 text-purple-700 border border-purple-200/60' : 'bg-slate-50 text-slate-500 border border-slate-200/60'}">
                ${hasCustomLook ? '🎨 Giao diện riêng' : 'Kế thừa Master'}
              </span>
            </div>
            <p class="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
              <span><i class="fa-solid fa-location-dot text-slate-400 mr-1"></i>${escapeHtml(b.location || 'Chưa đặt vị trí')}</span>
              <span>•</span>
              <span class="font-semibold text-emerald-600 font-mono">${b.checkinCount || 0} lượt check-in</span>
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0 flex-wrap sm:flex-nowrap">
          <button type="button" class="btn-custom-booth-kiosk py-2 px-3 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border border-purple-200/60" data-booth-id="${b._id}" title="Tùy biến giao diện Kiosk riêng cho trạm này">
            <i class="fa-solid fa-palette text-xs"></i>
            <span>Tùy Biến Kiosk</span>
          </button>
          <button type="button" class="btn-print-booth-card py-2 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer" data-booth-id="${b._id}" title="In thẻ để bàn kèm mã QR">
            <i class="fa-solid fa-print text-xs"></i>
            <span>In Thẻ Bàn</span>
          </button>
          <button type="button" class="btn-edit-booth-item w-8 h-8 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-500 hover:text-slate-900 flex items-center justify-center cursor-pointer transition-colors" data-booth-id="${b._id}">
            <i class="fa-solid fa-pen text-xs"></i>
          </button>
          <button type="button" class="btn-delete-booth-item w-8 h-8 rounded-lg bg-slate-50 hover:bg-rose-50 text-slate-400 hover:text-rose-600 flex items-center justify-center cursor-pointer transition-colors" data-booth-id="${b._id}">
            <i class="fa-solid fa-trash-can text-xs"></i>
          </button>
        </div>
      </div>
    `;
  }).join("");

  // Bind Actions inside cards
  container.querySelectorAll(".btn-custom-booth-kiosk").forEach(btn => {
    btn.onclick = () => {
      const bId = btn.dataset.boothId;
      const booth = currentBooths.find(b => b._id === bId);
      if (booth) openKioskDesignerModal(booth);
    };
  });

  container.querySelectorAll(".btn-print-booth-card").forEach(btn => {
    btn.onclick = () => {
      const bId = btn.dataset.boothId;
      const booth = currentBooths.find(b => b._id === bId);
      if (booth) openSetupCardModal(booth);
    };
  });

  container.querySelectorAll(".btn-edit-booth-item").forEach(btn => {
    btn.onclick = () => {
      const bId = btn.dataset.boothId;
      const booth = currentBooths.find(b => b._id === bId);
      if (booth) openCreateOrEditBoothModal(booth);
    };
  });

  container.querySelectorAll(".btn-delete-booth-item").forEach(btn => {
    btn.onclick = async () => {
      const bId = btn.dataset.boothId;
      const booth = currentBooths.find(b => b._id === bId);
      if (!booth) return;

      const confirmed = await showConfirmDialog({
        titleKey: "common.confirm_title",
        defaultTitle: "Xác nhận xóa trạm",
        messageKey: "org_dashboard.delete_booth_confirm",
        defaultMessage: `Bạn có chắc chắn muốn xóa trạm "${booth.name}" (Mã: ${booth.boothCode})? Lịch sử check-in của trạm này vẫn được lưu trong hồ sơ sinh viên.`
      });

      if (confirmed) {
        try {
          await deleteBooth(bId);
          await loadMultiBoothStations(currentMultiBoothEvent._id, currentMultiBoothEvent);
        } catch (err) {
          alert(err.message || "Xóa trạm thất bại");
        }
      }
    };
  });
}

function openCreateOrEditBoothModal(booth = null) {
  const modal = document.getElementById("create-booth-modal");
  const title = document.getElementById("create-booth-modal-title");
  const editId = document.getElementById("edit-booth-id");
  const nameInput = document.getElementById("booth-name-input");
  const locInput = document.getElementById("booth-location-input");
  const codeInput = document.getElementById("booth-custom-code-input");
  const pinInput = document.getElementById("booth-pincode-input");
  const errorMsg = document.getElementById("create-booth-error-msg");

  if (!modal) return;
  errorMsg.textContent = "";

  if (booth) {
    title.textContent = "Chỉnh Sửa Trạm / Gian Hàng";
    editId.value = booth._id;
    nameInput.value = booth.name || "";
    locInput.value = booth.location || "";
    codeInput.value = booth.boothCode || "";
    pinInput.value = booth.pinCode || "1234";
  } else {
    title.textContent = "Thêm Trạm / Gian Hàng Mới";
    editId.value = "";
    nameInput.value = "";
    locInput.value = "";
    codeInput.value = "";
    pinInput.value = "1234";
  }

  modal.classList.remove("hidden");
  setTimeout(() => nameInput.focus(), 80);
}

async function openSetupCardModal(booth) {
  const modal = document.getElementById("booth-setup-card-modal");
  const nameEl = document.getElementById("print-booth-name");
  const eventEl = document.getElementById("print-event-title");
  const codeEl = document.getElementById("print-booth-code");
  const qrImg = document.getElementById("print-qr-img");

  if (!modal || !booth) return;

  nameEl.textContent = booth.name;
  eventEl.textContent = currentMultiBoothEvent?.title || "Sự kiện SpringWave";
  codeEl.textContent = booth.boothCode;

  try {
    const qrDataUrl = await QRCode.toDataURL(`https://springwave.io.vn/kiosk?code=${booth.boothCode}`, {
      width: 280,
      margin: 1,
      color: { dark: '#1e1b4b', light: '#ffffff' }
    });
    qrImg.src = qrDataUrl;
  } catch (e) {
    console.error("Generate setup QR failed:", e);
  }

  modal.classList.remove("hidden");
}

function openKioskDesignerModal(booth = null) {
  activeDesignerBooth = booth;
  const modal = document.getElementById("kiosk-designer-modal");
  const targetBadge = document.getElementById("designer-target-badge");
  const overrideBox = document.getElementById("designer-override-toggle-box");
  const isCustomToggle = document.getElementById("designer-is-custom-toggle");

  if (!modal) return;

  if (booth) {
    targetBadge.textContent = `Trạm: ${booth.name} (${booth.boothCode})`;
    targetBadge.className = "px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-400/30";
    overrideBox.classList.remove("hidden");

    const hasCustom = booth.kioskConfig && booth.kioskConfig.isCustom;
    isCustomToggle.checked = Boolean(hasCustom);

    activeDesignerConfig = JSON.parse(JSON.stringify(
      (hasCustom ? booth.kioskConfig : currentMultiBoothEvent?.kioskConfig) || DEFAULT_KIOSK_TEMPLATE
    ));
  } else {
    targetBadge.textContent = "Master Theme (Chung cho Sự Kiện)";
    targetBadge.className = "px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-400/30";
    overrideBox.classList.add("hidden");

    activeDesignerConfig = JSON.parse(JSON.stringify(
      currentMultiBoothEvent?.kioskConfig || DEFAULT_KIOSK_TEMPLATE
    ));
  }

  syncDesignerInputsFromConfig();
  updateArtboardLive();
  modal.classList.remove("hidden");
}

function syncDesignerInputsFromConfig() {
  const cfg = activeDesignerConfig || DEFAULT_KIOSK_TEMPLATE;
  const colorPrimary = document.getElementById("designer-color-primary");
  const colorPrimaryHex = document.getElementById("designer-color-primary-hex");
  const colorAccent = document.getElementById("designer-color-accent");
  const colorAccentHex = document.getElementById("designer-color-accent-hex");
  const colorBg = document.getElementById("designer-color-bg");
  const colorBgHex = document.getElementById("designer-color-bg-hex");
  const logoUrl = document.getElementById("designer-logo-url");
  const bannerUrl = document.getElementById("designer-banner-url");
  const titleInput = document.getElementById("designer-welcome-title");
  const subInput = document.getElementById("designer-welcome-subtitle");
  const sponsorQr = document.getElementById("designer-sponsor-qr");
  const sponsorLabel = document.getElementById("designer-sponsor-label");
  const soundTone = document.getElementById("designer-sound-tone");

  if (colorPrimary) {
    colorPrimary.value = cfg.primaryColor || "#2563eb";
    colorPrimaryHex.textContent = colorPrimary.value;
  }
  if (colorAccent) {
    colorAccent.value = cfg.accentColor || "#10b981";
    colorAccentHex.textContent = colorAccent.value;
  }
  if (colorBg) {
    colorBg.value = cfg.backgroundColor || "#090d16";
    colorBgHex.textContent = colorBg.value;
  }

  if (logoUrl) logoUrl.value = cfg.logoUrl || "";
  if (bannerUrl) bannerUrl.value = cfg.bannerUrl || "";
  if (titleInput) titleInput.value = cfg.welcomeTitle || (activeDesignerBooth ? `Gian Hàng ${activeDesignerBooth.name}` : "Chào mừng đến với sự kiện!");
  if (subInput) subInput.value = cfg.welcomeSubtitle || "Vui lòng quẹt thẻ để nhận quà và ghi nhận tham quan!";
  if (sponsorQr) sponsorQr.value = cfg.layout?.sponsorQrUrl || "";
  if (sponsorLabel) sponsorLabel.value = cfg.layout?.sponsorQrLabel || "";
  if (soundTone) soundTone.value = cfg.soundTone || "beep_high";
  applyDesignerPositions(cfg.layout?.positions || {});
}

function applyDesignerPositions(positions) {
  document.querySelectorAll('#designer-artboard [data-designer-element]').forEach((element) => {
    const position = positions[element.dataset.designerElement];
    element.style.transform = position ? `translate(${Number(position.x) || 0}%, ${Number(position.y) || 0}%)` : '';
  });
}

function initDesignerDrag() {
  const artboard = document.getElementById('designer-artboard');
  if (!artboard || artboard.dataset.dragReady) return;
  artboard.dataset.dragReady = 'true';
  artboard.querySelectorAll('[data-designer-element]').forEach((element) => {
    element.title = 'Kéo để sắp xếp trong kiosk';
    element.addEventListener('pointerdown', (event) => {
      if (event.target.closest('input,button,select,a')) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      const rect = artboard.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const previous = element.style.transform;
      const match = previous.match(/translate\((-?[\d.]+)%?,\s*(-?[\d.]+)%?\)/);
      const baseX = match ? Number(match[1]) : 0;
      const baseY = match ? Number(match[2]) : 0;
      const move = (moveEvent) => {
        const x = Math.max(-20, Math.min(20, baseX + ((moveEvent.clientX - startX) / rect.width) * 100));
        const y = Math.max(-20, Math.min(20, baseY + ((moveEvent.clientY - startY) / rect.height) * 100));
        element.style.transform = `translate(${x}%, ${y}%)`;
        element.dataset.positionX = String(Math.round(x * 10) / 10);
        element.dataset.positionY = String(Math.round(y * 10) / 10);
      };
      const up = () => {
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerup', up);
        element.removeEventListener('pointercancel', up);
      };
      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', up);
      element.addEventListener('pointercancel', up);
    });
  });
}

function updateArtboardLive() {
  const artboard = document.getElementById("designer-artboard");
  const titleEl = document.getElementById("artboard-welcome-title");
  const subEl = document.getElementById("artboard-welcome-subtitle");
  const boothTitle = document.getElementById("artboard-booth-title");
  const logoImg = document.getElementById("artboard-logo-img");
  const logoIcon = document.getElementById("artboard-logo-icon");
  const qrCard = document.getElementById("artboard-qr-card");
  const qrLabel = document.getElementById("artboard-qr-label");

  const colorPrimary = document.getElementById("designer-color-primary")?.value || "#2563eb";
  const colorBg = document.getElementById("designer-color-bg")?.value || "#090d16";
  const logoVal = document.getElementById("designer-logo-url")?.value?.trim();
  const bannerVal = document.getElementById("designer-banner-url")?.value?.trim();
  const titleVal = document.getElementById("designer-welcome-title")?.value?.trim();
  const subVal = document.getElementById("designer-welcome-subtitle")?.value?.trim();
  const qrVal = document.getElementById("designer-sponsor-qr")?.value?.trim();
  const qrLabelVal = document.getElementById("designer-sponsor-label")?.value?.trim();

  if (artboard) {
    artboard.style.backgroundColor = colorBg;
    if (bannerVal) {
      artboard.style.backgroundImage = `linear-gradient(rgba(9, 13, 22, 0.8), rgba(9, 13, 22, 0.8)), url('${bannerVal}')`;
      artboard.style.backgroundSize = "cover";
      artboard.style.backgroundPosition = "center";
    } else {
      artboard.style.backgroundImage = "none";
    }
  }

  if (titleEl) titleEl.textContent = titleVal || "Điểm Danh & Khám Phá";
  if (subEl) subEl.textContent = subVal || "Vui lòng quẹt thẻ sinh viên để nhận quà!";
  if (boothTitle) boothTitle.textContent = activeDesignerBooth ? activeDesignerBooth.name : (currentMultiBoothEvent?.title || "Gian Hàng SpringWave");

  if (logoVal) {
    logoImg.src = logoVal;
    logoImg.classList.remove("hidden");
    logoIcon.classList.add("hidden");
  } else {
    logoImg.classList.add("hidden");
    logoIcon.classList.remove("hidden");
  }

  if (qrVal) {
    qrCard.classList.remove("hidden");
    qrCard.classList.add("flex");
    if (qrLabel) qrLabel.textContent = qrLabelVal || "Quét mã nhận cẩm nang";
  } else {
    qrCard.classList.add("hidden");
  }
}

function initMultiBoothManager() {
  // 1. Open Booth Mgr Modal
  document.getElementById("open-multibooth-mgr-btn")?.addEventListener("click", () => {
    const titleEl = document.getElementById("booth-mgr-event-title");
    if (titleEl && currentMultiBoothEvent) {
      titleEl.textContent = `Quản Lý Đa Trạm - ${currentMultiBoothEvent.title}`;
    }
    renderBoothCards();
    document.getElementById("booth-management-modal")?.classList.remove("hidden");
  });

  document.getElementById("btn-close-booth-mgr")?.addEventListener("click", () => {
    document.getElementById("booth-management-modal")?.classList.add("hidden");
  });

  // 2. Open Master Kiosk Designer
  document.getElementById("btn-open-master-kiosk-designer")?.addEventListener("click", () => {
    openKioskDesignerModal(null);
  });

  // 3. Add New Booth Button
  document.getElementById("btn-add-new-booth")?.addEventListener("click", () => {
    openCreateOrEditBoothModal(null);
  });

  document.getElementById("btn-close-create-booth")?.addEventListener("click", () => {
    document.getElementById("create-booth-modal")?.classList.add("hidden");
  });
  document.getElementById("btn-cancel-create-booth")?.addEventListener("click", () => {
    document.getElementById("create-booth-modal")?.classList.add("hidden");
  });

  // 4. Submit Create/Edit Booth Form
  document.getElementById("create-booth-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const eventId = currentMultiBoothEvent?._id;
    if (!eventId) return;

    const editId = document.getElementById("edit-booth-id").value;
    const name = document.getElementById("booth-name-input").value.trim();
    const location = document.getElementById("booth-location-input").value.trim();
    const customCode = document.getElementById("booth-custom-code-input").value.trim();
    const pinCode = document.getElementById("booth-pincode-input").value.trim();
    const errorMsg = document.getElementById("create-booth-error-msg");

    errorMsg.textContent = "";
    const submitBtn = document.getElementById("btn-save-booth");
    submitBtn.disabled = true;

    try {
      if (editId) {
        await updateBooth(editId, { name, location, customCode, pinCode });
      } else {
        await createBooth(eventId, { name, location, customCode, pinCode });
      }

      document.getElementById("create-booth-modal")?.classList.add("hidden");
      await loadMultiBoothStations(eventId, currentMultiBoothEvent);
    } catch (err) {
      errorMsg.textContent = err.message || "Lỗi lưu trạm";
    } finally {
      submitBtn.disabled = false;
    }
  });

  // 5. Setup Card Modal Controls
  document.getElementById("btn-close-setup-card")?.addEventListener("click", () => {
    document.getElementById("booth-setup-card-modal")?.classList.add("hidden");
  });
  document.getElementById("btn-print-setup-card")?.addEventListener("click", () => {
    window.print();
  });

  // 6. Open Kiosk in New Tab for Active Station
  document.getElementById("btn-open-kiosk-for-active-station")?.addEventListener("click", () => {
    const stationSelect = document.getElementById("multibooth-active-station-select");
    const code = stationSelect?.value;
    if (code) {
      window.open(`/kiosk.html`, "_blank");
    } else {
      window.open(`/kiosk.html`, "_blank");
    }
  });

  // 7. Export Excel Button Handlers
  const triggerExcelExport = () => {
    if (!currentMultiBoothEvent?._id) return;
    const url = getExportMultiStationUrl(currentMultiBoothEvent._id);
    window.open(url, "_blank");
  };
  document.getElementById("export-multibooth-excel-btn")?.addEventListener("click", triggerExcelExport);
  document.getElementById("btn-download-excel-from-modal")?.addEventListener("click", triggerExcelExport);

  // 8. Kiosk Designer Controls Live Binding
  const colorInputs = ["designer-color-primary", "designer-color-accent", "designer-color-bg"];
  colorInputs.forEach(id => {
    const input = document.getElementById(id);
    const hexSpan = document.getElementById(`${id}-hex`);
    input?.addEventListener("input", () => {
      if (hexSpan) hexSpan.textContent = input.value;
      updateArtboardLive();
    });
  });

  const textInputs = ["designer-logo-url", "designer-banner-url", "designer-welcome-title", "designer-welcome-subtitle", "designer-sponsor-qr", "designer-sponsor-label"];
  textInputs.forEach(id => {
    document.getElementById(id)?.addEventListener("input", updateArtboardLive);
  });

  // Preset Buttons
  document.querySelectorAll(".preset-theme-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const primary = btn.dataset.primary;
      const accent = btn.dataset.accent;
      const bg = btn.dataset.bg;

      const pInput = document.getElementById("designer-color-primary");
      const aInput = document.getElementById("designer-color-accent");
      const bInput = document.getElementById("designer-color-bg");

      if (pInput) { pInput.value = primary; document.getElementById("designer-color-primary-hex").textContent = primary; }
      if (aInput) { aInput.value = accent; document.getElementById("designer-color-accent-hex").textContent = accent; }
      if (bInput) { bInput.value = bg; document.getElementById("designer-color-bg-hex").textContent = bg; }

      updateArtboardLive();
    });
  });

  // Reset Designer to Defaults
  document.getElementById("btn-reset-kiosk-designer")?.addEventListener("click", () => {
    activeDesignerConfig = JSON.parse(JSON.stringify(DEFAULT_KIOSK_TEMPLATE));
  syncDesignerInputsFromConfig();
  initDesignerDrag();
  updateArtboardLive();
  });

  // Close Designer Modal
  document.getElementById("btn-close-kiosk-designer")?.addEventListener("click", () => {
    document.getElementById("kiosk-designer-modal")?.classList.add("hidden");
  });

  // Save Kiosk Designer
  document.getElementById("btn-save-kiosk-designer")?.addEventListener("click", async () => {
    const saveBtn = document.getElementById("btn-save-kiosk-designer");
    saveBtn.disabled = true;

    const isCustom = activeDesignerBooth
      ? document.getElementById("designer-is-custom-toggle")?.checked ?? true
      : true;

    const newConfig = {
      isCustom,
      primaryColor: document.getElementById("designer-color-primary")?.value || "#2563eb",
      accentColor: document.getElementById("designer-color-accent")?.value || "#10b981",
      backgroundColor: document.getElementById("designer-color-bg")?.value || "#090d16",
      logoUrl: document.getElementById("designer-logo-url")?.value?.trim() || "",
      bannerUrl: document.getElementById("designer-banner-url")?.value?.trim() || "",
      welcomeTitle: document.getElementById("designer-welcome-title")?.value?.trim() || "",
      welcomeSubtitle: document.getElementById("designer-welcome-subtitle")?.value?.trim() || "",
      soundTone: document.getElementById("designer-sound-tone")?.value || "beep_high",
      layout: {
        logoPosition: "top-left",
        cameraBox: { position: "center", borderColor: document.getElementById("designer-color-accent")?.value || "#10b981", borderRadius: 24 },
        showLiveCounter: true,
        counterPosition: "top-right",
        sponsorQrUrl: document.getElementById("designer-sponsor-qr")?.value?.trim() || "",
        sponsorQrLabel: document.getElementById("designer-sponsor-label")?.value?.trim() || "",
        positions: Object.fromEntries(Array.from(document.querySelectorAll('#designer-artboard [data-designer-element]')).map((element) => [element.dataset.designerElement, { x: Number(element.dataset.positionX) || 0, y: Number(element.dataset.positionY) || 0 }]))
      }
    };

    try {
      if (activeDesignerBooth) {
        await saveBoothKioskConfig(activeDesignerBooth._id, newConfig);
        showAlertDialog({
          titleKey: "common.success",
          defaultTitle: "Thành công",
          messageKey: "org_dashboard.kiosk_save_success",
          defaultMessage: `Đã lưu giao diện Kiosk riêng cho trạm ${activeDesignerBooth.name}!`
        });
      } else {
        await saveEventKioskConfig(currentMultiBoothEvent._id, newConfig);
        currentMultiBoothEvent.kioskConfig = newConfig;
        showAlertDialog({
          titleKey: "common.success",
          defaultTitle: "Thành công",
          messageKey: "org_dashboard.kiosk_master_save_success",
          defaultMessage: "Đã lưu Master Theme Kiosk chung cho sự kiện!"
        });
      }

      document.getElementById("kiosk-designer-modal")?.classList.add("hidden");
      await loadMultiBoothStations(currentMultiBoothEvent._id, currentMultiBoothEvent);
    } catch (err) {
      alert(err.message || "Lỗi lưu giao diện Kiosk");
    } finally {
      saveBtn.disabled = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initMultiBoothManager();
});

window.addEventListener("language-changed", () => {
  applyTranslation();
  renderOrgDropdown();
  if (typeof renderEventsTable === "function") {
    renderEventsTable();
  }
  if (typeof loadOrgAnalytics === "function" && currentSection === "analytics") {
    loadOrgAnalytics();
  }
  if (selectedCertEventId) {
    const ev = currentEvents.find(e => e._id === selectedCertEventId);
    if (ev) renderCertBgPanel(ev);
  }
});
