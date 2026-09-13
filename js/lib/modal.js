/**
 * Accessible Modal Controller for SpringWave
 * Handles focus trapping, Escape key listener, scroll locking, and focus restoration.
 */

import { t } from "./i18n.js";

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function setupModal({
  modal,
  backdrop,
  closeButtons = [],
  onClose,
  onOpen,
}) {
  if (!modal) return null;

  let lastActiveElement = null;
  let keydownHandler = null;

  const getFocusableElements = () => {
    return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTORS)).filter(
      (el) => el.offsetParent !== null
    );
  };

  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }

    if (e.key === 'Tab') {
      const focusables = getFocusableElements();
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  };

  const open = () => {
    lastActiveElement = document.activeElement;

    // Prevent body scrolling
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.removeAttribute('hidden');
    modal.classList.add('active');

    if (backdrop) {
      backdrop.removeAttribute('hidden');
      backdrop.classList.add('active');
    }

    keydownHandler = handleKeydown;
    document.addEventListener('keydown', keydownHandler);

    // Focus first focusable element
    requestAnimationFrame(() => {
      const focusables = getFocusableElements();
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        modal.focus();
      }
      if (onOpen) onOpen();
    });
  };

  const close = () => {
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }

    modal.classList.remove('active');
    if (backdrop) {
      backdrop.classList.remove('active');
    }

    setTimeout(() => {
      modal.setAttribute('hidden', '');
      if (backdrop) backdrop.setAttribute('hidden', '');
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';

      if (lastActiveElement && typeof lastActiveElement.focus === 'function') {
        lastActiveElement.focus();
      }
      if (onClose) onClose();
    }, 200);
  };

  if (backdrop) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
  }

  closeButtons.forEach((btn) => {
    if (btn) btn.addEventListener('click', close);
  });

  return { open, close };
}

let activeDialogOverlay = null;
let activeDialogResolver = null;
let activeDialogKeydown = null;
let activeDialogParams = {};

export function showConfirmDialog(options = {}) {
  return new Promise((resolve) => {
    closeActiveDialog(false);

    const {
      title = "",
      titleKey = "common.confirm_title",
      defaultTitle = "",
      message = "",
      messageKey = "",
      defaultMessage = "",
      confirmText = "",
      confirmTextKey = "common.confirm_btn",
      cancelText = "",
      cancelTextKey = "common.cancel_btn",
      type = "primary", // 'danger' | 'warning' | 'primary' | 'success'
      params = {},
    } = options;

    activeDialogParams = params || {};

    const overlay = document.createElement("div");
    overlay.id = "global-dialog-overlay";
    overlay.className = "fixed inset-0 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm z-[999999] transition-opacity duration-200 opacity-0 pointer-events-auto";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const iconMap = {
      danger: { icon: "delete", color: "text-rose-600", bg: "bg-rose-50", border: "border-rose-200/90", btn: "bg-rose-600 hover:bg-rose-700 text-white" },
      warning: { icon: "warning", color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-200/90", btn: "bg-amber-600 hover:bg-amber-700 text-white" },
      primary: { icon: "help", color: "text-[#1755ba]", bg: "bg-blue-50", border: "border-blue-200/90", btn: "bg-[#1755ba] hover:bg-[#134699] text-white" },
      success: { icon: "check_circle", color: "text-emerald-600", bg: "bg-emerald-50", border: "border-emerald-200/90", btn: "bg-emerald-600 hover:bg-emerald-700 text-white" },
    };
    const style = iconMap[type] || iconMap.primary;

    const fallbackTitle = defaultTitle || t("common.confirm_title", "Confirmation");
    const displayTitle = title || (titleKey ? t(titleKey, params, fallbackTitle) : fallbackTitle);
    const displayMsg = message || (messageKey ? t(messageKey, params, defaultMessage) : (defaultMessage || ""));
    const displayConfirm = confirmText || (confirmTextKey ? t(confirmTextKey, "Confirm") : t("common.confirm_btn", "Confirm"));
    const displayCancel = cancelText || (cancelTextKey ? t(cancelTextKey, "Cancel") : t("common.cancel_btn", "Cancel"));

    overlay.innerHTML = `
      <div class="dialog-card bg-white/95 backdrop-blur-xl border border-slate-200/90 rounded-3xl shadow-2xl p-6 sm:p-7 max-w-md w-full text-center relative overflow-hidden transform scale-95 transition-transform duration-200">
        <div class="w-14 h-14 rounded-2xl ${style.bg} ${style.border} ${style.color} border flex items-center justify-center mx-auto mb-4 shadow-xs">
          <span class="material-symbols-outlined text-3xl">${style.icon}</span>
        </div>
        <h3 class="dialog-title text-lg sm:text-xl font-bold text-slate-900 mb-2 leading-tight tracking-tight" data-dialog-title-key="${titleKey}" data-dialog-default-title="${defaultTitle || ''}">
          ${displayTitle}
        </h3>
        <p class="dialog-message text-xs sm:text-sm text-slate-600 leading-relaxed mb-6" data-dialog-msg-key="${messageKey}" data-dialog-default-msg="${defaultMessage || ''}">
          ${displayMsg}
        </p>
        <div class="flex items-center justify-center gap-3">
          <button type="button" class="dialog-cancel-btn flex-1 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 transition-colors cursor-pointer" data-dialog-cancel-key="${cancelTextKey}">
            ${displayCancel}
          </button>
          <button type="button" class="dialog-confirm-btn flex-1 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-bold shadow-sm transition-all duration-150 cursor-pointer ${style.btn}" data-dialog-confirm-key="${confirmTextKey}">
            ${displayConfirm}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    activeDialogOverlay = overlay;
    activeDialogResolver = resolve;

    requestAnimationFrame(() => {
      overlay.classList.remove("opacity-0");
      overlay.querySelector(".dialog-card")?.classList.remove("scale-95");
      overlay.querySelector(".dialog-card")?.classList.add("scale-100");
    });

    const finish = (result) => {
      closeActiveDialog(result);
    };

    overlay.querySelector(".dialog-confirm-btn")?.addEventListener("click", () => finish(true));
    overlay.querySelector(".dialog-cancel-btn")?.addEventListener("click", () => finish(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });

    activeDialogKeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    document.addEventListener("keydown", activeDialogKeydown);
  });
}

export function showAlertDialog(options = {}) {
  return new Promise((resolve) => {
    closeActiveDialog(true);

    const {
      title = "",
      titleKey = "",
      defaultTitle = "",
      message = "",
      messageKey = "",
      defaultMessage = "",
      okText = "",
      okTextKey = "common.ok_btn",
      type = "info",
      params = {},
    } = typeof options === "string" ? { message: options } : options;

    activeDialogParams = params || {};

    const overlay = document.createElement("div");
    overlay.id = "global-dialog-overlay";
    overlay.className = "fixed inset-0 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm z-[999999] transition-opacity duration-200 opacity-0 pointer-events-auto";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const iconMap = {
      error: { icon: "error", color: "text-rose-600", bg: "bg-rose-50", border: "border-rose-200/90", btn: "bg-rose-600 hover:bg-rose-700 text-white" },
      warning: { icon: "warning", color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-200/90", btn: "bg-amber-600 hover:bg-amber-700 text-white" },
      info: { icon: "info", color: "text-[#1755ba]", bg: "bg-blue-50", border: "border-blue-200/90", btn: "bg-[#1755ba] hover:bg-[#134699] text-white" },
      success: { icon: "check_circle", color: "text-emerald-600", bg: "bg-emerald-50", border: "border-emerald-200/90", btn: "bg-emerald-600 hover:bg-emerald-700 text-white" },
    };
    const style = iconMap[type] || iconMap.info;

    const fallbackTitle = defaultTitle || (type === 'error' ? t('common.error', 'Error') : t('common.notice', 'Notice'));
    const displayTitle = title || (titleKey ? t(titleKey, params, fallbackTitle) : fallbackTitle);
    const displayMsg = message || (messageKey ? t(messageKey, params, defaultMessage) : (defaultMessage || ""));
    const displayOk = okText || (okTextKey ? t(okTextKey, "OK") : t("common.ok_btn", "OK"));

    overlay.innerHTML = `
      <div class="dialog-card bg-white/95 backdrop-blur-xl border border-slate-200/90 rounded-3xl shadow-2xl p-6 sm:p-7 max-w-md w-full text-center relative overflow-hidden transform scale-95 transition-transform duration-200">
        <div class="w-14 h-14 rounded-2xl ${style.bg} ${style.border} ${style.color} border flex items-center justify-center mx-auto mb-4 shadow-xs">
          <span class="material-symbols-outlined text-3xl">${style.icon}</span>
        </div>
        <h3 class="dialog-title text-lg sm:text-xl font-bold text-slate-900 mb-2 leading-tight tracking-tight" data-dialog-title-key="${titleKey}" data-dialog-default-title="${defaultTitle || ''}">
          ${displayTitle}
        </h3>
        <p class="dialog-message text-xs sm:text-sm text-slate-600 leading-relaxed mb-6" data-dialog-msg-key="${messageKey}" data-dialog-default-msg="${defaultMessage || ''}">
          ${displayMsg}
        </p>
        <div class="flex items-center justify-center">
          <button type="button" class="dialog-ok-btn min-w-[120px] py-2.5 px-6 rounded-xl text-xs sm:text-sm font-bold shadow-sm transition-all duration-150 cursor-pointer ${style.btn}" data-dialog-ok-key="${okTextKey}">
            ${displayOk}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    activeDialogOverlay = overlay;
    activeDialogResolver = resolve;

    requestAnimationFrame(() => {
      overlay.classList.remove("opacity-0");
      overlay.querySelector(".dialog-card")?.classList.remove("scale-95");
      overlay.querySelector(".dialog-card")?.classList.add("scale-100");
    });

    const finish = () => {
      closeActiveDialog(true);
    };

    overlay.querySelector(".dialog-ok-btn")?.addEventListener("click", finish);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish();
    });

    activeDialogKeydown = (e) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        finish();
      }
    };
    document.addEventListener("keydown", activeDialogKeydown);
  });
}

function closeActiveDialog(result) {
  if (activeDialogKeydown) {
    document.removeEventListener("keydown", activeDialogKeydown);
    activeDialogKeydown = null;
  }
  if (activeDialogOverlay) {
    const ov = activeDialogOverlay;
    ov.classList.add("opacity-0");
    ov.querySelector(".dialog-card")?.classList.add("scale-95");
    setTimeout(() => {
      ov.remove();
    }, 200);
    activeDialogOverlay = null;
  }
  if (activeDialogResolver) {
    activeDialogResolver(result);
    activeDialogResolver = null;
  }
  activeDialogParams = {};
}

// Reactive language change listener for active dialogs
if (typeof window !== "undefined") {
  window.addEventListener("language-changed", () => {
    if (!activeDialogOverlay) return;
    const titleEl = activeDialogOverlay.querySelector(".dialog-title");
    const msgEl = activeDialogOverlay.querySelector(".dialog-message");
    const confirmBtn = activeDialogOverlay.querySelector(".dialog-confirm-btn");
    const cancelBtn = activeDialogOverlay.querySelector(".dialog-cancel-btn");
    const okBtn = activeDialogOverlay.querySelector(".dialog-ok-btn");

    if (titleEl?.dataset.dialogTitleKey) titleEl.textContent = t(titleEl.dataset.dialogTitleKey, activeDialogParams, titleEl.dataset.dialogDefaultTitle || titleEl.textContent);
    if (msgEl?.dataset.dialogMsgKey) msgEl.textContent = t(msgEl.dataset.dialogMsgKey, activeDialogParams, msgEl.dataset.dialogDefaultMsg || msgEl.textContent);
    if (confirmBtn?.dataset.dialogConfirmKey) confirmBtn.textContent = t(confirmBtn.dataset.dialogConfirmKey, confirmBtn.textContent);
    if (cancelBtn?.dataset.dialogCancelKey) cancelBtn.textContent = t(cancelBtn.dataset.dialogCancelKey, cancelBtn.textContent);
    if (okBtn?.dataset.dialogOkKey) okBtn.textContent = t(okBtn.dataset.dialogOkKey, okBtn.textContent);
  });

  window.showConfirmDialog = showConfirmDialog;
  window.showAlertDialog = showAlertDialog;
}

