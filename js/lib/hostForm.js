import { createActivity, updateActivity, getActivityById } from "../api/activities.js";
import { listCategories } from "../api/categories.js";
import { canPerformAction, markActionPerformed, resetCooldown, withSubmitLock } from "../lib/throttle.js";
import { sanitizeHtml } from "../lib/sanitize.js";
import { getMyOrganizations, getOrganizationById } from "../api/organizations.js";
import { getUser } from "../lib/session.js";
import { TURNSTILE_SITE_KEY } from "../config.js";
import { toLocalISODate } from "../lib/utils.js";
import { t } from "../lib/i18n.js";
import { getBoothsByEvent } from "../api/booth.js";

const MAX_FILES = 10;
let turnstileWidgetId = null;
let activeMapPicker = null;
let activeDatePickers = null;

export function initThumbnailPreview() {
    const thumbnailInput = document.getElementById("thumbnail-upload");
    const thumbnailPreview = document.getElementById("thumbnail-preview");
    const thumbnailPlaceholder = document.getElementById("thumbnail-placeholder");
    if (!thumbnailInput) return;
    thumbnailInput.addEventListener("change", function () {
        const file = this.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            thumbnailPreview.src = e.target.result;
            thumbnailPreview.style.display = "block";
            thumbnailPlaceholder.style.display = "none";
        };
        reader.readAsDataURL(file);
    });
}

export function initFileUpload() {
    const attachmentInput = document.getElementById("attachment-upload");
    const fileList = document.getElementById("file-list");
    if (!attachmentInput || !fileList) return;
    let selectedFiles = [];

    function renderFileList() {
        fileList.innerHTML = "";
        if (selectedFiles.length === 0) return;
        selectedFiles.forEach((file, index) => {
            const item = document.createElement("div");
            item.className = "file-item";
            item.innerHTML = `
                <span class="material-symbols-outlined">description</span>
                <div style="flex:1;min-width:0">
                    <div class="file-name">${file.name}</div>
                    <div class="file-size">${(file.size / 1024).toFixed(1)} KB</div>
                </div>
                <button type="button" class="file-remove" data-index="${index}" title="Remove file">
                    <span class="material-symbols-outlined">close</span>
                </button>`;
            item.querySelector(".file-remove").addEventListener("click", (e) => {
                e.stopPropagation();
                selectedFiles.splice(index, 1);
                renderFileList();
                updateFileInput();
            });
            fileList.appendChild(item);
        });
    }

    function updateFileInput() {
        const dt = new DataTransfer();
        selectedFiles.forEach(f => dt.items.add(f));
        attachmentInput.files = dt.files;
    }

    attachmentInput.addEventListener("change", function () {
        const newFiles = Array.from(this.files);
        if (newFiles.length === 0) return;
        if (selectedFiles.length + newFiles.length > MAX_FILES) {
            alert(`You can upload up to ${MAX_FILES} files total.`);
            this.value = "";
            return;
        }
        selectedFiles = [...selectedFiles, ...newFiles];
        renderFileList();
        updateFileInput();
    });
}

export function initMapPicker() {
    const mapContainer = document.getElementById("map");
    const locationInput = document.getElementById("location");
    const locationRow = document.querySelector(".location-input-row");
    const markerLabel = document.getElementById("mapMarkerLabel");
    const latInput = document.getElementById("locationLat");
    const lngInput = document.getElementById("locationLng");
    const locateBtn = document.getElementById("locateBtn");

    if (!mapContainer || !locationInput) return;

    const defaultCenter = [105.85, 21.03];
    let marker = null;
    let geocodeTimer = null;
    let searchTimer = null;
    let selectedViaSearch = false;

    const map = new maplibregl.Map({
        container: "map",
        style: {
            version: 8,
            sources: {
                osm: {
                    type: "raster",
                    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                    tileSize: 256,
                    attribution: "&copy; OpenStreetMap contributors"
                }
            },
            layers: [{ id: "osm", type: "raster", source: "osm" }]
        },
        center: defaultCenter,
        zoom: 12,
        attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    const dropdown = document.createElement("div");
    dropdown.className = "location-autocomplete";
    locationRow.style.position = "relative";
    locationRow.appendChild(dropdown);

    function hideDropdown() {
        dropdown.classList.remove("active");
    }

    function selectPlace(name, lng, lat) {
        selectedViaSearch = true;
        locationInput.value = name;
        hideDropdown();
        setMarker(lng, lat);
        map.flyTo({ center: [lng, lat], zoom: 15 });
        markerLabel.textContent = name;
        markerLabel.classList.add("filled");
    }

    function searchPlaces(query) {
        if (searchTimer) clearTimeout(searchTimer);
        if (!query.trim() || query.length < 2) { hideDropdown(); return; }
        searchTimer = setTimeout(async () => {
            try {
                const res = await fetch(
                    `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`,
                    { headers: { "Accept-Language": "en", "User-Agent": "SpringWave/1.0" } }
                );
                const data = await res.json();
                if (!data || data.length === 0) { hideDropdown(); return; }
                dropdown.innerHTML = data.map((place, i) => {
                    const name = place.display_name;
                    const type = place.type || "";
                    const shortName = name.split(",")[0];
                    return `<div class="ac-item" data-index="${i}">
                        <span class="material-symbols-outlined ac-icon">place</span>
                        <div class="ac-text">
                            <div class="ac-title">${shortName}</div>
                            <div class="ac-desc">${name}</div>
                        </div>
                    </div>`;
                }).join("");
                dropdown.classList.add("active");
                dropdown.querySelectorAll(".ac-item").forEach((el) => {
                    el.addEventListener("click", () => {
                        const idx = parseInt(el.dataset.index);
                        const place = data[idx];
                        selectPlace(place.display_name, parseFloat(place.lon), parseFloat(place.lat));
                    });
                });
            } catch { hideDropdown(); }
        }, 300);
    }

    function setMarker(lng, lat) {
        if (marker) marker.remove();
        const el = document.createElement("div");
        el.className = "map-pin";
        el.innerHTML = `<span class="material-symbols-outlined" style="font-size:36px;color:#2563EB;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.3));">location_on</span>`;
        el.style.transform = "translate(-50%, -100%)";
        marker = new maplibregl.Marker({ element: el })
            .setLngLat([lng, lat])
            .addTo(map);
        latInput.value = lat;
        lngInput.value = lng;
    }

    function reverseGeocode(lng, lat) {
        if (geocodeTimer) clearTimeout(geocodeTimer);
        geocodeTimer = setTimeout(async () => {
            try {
                const res = await fetch(
                    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`,
                    { headers: { "Accept-Language": "en", "User-Agent": "SpringWave/1.0" } }
                );
                const data = await res.json();
                const displayName = data.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
                locationInput.value = displayName;
                markerLabel.textContent = displayName;
                markerLabel.classList.add("filled");
            } catch {
                const fallback = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
                locationInput.value = fallback;
                markerLabel.textContent = fallback;
                markerLabel.classList.add("filled");
            }
        }, 300);
    }

    map.on("click", (e) => {
        const { lng, lat } = e.lngLat;
        selectedViaSearch = false;
        setMarker(lng, lat);
        map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 14) });
        reverseGeocode(lng, lat);
        hideDropdown();
    });

    locationInput.addEventListener("input", () => {
        if (!locationInput.value.trim()) {
            markerLabel.textContent = t("host.click_map_hint");
            markerLabel.classList.remove("filled");
            if (marker) { marker.remove(); marker = null; }
            latInput.value = "";
            lngInput.value = "";
            hideDropdown();
            return;
        }
        if (!selectedViaSearch) searchPlaces(locationInput.value);
        selectedViaSearch = false;
    });

    locationInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideDropdown();
    });

    locationInput.addEventListener("blur", () => {
        setTimeout(hideDropdown, 200);
    });

    locationInput.addEventListener("focus", () => {
        const val = locationInput.value.trim();
        if (val.length >= 2) searchPlaces(val);
    });

    locateBtn?.addEventListener("click", () => {
        if (!navigator.geolocation) { alert("Geolocation is not supported by your browser."); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                selectedViaSearch = false;
                map.flyTo({ center: [longitude, latitude], zoom: 15 });
                setMarker(longitude, latitude);
                reverseGeocode(longitude, latitude);
            },
            () => alert("Could not get your location. Please enable location access.")
        );
    });

    map.on("load", () => { map.resize(); });

    activeMapPicker = { map, get marker() { return marker; }, setMarker, reverseGeocode };
    return activeMapPicker;
}

export function initCheckinRulesToggle() {
    const checkbox = document.getElementById("enableCheckinRules");
    const fields = document.getElementById("checkin-rules-fields");
    if (!checkbox || !fields) return;
    checkbox.addEventListener("change", () => {
        fields.classList.toggle("hidden", !checkbox.checked);
    });
}

export function addInitialBoothRow(data = {}) {
    const list = document.getElementById("initial-booths-list");
    if (!list) return;

    const row = document.createElement("div");
    row.className = "initial-booth-row p-3 rounded-xl bg-[#f8f9fc] border border-[#ecedfa] flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 transition-all shadow-2xs";

    const namePlaceholder = t("host.booth_name_placeholder", "Tên trạm / gian hàng *");
    const locPlaceholder = t("host.booth_loc_placeholder", "Vị trí (VD: Bàn A1)");
    const codePlaceholder = t("host.booth_code_placeholder", "Mã 6 số (tự sinh)");

    row.innerHTML = `
        <input type="hidden" class="booth-id-field" value="${data._id || ''}" />
        <div class="booth-name-wrap flex-1 min-w-0 w-full sm:w-auto">
            <input type="text" class="input booth-name-field text-xs font-semibold" placeholder="${namePlaceholder}" data-i18n-placeholder="host.booth_name_placeholder" value="${data.name || ''}" required />
        </div>
        <div class="booth-loc-wrap w-full sm:w-48 shrink-0">
            <input type="text" class="input booth-loc-field text-xs" placeholder="${locPlaceholder}" data-i18n-placeholder="host.booth_loc_placeholder" value="${data.location || ''}" />
        </div>
        <div class="booth-code-wrap w-full sm:w-36 shrink-0">
            <input type="text" maxlength="6" class="input booth-code-field text-xs font-mono uppercase font-bold text-indigo-700 tracking-wider" placeholder="${codePlaceholder}" data-i18n-placeholder="host.booth_code_placeholder" value="${data.boothCode || ''}" />
        </div>
        <button type="button" class="btn-remove-booth-row w-9 h-9 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center cursor-pointer transition-colors shrink-0 self-end sm:self-center" title="Xóa trạm này">
            <span class="material-symbols-outlined text-lg">delete</span>
        </button>
    `;

    row.querySelector(".btn-remove-booth-row")?.addEventListener("click", () => {
        row.remove();
    });

    list.appendChild(row);
}

export function initMultiBoothToggle() {
    const checkbox = document.getElementById("hasMultiBooth");
    const fields = document.getElementById("multibooth-fields");
    const addBtn = document.getElementById("btn-add-initial-booth");
    const list = document.getElementById("initial-booths-list");

    if (!checkbox || !fields) return;

    checkbox.addEventListener("change", () => {
        fields.classList.toggle("hidden", !checkbox.checked);
        if (checkbox.checked && list && list.children.length === 0) {
            addInitialBoothRow();
        }
    });

    addBtn?.addEventListener("click", () => {
        addInitialBoothRow();
    });
}

export function initCertificateOptionsToggle() {
    const checkbox = document.getElementById("hasCertificate");
    const options = document.getElementById("cert-bg-options");
    const fileInput = document.getElementById("certificateBackgroundFile");
    const previewContainer = document.getElementById("cert-bg-preview-container");
    const previewImg = document.getElementById("cert-bg-preview");

    if (!checkbox || !options) return;

    const updateVisibility = () => {
        options.classList.toggle("hidden", !checkbox.checked);
    };

    checkbox.addEventListener("change", updateVisibility);
    updateVisibility();

    if (fileInput) {
        fileInput.addEventListener("change", (e) => {
            const file = e.target.files?.[0];
            if (file && previewContainer && previewImg) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    previewImg.src = ev.target.result;
                    previewContainer.classList.remove("hidden");
                };
                reader.readAsDataURL(file);
            }
        });
    }
}

export function initTimePicker() {
    const hoursList = document.getElementById("hoursList");
    const minutesList = document.getElementById("minutesList");
    if (hoursList && hoursList.options.length === 0) {
        for (let i = 0; i < 24; i++) {
            const opt = document.createElement("option");
            opt.value = String(i).padStart(2, '0');
            hoursList.appendChild(opt);
        }
    }
    if (minutesList && minutesList.options.length === 0) {
        for (let i = 0; i < 60; i++) { // Step 1 minute!
            const opt = document.createElement("option");
            opt.value = String(i).padStart(2, '0');
            minutesList.appendChild(opt);
        }
    }

    const timeFields = [
        { hour: 'heldHour', min: 'heldMinute', defaultHour: new Date().getHours(), defaultMin: new Date().getMinutes() },
        { hour: 'endHour', min: 'endMinute', defaultHour: 23, defaultMin: 59 },
        { hour: 'deadlineHour', min: 'deadlineMinute', defaultHour: 23, defaultMin: 59 },
    ];
    timeFields.forEach(tf => {
        const hourEl = document.getElementById(tf.hour);
        const minEl = document.getElementById(tf.min);
        if (!hourEl || !minEl) return;

        if (hourEl.tagName === 'SELECT' && hourEl.options.length === 0) {
            for (let i = 0; i < 24; i++) {
                const v = String(i).padStart(2, '0');
                hourEl.appendChild(new Option(v, v));
            }
        }
        if (minEl.tagName === 'SELECT' && minEl.options.length === 0) {
            for (let i = 0; i < 60; i++) { // Step 1 minute!
                const v = String(i).padStart(2, '0');
                minEl.appendChild(new Option(v, v));
            }
        }

        if (!hourEl.value) hourEl.value = String(tf.defaultHour).padStart(2, '0');
        if (!minEl.value) minEl.value = String(tf.defaultMin).padStart(2, '0');

        [hourEl, minEl].forEach(el => {
            const isHour = el === hourEl;
            const maxVal = isHour ? 23 : 59;
            el.addEventListener("blur", () => {
                if (!el.value.trim()) return;
                let val = parseInt(el.value, 10);
                if (isNaN(val) || val < 0) val = 0;
                if (val > maxVal) val = maxVal;
                el.value = String(val).padStart(2, '0');
            });
            el.addEventListener("input", () => {
                el.value = el.value.replace(/[^0-9]/g, '');
                if (el.value.length > 2) {
                    el.value = el.value.slice(0, 2);
                }
            });
        });
    });
}

export function initDateValidation() {
    const heldDate = createDatePicker({
        triggerId: "heldDateInput", dropdownId: "heldDateDropdown",
        gridId: "heldDateCalGrid", monthLabelId: "heldDateMonthLabel",
        prevBtnId: "heldDatePrev", nextBtnId: "heldDateNext",
        clearBtnId: "heldDateClear", closeBtnId: "heldDateClose",
        hiddenInputId: "heldDate"
    });

    const applicationDeadline = createDatePicker({
        triggerId: "applicationDeadlineInput", dropdownId: "applicationDeadlineDropdown",
        gridId: "applicationDeadlineCalGrid", monthLabelId: "applicationDeadlineMonthLabel",
        prevBtnId: "applicationDeadlinePrev", nextBtnId: "applicationDeadlineNext",
        clearBtnId: "applicationDeadlineClear", closeBtnId: "applicationDeadlineClose",
        hiddenInputId: "applicationDeadline"
    });

    const heldDateEnd = createDatePicker({
        triggerId: "heldDateEndInput", dropdownId: "heldDateEndDropdown",
        gridId: "heldDateEndCalGrid", monthLabelId: "heldDateEndMonthLabel",
        prevBtnId: "heldDateEndPrev", nextBtnId: "heldDateEndNext",
        clearBtnId: "heldDateEndClear", closeBtnId: "heldDateEndClose",
        hiddenInputId: "heldDateEnd"
    });

    loadSchoolList();
    initTimePicker();

    activeDatePickers = { heldDate, applicationDeadline, heldDateEnd };
    return activeDatePickers;
}

import { getUniversities } from "../api/universities.js";

async function loadSchoolList() {
    const datalist = document.getElementById("schoolList");
    if (!datalist) return;
    try {
        const universities = await getUniversities();
        datalist.innerHTML = universities.map(u =>
            `<option value="${u.name}">${u.shortName || u.name}</option>`
        ).join("");
    } catch (e) {
        console.error("Failed to load school list:", e);
    }
}

function createDatePicker(config) {
    const input = document.getElementById(config.triggerId);
    const dropdown = document.getElementById(config.dropdownId);
    const grid = document.getElementById(config.gridId);
    const monthLabel = document.getElementById(config.monthLabelId);
    const prevBtn = document.getElementById(config.prevBtnId);
    const nextBtn = document.getElementById(config.nextBtnId);
    const clearBtn = document.getElementById(config.clearBtnId);
    const closeBtn = document.getElementById(config.closeBtnId);
    const hiddenInput = document.getElementById(config.hiddenInputId);

    if (!input || !dropdown || !grid || !monthLabel) return null;

    let currentMonth = new Date().getMonth();
    let currentYear = new Date().getFullYear();
    let selectedDate = null;
    let onSelect = null;
    let manualTyping = false;

    document.body.appendChild(dropdown);

    function pad(n) { return String(n).padStart(2, "0"); }

    function formatDate(d) {
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    }

    function parseDate(str) {
        const parts = str.split("/");
        if (parts.length !== 3) return null;
        const d = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const y = parseInt(parts[2], 10);
        if (isNaN(d) || isNaN(m) || isNaN(y)) return null;
        const date = new Date(y, m - 1, d);
        if (date.getDate() !== d || date.getMonth() !== m - 1 || date.getFullYear() !== y) return null;
        return date;
    }

    function updateDisplay() {
        if (selectedDate) {
            input.value = formatDate(selectedDate);
            if (hiddenInput) hiddenInput.value = toLocalISODate(selectedDate);
        } else {
            input.value = "";
            if (hiddenInput) hiddenInput.value = "";
        }
    }

    function setDate(d) {
        if (!d) {
            selectedDate = null;
            if (hiddenInput) hiddenInput.value = "";
            input.value = "";
            return;
        }
        const dateObj = (d instanceof Date) ? d : new Date(d);
        if (isNaN(dateObj.getTime())) return;
        selectedDate = dateObj;
        currentMonth = dateObj.getMonth();
        currentYear = dateObj.getFullYear();
        manualTyping = false;
        updateDisplay();
    }

    const api = {
        clear() {
            selectedDate = null;
            if (hiddenInput) hiddenInput.value = "";
            updateDisplay();
        },
        setDate,
        get onSelect() { return onSelect; },
        set onSelect(fn) { onSelect = fn; },
        get selectedDate() { return selectedDate; }
    };

    function renderCalendar() {
        grid.innerHTML = "";
        const weekdays = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
        weekdays.forEach(d => {
            const el = document.createElement("div");
            el.className = "dp-weekday";
            el.textContent = d;
            grid.appendChild(el);
        });
        monthLabel.textContent = new Date(currentYear, currentMonth).toLocaleDateString("en-US", { month: "long", year: "numeric" });
        const firstDay = new Date(currentYear, currentMonth, 1).getDay();
        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
        const daysInPrevMonth = new Date(currentYear, currentMonth, 0).getDate();
        const startOffset = firstDay === 0 ? 6 : firstDay - 1;
        for (let i = startOffset - 1; i >= 0; i--) {
            const el = document.createElement("div");
            el.className = "dp-day other-month";
            el.textContent = daysInPrevMonth - i;
            grid.appendChild(el);
        }
        const today = new Date();
        for (let d = 1; d <= daysInMonth; d++) {
            const el = document.createElement("div");
            el.className = "dp-day";
            el.textContent = d;
            const date = new Date(currentYear, currentMonth, d);
            if (d === today.getDate() && currentMonth === today.getMonth() && currentYear === today.getFullYear()) el.classList.add("today");
            if (selectedDate && date.getTime() === selectedDate.getTime()) el.classList.add("selected");
            el.addEventListener("click", () => {
                selectedDate = date;
                manualTyping = false;
                updateDisplay();
                renderCalendar();
                closeDropdown();
                if (onSelect) onSelect(date);
            });
            grid.appendChild(el);
        }
        const totalCells = startOffset + daysInMonth;
        const remaining = (7 - (totalCells % 7)) % 7;
        for (let i = 1; i <= remaining; i++) {
            const el = document.createElement("div");
            el.className = "dp-day other-month";
            el.textContent = i;
            grid.appendChild(el);
        }
    }

    const NAVBAR_SAFE = 80;

    function positionDropdown() {
        const rect = input.getBoundingClientRect();
        const dropdownWidth = 320;
        const dropdownHeight = dropdown.offsetHeight || 380;
        let left = rect.left + rect.width / 2;
        if (left - dropdownWidth / 2 < 10) left = 10 + dropdownWidth / 2;
        if (left + dropdownWidth / 2 > window.innerWidth - 10) left = window.innerWidth - 10 - dropdownWidth / 2;
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        let top;
        if (spaceBelow < dropdownHeight + 16 && spaceAbove > dropdownHeight + 16) {
            top = rect.top - dropdownHeight - 8;
        } else {
            top = rect.bottom + 8;
        }
        if (top < NAVBAR_SAFE) top = NAVBAR_SAFE;
        if (top + dropdownHeight > window.innerHeight - 10) top = window.innerHeight - dropdownHeight - 10;
        dropdown.style.left = left + "px";
        dropdown.style.top = top + "px";
    }

    function openDropdown() {
        const today = new Date();
        if (!selectedDate) {
            const rawVal = input.value.trim();
            if (rawVal) {
                const parsed = parseDate(rawVal);
                if (parsed) selectedDate = parsed;
            } else if (hiddenInput?.value) {
                const parsed = new Date(hiddenInput.value);
                if (!isNaN(parsed.getTime())) selectedDate = parsed;
            }
        }
        if (!selectedDate) { currentMonth = today.getMonth(); currentYear = today.getFullYear(); }
        else { currentMonth = selectedDate.getMonth(); currentYear = selectedDate.getFullYear(); }
        renderCalendar();
        positionDropdown();
        dropdown.style.transform = "translateX(-50%) translateY(8px) scale(0.96)";
        dropdown.classList.add("active");
        if (input.parentElement) input.parentElement.classList.add("active");
        requestAnimationFrame(() => {
            dropdown.style.transform = "translateX(-50%) translateY(0) scale(1)";
        });
        window.addEventListener("scroll", followOnScroll, { passive: true });
        window.addEventListener("resize", followOnScroll, { passive: true });
    }

    function followOnScroll() {
        const rect = input.getBoundingClientRect();
        const navbarH = 80;
        if (rect.bottom < navbarH || rect.top > window.innerHeight) { closeDropdown(); return; }
        positionDropdown();
    }

    function closeDropdown() {
        dropdown.classList.remove("active");
        if (input.parentElement) input.parentElement.classList.remove("active");
        window.removeEventListener("scroll", followOnScroll);
        window.removeEventListener("resize", followOnScroll);
    }

    input.addEventListener("focus", () => {
        if (!dropdown.classList.contains("active")) openDropdown();
    });

    input.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!dropdown.classList.contains("active")) openDropdown();
    });

    input.addEventListener("input", () => {
        const val = input.value.trim();
        if (!val) {
            selectedDate = null;
            if (hiddenInput) hiddenInput.value = "";
            return;
        }
        if (val.length >= 8) {
            const parsed = parseDate(val);
            if (parsed) {
                selectedDate = parsed;
                manualTyping = true;
                if (hiddenInput) hiddenInput.value = toLocalISODate(selectedDate);
                if (onSelect) onSelect(parsed);
            }
        }
    });

    input.addEventListener("blur", () => {
        if (manualTyping || !input.value.trim()) return;
        const parsed = parseDate(input.value.trim());
        if (!parsed) {
            input.value = selectedDate ? formatDate(selectedDate) : "";
        }
    });

    if (prevBtn) prevBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        currentMonth--;
        if (currentMonth < 0) { currentMonth = 11; currentYear--; }
        renderCalendar();
    });

    if (nextBtn) nextBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        currentMonth++;
        if (currentMonth > 11) { currentMonth = 0; currentYear++; }
        renderCalendar();
    });

    if (clearBtn) clearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedDate = null;
        manualTyping = false;
        if (hiddenInput) hiddenInput.value = "";
        updateDisplay();
        renderCalendar();
    });

    if (closeBtn) closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeDropdown();
    });

    document.addEventListener("click", (e) => {
        if (dropdown.classList.contains("active")) {
            if (!dropdown.contains(e.target) && e.target !== input && !input.contains(e.target)) {
                closeDropdown();
            }
        }
    });

    dropdown.addEventListener("click", (e) => { e.stopPropagation(); });
    updateDisplay();
    return api;
}

const EDIT_EVENT_ID_KEY = '__editEventId';

export function applyEditModeHeading() {
  const headingEl = document.getElementById("host-activity-heading") || document.querySelector(".page-title h1");
  if (headingEl) {
    headingEl.dataset.i18n = "host.edit_page_title";
    headingEl.textContent = t("host.edit_page_title") || "Adjust Activity";
  }

  const descEl = document.getElementById("host-activity-desc") || document.querySelector(".page-title p");
  if (descEl) {
    descEl.dataset.i18n = "host.edit_page_desc";
    descEl.textContent = t("host.edit_page_desc") || "Update the details below to adjust your activity.";
  }

  const pageTitleEl = document.querySelector("title[data-i18n]");
  if (pageTitleEl) {
    pageTitleEl.dataset.i18n = "host.edit_title";
    document.title = t("host.edit_title") || "Adjust Activity - SpringWave";
  }

  const editForm = document.getElementById("activity-form");
  if (editForm) {
    const submitBtn = editForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.dataset.i18n = "host.update_event";
      submitBtn.textContent = t("host.update_event") || "Update Event";
    }
  }
}

export async function initEditMode(eventId) {
  applyEditModeHeading();
  try {
    const result = await getActivityById(eventId);
    const event = result.activity || result.event;
    if (!event) return;

    sessionStorage.setItem(EDIT_EVENT_ID_KEY, eventId);
    applyEditModeHeading();

    const form = document.getElementById("activity-form");
    if (!form) return;

    const titleEl = document.getElementById("title");
    const descEl = document.getElementById("description");
    const locationEl = document.getElementById("location");
    const locationLatEl = document.getElementById("locationLat");
    const locationLngEl = document.getElementById("locationLng");
    const hostNameEl = document.getElementById("hostName");
    const registrationLinkEl = document.getElementById("registrationLink");
    const hasCertificateEl = document.getElementById("hasCertificate");
    const hasAttendanceEl = document.getElementById("hasAttendance");
    const enableCheckinRulesEl = document.getElementById("enableCheckinRules");
    const lateMinEl = document.getElementById("lateCheckinMinutes");
    const expiredMinEl = document.getElementById("expiredCheckinMinutes");
    const thumbPreview = document.getElementById("thumbnail-preview");
    const thumbPlaceholder = document.getElementById("thumbnail-placeholder");
    const turnstileContainer = document.getElementById("turnstile-container");
    if (turnstileContainer) turnstileContainer.style.display = "none";

    if (titleEl) titleEl.value = event.title || '';
    if (descEl) descEl.value = event.description || '';
    if (locationEl) locationEl.value = event.location || '';
    if (locationLatEl && event.locationLat !== undefined && event.locationLat !== null) locationLatEl.value = event.locationLat;
    if (locationLngEl && event.locationLng !== undefined && event.locationLng !== null) locationLngEl.value = event.locationLng;
    if (hostNameEl) hostNameEl.value = event.hostName || event.createdByName || '';
    if (registrationLinkEl) registrationLinkEl.value = event.registrationLink || '';
    const slotsEl = document.getElementById("slots");
    if (slotsEl) slotsEl.value = (event.slots !== undefined && event.slots !== null && Number(event.slots) > 0) ? event.slots : '';

    if (event.format) {
      const radio = form.querySelector(`input[name="format"][value="${event.format}"]`);
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event("change"));
      }
    }
    const meetingUrlEl = document.getElementById("meetingUrl");
    if (meetingUrlEl && event.meetingUrl) meetingUrlEl.value = event.meetingUrl;
    const meetingPlatformEl = document.getElementById("meetingPlatform");
    if (meetingPlatformEl && event.meetingPlatform) meetingPlatformEl.value = event.meetingPlatform;

    // Thumbnail preview
    if (event.thumbnail && thumbPreview) {
      thumbPreview.src = event.thumbnail;
      thumbPreview.style.display = "block";
      if (thumbPlaceholder) thumbPlaceholder.style.display = "none";
    }

    // Map pin
    if (event.locationLat && event.locationLng) {
      const lat = parseFloat(event.locationLat);
      const lng = parseFloat(event.locationLng);
      if (!isNaN(lat) && !isNaN(lng)) {
        const updatePin = () => {
          if (activeMapPicker?.setMarker) {
            activeMapPicker.setMarker(lng, lat);
            activeMapPicker.map?.flyTo({ center: [lng, lat], zoom: 15 });
            const markerLabel = document.getElementById("mapMarkerLabel");
            if (markerLabel && event.location) {
              markerLabel.textContent = event.location;
              markerLabel.classList.add("filled");
            }
          }
        };
        updatePin();
        setTimeout(updatePin, 300);
      }
    }

    // Dates & Times
    if (event.heldDate) {
      const d = new Date(event.heldDate);
      if (!isNaN(d.getTime())) {
        if (activeDatePickers?.heldDate?.setDate) {
          activeDatePickers.heldDate.setDate(d);
        } else {
          const heldDateInput = document.getElementById("heldDate");
          if (heldDateInput) heldDateInput.value = toLocalISODate(d);
          const dateInput = document.getElementById("heldDateInput");
          if (dateInput) {
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            dateInput.value = `${day}/${month}/${year}`;
          }
        }
        const hourEl = document.getElementById("heldHour");
        const minEl = document.getElementById("heldMinute");
        if (hourEl) hourEl.value = String(d.getHours()).padStart(2, '0');
        if (minEl) minEl.value = String(d.getMinutes()).padStart(2, '0');
      }
    }

    if (event.heldDateEnd) {
      const d = new Date(event.heldDateEnd);
      if (!isNaN(d.getTime())) {
        if (activeDatePickers?.heldDateEnd?.setDate) {
          activeDatePickers.heldDateEnd.setDate(d);
        } else {
          const endDateInput = document.getElementById("heldDateEnd");
          if (endDateInput) endDateInput.value = toLocalISODate(d);
          const dateInput = document.getElementById("heldDateEndInput");
          if (dateInput) {
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            dateInput.value = `${day}/${month}/${year}`;
          }
        }
        const endHourEl = document.getElementById("endHour");
        const endMinEl = document.getElementById("endMinute");
        if (endHourEl) endHourEl.value = String(d.getHours()).padStart(2, '0');
        if (endMinEl) endMinEl.value = String(d.getMinutes()).padStart(2, '0');
      }
    }

    if (event.applicationDeadline) {
      const d = new Date(event.applicationDeadline);
      if (!isNaN(d.getTime())) {
        if (activeDatePickers?.applicationDeadline?.setDate) {
          activeDatePickers.applicationDeadline.setDate(d);
        } else {
          const deadlineInput = document.getElementById("applicationDeadline");
          if (deadlineInput) deadlineInput.value = toLocalISODate(d);
          const dateInput = document.getElementById("applicationDeadlineInput");
          if (dateInput) {
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            dateInput.value = `${day}/${month}/${year}`;
          }
        }
        const deadlineHourEl = document.getElementById("deadlineHour");
        const deadlineMinEl = document.getElementById("deadlineMinute");
        if (deadlineHourEl) deadlineHourEl.value = String(d.getHours()).padStart(2, '0');
        if (deadlineMinEl) deadlineMinEl.value = String(d.getMinutes()).padStart(2, '0');
      }
    }

    // Certificates
    if (hasCertificateEl) {
      hasCertificateEl.checked = event.hasCertificate === true || event.hasCertificate === 'true';
      const certBgOptions = document.getElementById("cert-bg-options");
      if (certBgOptions) {
        certBgOptions.classList.toggle("hidden", !hasCertificateEl.checked);
      }
      if (event.certificateBackground) {
        const previewContainer = document.getElementById("cert-bg-preview-container");
        const previewImg = document.getElementById("cert-bg-preview");
        if (previewContainer && previewImg) {
          previewImg.src = event.certificateBackground;
          previewContainer.classList.remove("hidden");
        }
      }
    }

    // Attendance & Rules
    if (hasAttendanceEl) hasAttendanceEl.checked = event.hasAttendance === true || event.hasAttendance === 'true';
    const hasRules = (Number(event.lateCheckinMinutes) > 0 || Number(event.expiredCheckinMinutes) > 0 || event.allowEarlyCheckin !== undefined);
    if (enableCheckinRulesEl) {
      enableCheckinRulesEl.checked = hasRules;
      const rulesFields = document.getElementById("checkin-rules-fields");
      if (rulesFields) rulesFields.classList.toggle("hidden", !hasRules);
      if (lateMinEl) lateMinEl.value = event.lateCheckinMinutes || 0;
      if (expiredMinEl) expiredMinEl.value = event.expiredCheckinMinutes || 0;
      const allowEarlyEl = document.getElementById("allowEarlyCheckin");
      if (allowEarlyEl) {
        allowEarlyEl.checked = event.allowEarlyCheckin === true || event.allowEarlyCheckin === 'true';
      }
    }

    // Multi-Booth / Kiosk Mode
    const hasMultiBoothEl = document.getElementById("hasMultiBooth");
    const multiboothFields = document.getElementById("multibooth-fields");
    if (hasMultiBoothEl) {
      hasMultiBoothEl.checked = event.hasMultiBooth === true || event.hasMultiBooth === 'true';
      if (multiboothFields) multiboothFields.classList.toggle("hidden", !hasMultiBoothEl.checked);
      if (event.multiBoothConfig) {
        const bType = document.getElementById("boothTypeLabel");
        const minB = document.getElementById("minBoothsRequired");
        const reqP = document.getElementById("requireBoothPhoto");
        if (bType && event.multiBoothConfig.boothTypeLabel) bType.value = event.multiBoothConfig.boothTypeLabel;
        if (minB && event.multiBoothConfig.minBoothsRequired !== undefined) minB.value = event.multiBoothConfig.minBoothsRequired;
        if (reqP && event.multiBoothConfig.requirePhoto !== undefined) reqP.checked = Boolean(event.multiBoothConfig.requirePhoto);
      }

      // Load existing booths if editing
      const eventId = event._id || event.id;
      if (eventId && hasMultiBoothEl.checked) {
        const list = document.getElementById("initial-booths-list");
        if (list) {
          list.innerHTML = '';
          getBoothsByEvent(eventId).then(res => {
            const booths = res?.booths || [];
            if (booths.length > 0) {
              booths.forEach(b => addInitialBoothRow(b));
            } else {
              addInitialBoothRow();
            }
          }).catch(() => {
            addInitialBoothRow();
          });
        }
      }
    }

    // Organization
    if (event.organization) {
      const orgId = typeof event.organization === 'object' ? (event.organization._id || event.organization.id) : event.organization;
      const orgName = typeof event.organization === 'object' ? (event.organization.name || '') : '';
      let orgIdInput = document.getElementById("org-id-value");
      let orgNameInput = document.getElementById("org-name-display");
      const container = document.getElementById("org-selector-content");
      const hint = document.getElementById("org-field-hint");

      if (orgIdInput) {
        orgIdInput.value = orgId;
        if (orgIdInput.tagName === 'SELECT') {
          orgIdInput.dispatchEvent(new Event('change'));
        }
      } else if (container) {
        container.innerHTML = `
          <input type="text" class="input" id="org-name-display" value="${orgName || event.hostName || ''}" placeholder="Organization name" readonly />
          <input type="hidden" id="org-id-value" value="${orgId}" />
        `;
        orgIdInput = document.getElementById("org-id-value");
        orgNameInput = document.getElementById("org-name-display");
      }
      if (orgNameInput && orgName) orgNameInput.value = orgName;
      if (hint && orgName) hint.textContent = t("host.hosting_as", { name: orgName }) || `Hosting as ${orgName}`;
    }

    // Activity Type
    if (event.type) {
      const typeVal = String(event.type).trim();
      const typeRadio = form.querySelector(`input[name="type"][value="${typeVal}"]`) ||
                        Array.from(form.querySelectorAll('input[name="type"]')).find(r => r.value.toLowerCase() === typeVal.toLowerCase());
      if (typeRadio) {
        typeRadio.checked = true;
        typeRadio.dispatchEvent(new Event("change"));
      }
    }

    // Non-Partner Mode
    const nonPartnerRadio = form.querySelector('input[name="isNonPartnerMode"][value="true"]');
    const partnerRadio = form.querySelector('input[name="isNonPartnerMode"][value="false"]');
    if (event.isNonPartner) {
      if (nonPartnerRadio) {
        nonPartnerRadio.checked = true;
        nonPartnerRadio.dispatchEvent(new Event("change"));
      }
      const npHost = document.getElementById("nonPartnerHostName");
      if (npHost) npHost.value = event.hostName || '';
      if (registrationLinkEl) registrationLinkEl.value = event.registrationLink || '';
    } else {
      if (partnerRadio) {
        partnerRadio.checked = true;
        partnerRadio.dispatchEvent(new Event("change"));
      }
    }

    // Existing Attachment Links
    if (Array.isArray(event.attachments) && event.attachments.length > 0) {
      const existingLinks = event.attachments
        .filter(att => att.activityAttachLink && /^https?:\/\//i.test(att.activityAttachLink))
        .map(att => ({ url: att.activityAttachLink, description: att.description || '' }));
      if (existingLinks.length > 0) {
        setAttachmentLinks(existingLinks);
      }
    }

    const statusMsg = document.getElementById("status-msg");
    if (statusMsg) {
      statusMsg.textContent = t("host.edit_mode_status");
      statusMsg.classList.remove("error-msg", "success-msg");
      statusMsg.classList.add("info-msg");
    }

    applyEditModeHeading();
  } catch (err) {
    console.error('Failed to load event for editing:', err);
  }
}


let categoriesCache = null;

async function ensureCategories() {
    if (!categoriesCache) {
        try {
            const data = await listCategories();
            categoriesCache = data.categories || [];
        } catch {
            categoriesCache = [];
        }
    }
    return categoriesCache;
}

function findCategoryByType(type) {
    if (!categoriesCache || !type) return null;
    const slug = type.toLowerCase();
    return categoriesCache.find(c => c.slug === slug || c.name.toLowerCase() === slug) || null;
}

export function initEventModeSelector() {
    const user = getUser();
    const modeContainer = document.getElementById("event-mode-container");
    const regLinkContainer = document.getElementById("registration-link-container");
    const nonPartnerHostContainer = document.getElementById("non-partner-host-container");
    const orgFieldContainer = document.getElementById("org-field-container");
    const regLinkInput = document.getElementById("registrationLink");
    const nonPartnerHostInput = document.getElementById("nonPartnerHostName");

    if (!modeContainer) return;

    if (user?.role === 'admin') {
        modeContainer.style.display = "block";

        const updateFields = () => {
            const isNonPartner = document.querySelector('input[name="isNonPartnerMode"]:checked')?.value === 'true';
            if (isNonPartner) {
                if (regLinkContainer) regLinkContainer.style.display = "block";
                if (nonPartnerHostContainer) nonPartnerHostContainer.style.display = "block";
                if (orgFieldContainer) orgFieldContainer.style.display = "none";
                if (regLinkInput) regLinkInput.required = true;
                if (nonPartnerHostInput) nonPartnerHostInput.required = true;
            } else {
                if (regLinkContainer) regLinkContainer.style.display = "none";
                if (nonPartnerHostContainer) nonPartnerHostContainer.style.display = "none";
                if (orgFieldContainer) orgFieldContainer.style.display = "block";
                if (regLinkInput) regLinkInput.required = false;
                if (nonPartnerHostInput) nonPartnerHostInput.required = false;
            }
        };

        document.querySelectorAll('input[name="isNonPartnerMode"]').forEach(radio => {
            radio.addEventListener("change", updateFields);
        });

        updateFields();
    } else {
        modeContainer.style.display = "none";
        if (regLinkContainer) regLinkContainer.style.display = "none";
        if (nonPartnerHostContainer) nonPartnerHostContainer.style.display = "none";
        if (orgFieldContainer) orgFieldContainer.style.display = "block";
        if (regLinkInput) regLinkInput.required = false;
        if (nonPartnerHostInput) nonPartnerHostInput.required = false;
    }
}

export function initFormatSelector() {
    const formatRadios = document.querySelectorAll('input[name="format"]');
    const onlineContainer = document.getElementById("online-meeting-container");
    const locationContainer = document.getElementById("location-field-container");
    const locationInput = document.getElementById("location");

    function updateFormat() {
        const val = document.querySelector('input[name="format"]:checked')?.value || 'offline';
        if (val === 'online') {
            if (onlineContainer) onlineContainer.style.display = "block";
            if (locationContainer) locationContainer.style.display = "none";
            if (locationInput) {
                locationInput.required = false;
                if (!locationInput.value.trim()) locationInput.value = "Online";
            }
        } else {
            if (onlineContainer) onlineContainer.style.display = "none";
            if (locationContainer) locationContainer.style.display = "block";
            if (locationInput) {
                locationInput.required = true;
                if (locationInput.value === "Online") locationInput.value = "";
            }
        }
    }

    formatRadios.forEach(radio => radio.addEventListener("change", updateFormat));
    updateFormat();
}

export function initFormSubmit(orgId, onSuccess) {
    const form = document.getElementById("activity-form");
    const statusMsg = document.getElementById("status-msg");
    if (!form) return;

    initEventModeSelector();
    initFormatSelector();

    const params = new URLSearchParams(window.location.search);
    const editId = params.get("edit");
    if (editId) {
      sessionStorage.setItem(EDIT_EVENT_ID_KEY, editId);
    } else if (!sessionStorage.getItem(EDIT_EVENT_ID_KEY)) {
      sessionStorage.removeItem(EDIT_EVENT_ID_KEY);
    }

    form.addEventListener("submit", async (e) => {
        e.preventDefault();

        const editEventId = sessionStorage.getItem(EDIT_EVENT_ID_KEY) || (new URLSearchParams(window.location.search)).get("edit");
        const isEdit = !!editEventId;

        const check = canPerformAction(isEdit ? 'updateEvent' : 'createEvent');
        if (!check.allowed) {
            setStatus(`Please wait ${check.remaining} seconds before ${isEdit ? 'updating' : 'posting'} again.`, true, statusMsg);
            return;
        }

        const user = getUser();
        const title = sanitizeHtml(document.getElementById("title")?.value.trim());
        const description = sanitizeHtml(document.getElementById("description")?.value.trim());
        let location = sanitizeHtml(document.getElementById("location")?.value.trim());
        const format = form.querySelector('input[name="format"]:checked')?.value || 'offline';
        const meetingUrl = sanitizeHtml(document.getElementById("meetingUrl")?.value.trim() || "");
        const meetingPlatform = document.getElementById("meetingPlatform")?.value || "other";

        if (format === 'online' && !location) {
            location = 'Online';
        }

        const type = form.querySelector('input[name="type"]:checked')?.value;
        const hostName = sanitizeHtml(document.getElementById("hostName")?.value.trim());
        const nonPartnerHostName = sanitizeHtml(document.getElementById("nonPartnerHostName")?.value.trim());
        const heldDate = document.getElementById("heldDate")?.value;
        const heldHour = document.getElementById("heldHour")?.value || '00';
        const heldMinute = document.getElementById("heldMinute")?.value || '00';
        const registrationLink = sanitizeHtml(document.getElementById("registrationLink")?.value.trim());
        const thumbnailFile = document.getElementById("thumbnail-upload")?.files?.[0];
        const attachmentFiles = document.getElementById("attachment-upload")?.files;

        if (!title || !description || (!location && format !== 'online') || !type || !heldDate) {
            setStatus("Please fill in all required fields.", true, statusMsg);
            return;
        }

        const isNonPartnerMode = form.querySelector('input[name="isNonPartnerMode"]:checked')?.value === 'true';

        const orgIdVal = document.getElementById("org-id-value")?.value || orgId;

        const formData = new FormData();
        formData.append("title", title);
        formData.append("description", description);
        formData.append("location", location || "Online");
        formData.append("format", format);
        if (meetingUrl) formData.append("meetingUrl", meetingUrl);
        formData.append("meetingPlatform", meetingPlatform);
        formData.append("type", type);

        const slotsVal = document.getElementById("slots")?.value?.trim();
        if (slotsVal) {
            const parsedSlots = parseInt(slotsVal, 10);
            if (!isNaN(parsedSlots) && parsedSlots > 0) {
                formData.append("slots", String(parsedSlots));
            }
        } else if (isEdit) {
            formData.append("slots", "");
        }

        if (isNonPartnerMode && user?.role === 'admin') {
            if (!registrationLink) {
                setStatus(t("host.err_req_reg_link"), true, statusMsg);
                return;
            }
            if (!nonPartnerHostName) {
                setStatus(t("host.err_req_host_name"), true, statusMsg);
                return;
            }
            formData.append("isNonPartner", "true");
            formData.append("registrationLink", registrationLink);
            formData.append("hostName", nonPartnerHostName);
        } else {
            formData.append("isNonPartner", "false");
            if (hostName) formData.append("hostName", hostName);
            if (orgIdVal) formData.append("organization", orgIdVal);
        }

        // Combine date + hour + minute into timezone-aware ISO string.
        const heldDateISO = heldDate
            ? `${heldDate}T${heldHour}:${heldMinute}:00+07:00`
            : heldDate;
        formData.append("heldDate", heldDateISO);

        const heldDateEndVal = document.getElementById("heldDateEnd")?.value;
        const endHour = document.getElementById("endHour")?.value || "23";
        const endMinute = document.getElementById("endMinute")?.value || "59";
        if (heldDateEndVal) {
            const heldDateEndISO = `${heldDateEndVal}T${endHour}:${endMinute}:00+07:00`;
            formData.append("heldDateEnd", heldDateEndISO);
        }

        const deadlineVal = document.getElementById("applicationDeadline")?.value;
        const deadlineHour = document.getElementById("deadlineHour")?.value || "23";
        const deadlineMinute = document.getElementById("deadlineMinute")?.value || "59";
        if (deadlineVal) {
            const deadlineISO = `${deadlineVal}T${deadlineHour}:${deadlineMinute}:00+07:00`;
            formData.append("applicationDeadline", deadlineISO);
        }

        const categories = await ensureCategories();
        const matched = findCategoryByType(type);
        if (matched) formData.append("category", matched._id);
        const hasCertificate = document.getElementById("hasCertificate")?.checked;
        formData.append("hasCertificate", hasCertificate ? "true" : "false");
        const certBgFile = document.getElementById("certificateBackgroundFile")?.files?.[0];
        if (certBgFile) {
            formData.append("certificateBackground", certBgFile);
        }
        const hasAttendance = document.getElementById("hasAttendance")?.checked;
        formData.append("hasAttendance", hasAttendance ? "true" : "false");
        const enableCheckinRules = document.getElementById("enableCheckinRules")?.checked;
        if (enableCheckinRules) {
            const lateMin = parseInt(document.getElementById("lateCheckinMinutes")?.value, 10) || 0;
            const expiredMin = parseInt(document.getElementById("expiredCheckinMinutes")?.value, 10) || 0;
            const allowEarlyCheckin = document.getElementById("allowEarlyCheckin")?.checked ?? false;
            formData.append("lateCheckinMinutes", String(lateMin));
            formData.append("expiredCheckinMinutes", String(expiredMin));
            formData.append("allowEarlyCheckin", allowEarlyCheckin ? "true" : "false");
        } else {
            formData.append("lateCheckinMinutes", "0");
            formData.append("expiredCheckinMinutes", "0");
            formData.append("allowEarlyCheckin", "true");
        }
        const hasMultiBooth = document.getElementById("hasMultiBooth")?.checked;
        formData.append("hasMultiBooth", hasMultiBooth ? "true" : "false");
        if (hasMultiBooth) {
            const multiBoothConfig = {
                boothTypeLabel: document.getElementById("boothTypeLabel")?.value || "booth",
                minBoothsRequired: parseInt(document.getElementById("minBoothsRequired")?.value, 10) || 0,
                requirePhoto: document.getElementById("requireBoothPhoto")?.checked ?? true
            };
            formData.append("multiBoothConfig", JSON.stringify(multiBoothConfig));

            // Collect initial booths
            const boothRows = Array.from(document.querySelectorAll("#initial-booths-list .initial-booth-row"));
            const initialBooths = boothRows.map(r => ({
                _id: r.querySelector(".booth-id-field")?.value || undefined,
                name: r.querySelector(".booth-name-field")?.value?.trim() || '',
                location: r.querySelector(".booth-loc-field")?.value?.trim() || '',
                boothCode: r.querySelector(".booth-code-field")?.value?.trim().toUpperCase() || ''
            })).filter(b => b.name);
            if (initialBooths.length > 0) {
                formData.append("initialBooths", JSON.stringify(initialBooths));
            }
        }
        const lat = document.getElementById("locationLat")?.value;
        const lng = document.getElementById("locationLng")?.value;
        if (lat) formData.append("locationLat", lat);
        if (lng) formData.append("locationLng", lng);
        if (thumbnailFile) formData.append("thumbnail", thumbnailFile);
        if (attachmentFiles && attachmentFiles.length > 0) {
            for (const file of attachmentFiles) formData.append("attachments", file);
        }
        const linkData = window.__attachmentLinks;
        if (linkData && linkData.length > 0) {
            formData.append("attachmentLinks", JSON.stringify(linkData));
        }

        if (!isEdit && typeof turnstile !== "undefined" && turnstileWidgetId !== null) {
            if (!turnstileToken) {
                turnstile.reset(turnstileWidgetId);
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!turnstileToken) {
                turnstileToken = turnstile.getResponse(turnstileWidgetId);
            }
            formData.append("cfTurnstileResponse", turnstileToken || "");
        }

        const actionLabel = isEdit ? 'Updating' : 'Creating';
        setStatus(`${actionLabel} activity...`, false, statusMsg);

        markActionPerformed(isEdit ? 'updateEvent' : 'createEvent');

        try {
            const result = isEdit
              ? await updateActivity(editEventId, formData)
              : await createActivity(formData);
            sessionStorage.removeItem(EDIT_EVENT_ID_KEY);
            setStatus(isEdit ? "Activity updated successfully!" : "Activity created successfully!", false, statusMsg);
            if (onSuccess) {
                setTimeout(() => onSuccess(result), 1200);
            } else {
                setTimeout(() => {
                    window.location.href = isEdit ? `./org-dashboard.html` : "./index.html";
                }, 1500);
            }
        } catch (err) {
            resetCooldown(isEdit ? 'updateEvent' : 'createEvent');
            if (!isEdit && typeof turnstile !== "undefined" && turnstileWidgetId !== null) {
                turnstile.reset(turnstileWidgetId);
            }
            if (!isEdit) turnstileToken = null;
            setStatus(err.message || `Failed to ${isEdit ? 'update' : 'create'} activity.`, true, statusMsg);
        }
    });
}

let turnstileToken = null;

export function initTurnstile() {
    const container = document.getElementById("turnstile-container");
    if (!container) return;
    if (typeof turnstile === "undefined") {
        setTimeout(initTurnstile, 300);
        return;
    }
    if (turnstileWidgetId !== null) {
        turnstile.remove(turnstileWidgetId);
    }
    turnstileToken = null;
    turnstileWidgetId = turnstile.render(container, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token) => {
            turnstileToken = token;
        },
        'expired-callback': () => {
            turnstileToken = null;
        },
        'error-callback': () => {
            turnstileToken = null;
        },
    });
}

export function setAttachmentLinks(newLinks) {
    window.__attachmentLinks = Array.isArray(newLinks) ? [...newLinks] : [];
    if (typeof window.__renderAttachmentLinks === 'function') {
        window.__renderAttachmentLinks();
    }
}

export function initAttachmentLinks() {
    const btn = document.getElementById("addAttachmentLinkBtn");
    const container = document.getElementById("attachmentLinksContainer");
    const list = document.getElementById("attachmentLinksList");
    if (!btn || !container || !list) return;
    let links = Array.isArray(window.__attachmentLinks) ? window.__attachmentLinks : [];
    window.__attachmentLinks = links;

    function render() {
        links = Array.isArray(window.__attachmentLinks) ? window.__attachmentLinks : [];
        list.innerHTML = links.map((link, i) =>
            `<span class="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[#ecedfa] text-[#191b22] text-sm">
                <span class="material-symbols-outlined text-[14px]">link</span>
                ${link.url}
                <button type="button" class="text-red-500 hover:text-red-700 ml-1" data-idx="${i}">&times;</button>
            </span>`
        ).join("");
        list.querySelectorAll("button[data-idx]").forEach(b => {
            b.addEventListener("click", () => {
                const idx = parseInt(b.dataset.idx);
                links.splice(idx, 1);
                window.__attachmentLinks = links;
                render();
            });
        });
    }
    window.__renderAttachmentLinks = render;
    render();

    btn.addEventListener("click", () => {
        const row = document.createElement("div");
        row.className = "flex items-center gap-3 p-3 rounded-xl bg-white border border-[#ecedfa]";
        row.innerHTML = `
            <input type="url" placeholder="https://..." class="flex-grow h-10 px-3 rounded-lg border border-[#ecedfa] bg-[#f8f9fc] text-sm"/>
            <input type="text" placeholder="Description (optional)" class="w-36 h-10 px-3 rounded-lg border border-[#ecedfa] bg-[#f8f9fc] text-sm"/>
            <button type="button" class="px-3 py-1.5 rounded-lg bg-[#1755ba] text-white text-sm font-medium hover:bg-[#1755ba]/90">Add</button>
            <button type="button" class="w-8 h-8 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 flex items-center justify-center">
                <span class="material-symbols-outlined text-[16px]">close</span>
            </button>
        `;
        const closeBtn = row.querySelector("button:last-child");
        closeBtn.addEventListener("click", () => row.remove());
        const addBtn = row.querySelector("button:first-of-type");
        addBtn.addEventListener("click", () => {
            const url = row.querySelector("input[type='url']").value.trim();
            const desc = row.querySelector("input[type='text']").value.trim();
            if (!url) { alert("Enter a URL"); return; }
            links.push({ url, description: desc });
            window.__attachmentLinks = links;
            render();
            row.remove();
            if (container.children.length === 0) container.classList.add("hidden");
        });
        container.classList.remove("hidden");
        container.appendChild(row);
        row.querySelector("input[type='url']").focus();
    });
}

export async function initOrgSelector(urlOrgId) {
    const container = document.getElementById("org-selector-content");
    const hint = document.getElementById("org-field-hint");
    if (!container) return;

    const user = getUser();
    let orgs = [];
    try {
        const data = await getMyOrganizations();
        orgs = data.organizations || [];
    } catch {}

    let matchedOrg = urlOrgId ? orgs.find(o => o._id === urlOrgId) : null;

    if (user?.role === 'admin') {
        if (urlOrgId && !matchedOrg) {
            try {
                const orgData = await getOrganizationById(urlOrgId);
                if (orgData && orgData.organization) {
                    matchedOrg = orgData.organization;
                }
            } catch (err) {
                console.error("Failed to fetch impersonated organization:", err);
            }
        }
        if (matchedOrg) {
            container.innerHTML = `
                <input type="text" class="input" id="org-name-display" value="${matchedOrg.name}" readonly/>
                <input type="hidden" id="org-id-value" value="${matchedOrg._id}"/>`;
            hint.textContent = `Hosting as ${matchedOrg.name}`;
        }
        return;
    }

    if (orgs.length === 1) {
        const org = matchedOrg || orgs[0];
        container.innerHTML = `
            <input type="text" class="input" id="org-name-display" value="${org.name}" readonly/>
            <input type="hidden" id="org-id-value" value="${org._id}"/>`;
        hint.textContent = `Hosting as ${org.name}`;
        return;
    }

    if (orgs.length > 1) {
        const options = orgs.map(o =>
            `<option value="${o._id}" ${matchedOrg?._id === o._id ? "selected" : ""}>${o.name}</option>`
        ).join("");
        container.innerHTML = `
            <select id="org-id-value" class="input cursor-pointer hover:border-primary hover:bg-[#f8faff] transition-all shadow-2xs">
                <option value="">${t("host.select_org")}</option>
                ${options}
            </select>
            <input type="hidden" id="org-name-display" value=""/>`;
        const sel = document.getElementById("org-id-value");
        sel.addEventListener("change", () => {
            const selected = orgs.find(o => o._id === sel.value);
            hint.textContent = selected ? t("host.hosting_as", { name: selected.name }) : '';
        });
        if (matchedOrg) {
            sel.value = matchedOrg._id;
            document.getElementById("org-name-display").value = matchedOrg.name;
            hint.textContent = t("host.hosting_as", { name: matchedOrg.name });
        }
        return;
    }

    if (urlOrgId) {
        container.innerHTML = `
            <input type="text" class="input" id="org-name-display" value="Organization" readonly/>
            <input type="hidden" id="org-id-value" value="${urlOrgId}"/>`;
        hint.textContent = t("host.event_linked_to_org");
    }
}

function setStatus(msg, isError, el) {
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("error-msg", "success-msg");
    el.classList.add(isError ? "error-msg" : "success-msg");
}
