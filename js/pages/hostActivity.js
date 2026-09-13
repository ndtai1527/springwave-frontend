import "../../src/style.css";
import { isAuthenticated, getUser} from "../lib/session.js";
import { getFavourites } from "../api/user.js";
import { initChatbot } from "../components/chatbot.js";
import { fetchContent } from "../lib/utils.js";
import { loadNavbar as loadSharedNavbar, initBasicScroll } from "../components/navbar.js";
import { applyTranslation } from "../lib/i18n.js";
import { 
    initThumbnailPreview, 
    initFileUpload, 
    initMapPicker, 
    initDateValidation, 
    initFormSubmit, 
    initAttachmentLinks, 
    initOrgSelector, 
    initTurnstile, 
    initCheckinRulesToggle, 
    initMultiBoothToggle,
    initCertificateOptionsToggle, 
    initTimePicker, 
    initEventModeSelector, 
    initEditMode,
    applyEditModeHeading
} from "../lib/hostForm.js";

/* =========================
   PAGE LOAD
========================= */

document.addEventListener(
    "DOMContentLoaded",
    async () => {

        if (!isAuthenticated()) {
            window.location.href = "/login.html";
            return;
        }

        const user = getUser();
        if (user?.role !== 'admin' && user?.role !== 'host') {
            window.location.href = "./index.html";
            return;
        }

        await loadNavbar();

        await loadComponent(
            "host-activity-details-container",
            "./components/hostActivityDetails.html"
        );
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get("edit")) {
            applyEditModeHeading();
        }
        applyTranslation();

        window.addEventListener("language-changed", () => {
            applyTranslation();
        });

        await loadFooter();
        await initChatbot();

        await initializeHostActivityPage();
    }
);

/* =========================
   LOAD COMPONENT
========================= */

async function loadComponent(id, file) {

    try {

        const html =
            await fetchContent(file);

        document.getElementById(id).innerHTML =
            html;

    }
    catch (err) {

        console.error(
            "Failed to load component:",
            err
        );
    }
}

/* =========================
   LOAD NAVBAR
========================= */

async function loadNavbar() {
    await loadSharedNavbar({ onFavouritesClick: showFavPopup });
    initBasicScroll();
}

/* =========================
   LOAD FOOTER
========================= */

async function loadFooter() {

    const footerHTML =
        await fetchContent(
            "./components/footer.html"
        );

    document.getElementById(
        "footer-container"
    ).innerHTML =
        footerHTML;
}

/* =========================
   HOST ACTIVITY PAGE
========================= */

async function initializeHostActivityPage() {
    const params = new URLSearchParams(window.location.search);
    const orgId = params.get("org");
    const editId = params.get("edit");
    const user = getUser();
    if (!orgId && !editId && user?.role === 'host') {
        window.location.href = "/org-dashboard.html";
        return;
    }

    initThumbnailPreview();
    initFileUpload();
    initAttachmentLinks();
    initTimePicker();
    initDateValidation();
    initEventModeSelector();
    initCheckinRulesToggle();
    initMultiBoothToggle();
    initCertificateOptionsToggle();
    await initOrgSelector(orgId);
    initMapPicker();
    initFormSubmit(orgId, () => {
        if (editId) {
            window.location.href = user?.role === 'admin' ? './admin.html' : (orgId ? './org-dashboard.html' : './index.html');
        } else {
            window.location.href = orgId ? `./org-dashboard.html` : `./index.html`;
        }
    });

    if (editId) {
        await initEditMode(editId);
    } else {
        initTurnstile();
    }
}

/* =========================
   FAVOURITES POPUP
========================= */

const popupOverlay = document.getElementById("popup-overlay");
const popupContainer = document.getElementById("popup-container");

async function showFavPopup() {
    try {
        const { activities } = await getFavourites();
        const items = (activities || []).map(a => {
            const held = a.heldDate ? new Date(a.heldDate).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
            return `<div class="fav-item" data-id="${a.activityID}">
                <div class="fav-thumb">${a.thumbnail ? `<img src="${a.thumbnail}" alt="${a.title}">` : '<div class="fav-thumb-placeholder"><i class="fa-regular fa-image"></i></div>'}</div>
                <div class="fav-body"><div class="fav-title">${a.title}</div><div class="fav-location"><i class="fa-solid fa-location-dot"></i> ${a.location}</div><div class="fav-date">${held}</div></div>
            </div>`;
        }).join("");

        popupContainer.innerHTML = `
            <div class="container">
                <div class="top-bar">
                    <button class="back-btn" id="back-btn"><i class="fa-solid fa-arrow-left"></i> Back</button>
                    <h2 class="fav-popup-title">Favourite Activities</h2>
                </div>
                <div class="fav-list">${items || '<p class="fav-empty">No favourites yet.</p>'}</div>
            </div>`;

        popupOverlay.removeAttribute("hidden");
        popupOverlay.classList.add("active");
        document.getElementById("back-btn").addEventListener("click", () => {
            popupOverlay.classList.remove("active");
            popupContainer.innerHTML = "";
            popupOverlay.setAttribute("hidden", "");
        });
        popupOverlay.addEventListener("click", (e) => {
            if (e.target === popupOverlay) { popupOverlay.classList.remove("active"); popupContainer.innerHTML = ""; popupOverlay.setAttribute("hidden", ""); }
        });

        popupContainer.querySelectorAll(".fav-item").forEach(el => {
            el.addEventListener("click", () => {
                popupOverlay.classList.remove("active");
                popupContainer.innerHTML = "";
                popupOverlay.setAttribute("hidden", "");
                window.location.href = `./index.html`;
            });
        });
    } catch {}
}