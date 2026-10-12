/**
 * AttendPro — Smart Attendance Tracker
 * Production-quality JavaScript
 *
 * Architecture:
 *   1.  Configuration & Constants
 *   2.  Supabase Client
 *   3.  Application State
 *   4.  DOM Reference Cache
 *   5.  Initialization
 *   6.  Authentication
 *   7.  Theme
 *   8.  Navigation
 *   9.  Data Layer (Supabase CRUD)
 *  10.  Centralized Attendance Calculation Engine
 *  11.  Dashboard Renderer
 *  12.  Calendar Renderer
 *  13.  Statistics Renderer
 *  14.  Status Modal
 *  15.  Confirm Delete Modal
 *  16.  Toast Notification System
 *  17.  Utility Helpers
 */

'use strict';

// ============================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================

/**
 * Attendance Policy — confirmed with school teacher:
 *
 *   PRESENT  + FULL   → 1.0 working day, 1.0 actual, 1.0 official
 *   PRESENT  + HALF   → 0.5 working day, 0.5 actual, 0.5 official
 *   ABSENT   + FULL   → 1.0 working day, 0.0 actual, 0.0 official
 *   ABSENT   + HALF   → 0.5 working day, 0.0 actual, 0.0 official
 *   MEDICAL  + FULL   → 1.0 working day, 0.0 actual, 1.0 official (school credits as present)
 *   MEDICAL  + HALF   → 0.5 working day, 0.0 actual, 0.5 official
 *   HOLIDAY  (any)    → excluded entirely from working days
 *
 *   Sundays / 2nd Saturdays → excluded (derived from date, never stored)
 *
 * Two percentages:
 *   Official % = officialAttendedValue / totalWorkingDays × 100
 *   Actual   % = actualAttendedValue   / totalWorkingDays × 100
 *
 * The school's 75% requirement uses OFFICIAL ATTENDANCE.
 */
const POLICY = {
  ATTENDANCE_TARGET:               0.75,  // 75% minimum target
  MEDICAL_LEAVE_COUNTS_AS_PRESENT: true,  // credited as present in official %
};

/**
 * Valid status values stored in Supabase.
 * NOTE: 'half_day' is a LEGACY value from a previous implementation.
 *       Use normalizeRecord() before any calculation or display to convert it.
 */
const STATUS = {
  PRESENT: 'present',
  ABSENT:  'absent',
  HOLIDAY: 'holiday',
  MEDICAL: 'medical',
  // Legacy — no longer written, only read for backward compatibility
  HALF_DAY_LEGACY: 'half_day',
};

/** Duration values — stored in the `duration` column. */
const DURATION = {
  FULL: 'full',
  HALF: 'half',
};

const STATUS_LABELS = {
  present: 'Present',
  absent:  'Absent',
  holiday: 'Holiday',
  medical: 'Medical Leave',
};

const STATUS_EMOJI = {
  present: '✅',
  absent:  '❌',
  holiday: '🏖️',
  medical: '🏥',
};

const DURATION_LABELS = {
  full: 'Full Day',
  half: 'Half Day',
};

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const MONTH_SHORT = [
  'Jan','Feb','Mar','Apr','May','Jun',
  'Jul','Aug','Sep','Oct','Nov','Dec',
];

// ============================================================
// BACKWARD-COMPATIBILITY HELPER
// ============================================================

/**
 * normalizeRecord(r)
 *
 * Converts any attendance record into the canonical { status, duration } shape.
 * Handles the legacy 'half_day' status written by the previous implementation:
 *   half_day → { status: 'present', duration: 'half' }
 *
 * All calculation and display code must call this first, never read r.status raw.
 *
 * @param  {Object} r  Raw record from Supabase or state.attendanceData
 * @returns {{ status: string, duration: string, date: string, id: any, ... }}
 */
function normalizeRecord(r) {
  if (r.status === STATUS.HALF_DAY_LEGACY) {
    return { ...r, status: STATUS.PRESENT, duration: DURATION.HALF };
  }
  // Records written by the new code always have a duration column.
  // Old records written before the duration column existed default to 'full'.
  return { ...r, duration: r.duration || DURATION.FULL };
}

// ============================================================
// 2. SUPABASE CLIENT
// ============================================================

const SUPABASE_URL = 'https://rounltiateeimeersgzc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_6833UTzjlxNrNuz0hCYgcA_Zxaj-bKR';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// 3. APPLICATION STATE
// ============================================================

const state = {
  currentUser:    null,
  attendanceData: [],      // [{ id, user_id, date, status, created_at }]
  currentMonth:   new Date(),
  chartInstance:  null,
  isSaving:       false,   // prevents duplicate save requests
  pendingDelete:  null,    // dateStr waiting for confirmation
  chartMode:      'official', // 'official' | 'actual' — which % the chart displays
};

// ============================================================
// NON-WORKING DAY HELPERS
// ============================================================

/**
 * Returns true if the given Date object falls on a Sunday (day === 0).
 * @param {Date} date
 */
function isSunday(date) {
  return date.getDay() === 0;
}

/**
 * Returns true if the given Date object is the SECOND Saturday of its month.
 * Works correctly for every month and year — no hardcoding.
 * @param {Date} date
 */
function isSecondSaturday(date) {
  if (date.getDay() !== 6) return false;        // Not a Saturday at all
  // Count how many Saturdays have occurred in this month up to (and including) this date
  const d = date.getDate();
  // The first Saturday of the month falls on day (1 + ((6 - firstDow + 7) % 7))
  // But a simpler approach: the n-th Saturday is the one where
  // Math.ceil(d / 7) === 2  when we count only Saturdays.
  // Since all Saturdays are 7 days apart, the second Saturday has date in [8..14].
  return d >= 8 && d <= 14;
}

/**
 * Returns true if dateStr (YYYY-MM-DD) is a non-working day
 * (Sunday or second Saturday). These are determined purely from
 * the calendar — NO Supabase record is created for them.
 * @param {string} dateStr  e.g. "2026-09-20"
 */
function isNonWorkingDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d); // local date — no UTC shift
  return isSunday(date) || isSecondSaturday(date);
}

/**
 * Returns a label string for a non-working day, or null if it is a working day.
 * @param {string} dateStr
 */
function getNonWorkingLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (isSunday(date))        return 'Sunday';
  if (isSecondSaturday(date)) return '2nd Sat';
  return null;
}

// ============================================================
// 4. DOM REFERENCE CACHE
// ============================================================
// All getElementById / querySelector calls live here so
// the rest of the code never touches the DOM directly for IDs.

const el = {};

function cacheDom() {
  // Views
  el.authView           = document.getElementById('auth-view');
  el.resetView          = document.getElementById('reset-password-view');
  el.updatePassView     = document.getElementById('update-password-view');
  el.appView            = document.getElementById('app-view');

  // Auth form
  el.authEmail          = document.getElementById('auth-email');
  el.authPassword       = document.getElementById('auth-password');
  el.authError          = document.getElementById('auth-error');
  el.loginBtn           = document.getElementById('login-btn');
  el.signupBtn          = document.getElementById('signup-btn');
  el.forgotBtn          = document.getElementById('forgot-password-btn');
  el.toggleAuthPw       = document.getElementById('toggle-auth-password');

  // Reset password form
  el.resetEmail         = document.getElementById('reset-email');
  el.resetError         = document.getElementById('reset-error');
  el.sendResetBtn       = document.getElementById('send-reset-btn');
  el.backToLoginBtn     = document.getElementById('back-to-login-btn');

  // Update password form
  el.newPassword        = document.getElementById('new-password');
  el.updateError        = document.getElementById('update-error');
  el.updatePasswordBtn  = document.getElementById('update-password-btn');
  el.toggleNewPw        = document.getElementById('toggle-new-password');

  // App navigation
  el.navItems           = document.querySelectorAll('.nav-item[data-target]');
  el.pageTitle          = document.getElementById('page-title');
  el.userGreeting       = document.getElementById('user-greeting');
  el.themeToggle        = document.getElementById('theme-toggle');
  el.logoutBtn          = document.getElementById('logout-btn');
  el.mobileToggle       = null;   // removed — no longer used
  el.sidebar            = document.getElementById('bottom-dock');
  el.sidebarOverlay     = null;   // removed — no longer used
  el.dockBubble         = document.getElementById('dock-bubble');

  // Flush any greeting set before the DOM was ready
  if (state._pendingGreeting && el.userGreeting) {
    el.userGreeting.textContent = state._pendingGreeting;
    state._pendingGreeting = null;
  }

  // Dashboard
  el.dashboardLoading   = document.getElementById('dashboard-loading');
  el.dashboardContent   = document.getElementById('dashboard-content');
  el.dashboardError     = document.getElementById('dashboard-error');
  el.retryDashboard     = document.getElementById('retry-dashboard');
  el.dashTotal          = document.getElementById('dash-totaldays');
  el.dashPresent        = document.getElementById('dash-present');
  el.dashHalfDays       = document.getElementById('dash-halfdays');
  el.dashAbsent         = document.getElementById('dash-absent');
  el.dashHolidays       = document.getElementById('dash-holidays');
  el.dashMedicals       = document.getElementById('dash-medicals');
  el.circularProgress   = document.getElementById('circular-progress');
  el.progressText       = document.getElementById('progress-text');
  el.progressRingAria   = document.getElementById('progress-ring-aria');
  el.attendanceBadge    = document.getElementById('attendance-badge');
  el.predictorContent   = document.getElementById('predictor-content');

  // Calendar
  el.calendarDays       = document.getElementById('calendar-days');
  el.calendarMonthYear  = document.getElementById('calendar-month-year');
  el.prevMonthBtn       = document.getElementById('prev-month');
  el.nextMonthBtn       = document.getElementById('next-month');

  // Statistics
  el.chartCanvas        = document.getElementById('attendanceChart');
  el.chartLoading       = document.getElementById('chart-loading');
  el.chartEmpty         = document.getElementById('chart-empty');
  el.monthCardsContainer = document.getElementById('month-cards-container');
  el.chartToggleBtns    = document.querySelectorAll('.chart-toggle-btn');
  el.chartModeLabel     = document.getElementById('chart-mode-label');

  // Status modal
  el.statusModal        = document.getElementById('status-modal');
  el.modalTitle         = document.getElementById('modal-title');
  el.modalDateText      = document.getElementById('modal-date-text');
  el.modalCurrentStatus = document.getElementById('modal-current-status');
  el.modalStatusValue   = document.getElementById('modal-status-value');
  el.closeModal         = document.getElementById('close-modal');
  el.statusBtns         = document.querySelectorAll('.status-btn');
  el.modalBackdrop      = document.getElementById('modal-backdrop');

  // Non-working day modal
  el.nonWorkingModal      = document.getElementById('non-working-modal');
  el.nonWorkingTitle      = document.getElementById('non-working-title');
  el.nonWorkingBody       = document.getElementById('non-working-body');
  el.nonWorkingCloseBtn   = document.getElementById('non-working-close-btn');
  el.nonWorkingBackdrop   = document.getElementById('non-working-backdrop');

  // Confirm modal
  el.confirmModal       = document.getElementById('confirm-modal');
  el.confirmTitle       = document.getElementById('confirm-title');
  el.confirmBody        = document.getElementById('confirm-body');
  el.confirmCancelBtn   = document.getElementById('confirm-cancel-btn');
  el.confirmDeleteBtn   = document.getElementById('confirm-delete-btn');
  el.confirmBackdrop    = document.getElementById('confirm-backdrop');

  // Toast container
  el.toastContainer     = document.getElementById('toast-container');

  // Sections map
  el.sections = {
    dashboard: document.getElementById('dashboard'),
    calendar:  document.getElementById('calendar'),
    stats:     document.getElementById('stats'),
  };
}

// ============================================================
// 5. INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  cacheDom();
  initTheme();
  setupEventListeners();
  checkSession();
});

// ============================================================
// 6. AUTHENTICATION
// ============================================================

async function checkSession() {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (session) {
      handleUserLogin(session.user);
    } else {
      showView('auth');
    }
  } catch {
    showView('auth');
  }
}

// Listen for Supabase auth state changes (handles email magic links, etc.)
// IMPORTANT: onAuthStateChange fires synchronously during createClient()
// initialisation — before DOMContentLoaded and before cacheDom() runs.
// We defer any DOM work until the DOM is ready.
db.auth.onAuthStateChange((event, session) => {
  // If cacheDom hasn't run yet, el.authView won't exist — defer safely.
  if (!el.authView) return;

  if (event === 'PASSWORD_RECOVERY') {
    showView('update-password');
  } else if (event === 'SIGNED_IN' && session) {
    // Only navigate to app if not already shown (prevents flicker on load)
    if (!state.currentUser) {
      handleUserLogin(session.user);
    }
  } else if (event === 'SIGNED_OUT') {
    handleUserLogout();
  }
});

function handleUserLogin(user) {
  state.currentUser = user;
  const emailName = user.email.split('@')[0];
  // el.userGreeting may be null if cacheDom() hasn't run yet
  // (onAuthStateChange can fire synchronously before DOMContentLoaded)
  if (el.userGreeting) {
    el.userGreeting.textContent = `Hello, ${emailName}`;
  } else {
    // Store for later — renderGreeting() picks it up after cacheDom()
    state._pendingGreeting = `Hello, ${emailName}`;
  }
  showView('app');
  fetchAttendanceData();
  // Show the dock and position bubble on initial load
  const dock = document.getElementById('bottom-dock');
  if (dock) dock.classList.remove('hidden');
  requestAnimationFrame(() => positionDockBubble('dashboard'));
}

function handleUserLogout() {
  state.currentUser = null;
  state.attendanceData = [];
  state.currentMonth = new Date();
  if (state.chartInstance) {
    state.chartInstance.destroy();
    state.chartInstance = null;
  }
  const dock = document.getElementById('bottom-dock');
  if (dock) dock.classList.add('hidden');
  showView('auth');
}

function showView(name) {
  el.authView.classList.toggle('hidden', name !== 'auth');
  el.resetView.classList.toggle('hidden', name !== 'reset-password');
  el.updatePassView.classList.toggle('hidden', name !== 'update-password');
  el.appView.classList.toggle('hidden', name !== 'app');
}

// ============================================================
// 7. THEME
// ============================================================

function initTheme() {
  const saved = localStorage.getItem('ap-theme') || 'light';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon  = el.themeToggle?.querySelector('i');
  if (icon) icon.className = theme === 'dark' ? 'ph ph-sun' : 'ph ph-moon';
  el.themeToggle?.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  localStorage.setItem('ap-theme', theme);

  // Re-draw chart with new theme colors if it exists
  if (state.chartInstance) {
    renderStatistics();
  }
}

// ============================================================
// 8. NAVIGATION
// ============================================================

function setupEventListeners() {

  // ----- Auth -----
  el.loginBtn.addEventListener('click', handleLogin);
  document.getElementById('auth-form').addEventListener('submit', handleLogin);

  el.signupBtn.addEventListener('click', handleSignup);

  el.forgotBtn.addEventListener('click', () => showView('reset-password'));
  el.backToLoginBtn.addEventListener('click', () => showView('auth'));

  el.sendResetBtn.addEventListener('click', handleSendReset);
  el.updatePasswordBtn.addEventListener('click', handleUpdatePassword);

  // Password visibility toggles
  el.toggleAuthPw.addEventListener('click', () => togglePasswordVisibility(el.authPassword, el.toggleAuthPw));
  el.toggleNewPw.addEventListener('click', () => togglePasswordVisibility(el.newPassword, el.toggleNewPw));

  // ----- Navigation -----
  el.navItems.forEach(item => {
    item.addEventListener('click', () => navigateTo(item.getAttribute('data-target')));
  });

  el.themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  el.logoutBtn.addEventListener('click', async () => {
    await db.auth.signOut();
  });

  // ----- Mobile sidebar -----
  // (No mobile sidebar in the new dock layout — these are no-ops kept for safety)

  // ----- Calendar nav -----
  el.prevMonthBtn.addEventListener('click', () => {
    state.currentMonth = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  el.nextMonthBtn.addEventListener('click', () => {
    state.currentMonth = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  // ----- Status modal -----
  el.closeModal.addEventListener('click', closeStatusModal);
  el.modalBackdrop.addEventListener('click', closeStatusModal);

  // Remove attendance button (shown when a record already exists)
  document.getElementById('remove-attendance-btn')?.addEventListener('click', () => {
    const dateStr = _activeModalDate;
    if (!dateStr) return;
    closeStatusModal();
    initiateDelete(dateStr);
  });

  // ----- Confirm modal -----
  el.confirmCancelBtn.addEventListener('click', closeConfirmModal);
  el.confirmBackdrop.addEventListener('click', closeConfirmModal);
  el.confirmDeleteBtn.addEventListener('click', handleConfirmDelete);

  // ----- Retry dashboard -----
  el.retryDashboard.addEventListener('click', fetchAttendanceData);

  // ----- Dashboard info panel toggle -----
  document.getElementById('dash-info-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('dash-info-panel');
    const btn   = document.getElementById('dash-info-btn');
    if (!panel || !btn) return;
    const isOpen = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', isOpen);
    btn.setAttribute('aria-expanded', String(!isOpen));
  });

  // ----- Chart view toggle (Official / Actual) -----
  // Use event delegation on the toggle group
  document.getElementById('chart-toggle-group')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-toggle-btn');
    if (!btn) return;
    const mode = btn.getAttribute('data-mode');
    if (mode === state.chartMode) return;
    state.chartMode = mode;
    // Update active state on buttons
    el.chartToggleBtns.forEach(b => {
      b.classList.toggle('chart-toggle-active', b.getAttribute('data-mode') === mode);
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
    if (el.chartModeLabel) {
      el.chartModeLabel.textContent = mode === 'official'
        ? 'Medical Leave counted as Present'
        : 'Excluding Medical Leave credit';
    }
    renderStatistics();
  });

  // ----- Keyboard: ESC closes modals -----
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!el.confirmModal.classList.contains('hidden'))      closeConfirmModal();
      else if (!el.statusModal.classList.contains('hidden'))  closeStatusModal();
      else if (!el.nonWorkingModal.classList.contains('hidden')) closeNonWorkingModal();
    }
  });

  // ----- Non-working day modal -----
  el.nonWorkingCloseBtn?.addEventListener('click', closeNonWorkingModal);
  el.nonWorkingBackdrop?.addEventListener('click', closeNonWorkingModal);
}

function navigateTo(target) {
  el.navItems.forEach(ni => {
    const isActive = ni.getAttribute('data-target') === target;
    ni.classList.toggle('active', isActive);
    ni.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  const targetEl = el.sections[target];
  if (!targetEl) return;

  Object.values(el.sections).forEach(s => s.classList.add('hidden'));
  targetEl.classList.remove('hidden');

  const titleMap = { dashboard: 'Dashboard', calendar: 'Calendar', stats: 'Statistics' };
  el.pageTitle.textContent = titleMap[target] || '';

  // Refresh views on navigation
  if (target === 'calendar') renderCalendar();
  if (target === 'stats')    renderStatistics();

  // Animate the dock bubble to the active item
  positionDockBubble(target);
}

/**
 * positionDockBubble(target)
 *
 * Moves the active circular bubble to sit centered behind the given nav item.
 * Uses offsetLeft/offsetTop/offsetWidth/offsetHeight (layout values) rather
 * than getBoundingClientRect() so CSS transforms on the active item don't
 * skew the bubble's position.
 *
 * .dock-bubble has position:absolute; top:0; left:0.
 * We apply: transform: translate(centerX - bubbleW/2, centerY - bubbleH/2)
 * which places the bubble's center exactly at the button's layout center.
 *
 * @param {string} target  'dashboard' | 'calendar' | 'stats'
 */
function positionDockBubble(target) {
  const bubble = el.dockBubble;
  const dock   = document.getElementById('bottom-dock');
  if (!bubble || !dock) return;

  const activeBtn = dock.querySelector(`.dock-item[data-target="${target}"]`);
  if (!activeBtn) return;

  // offsetLeft/offsetTop are relative to offsetParent (the dock).
  // This is immune to CSS transforms applied to the button itself.
  const btnCenterX = activeBtn.offsetLeft + activeBtn.offsetWidth  / 2;
  const btnCenterY = activeBtn.offsetTop  + activeBtn.offsetHeight / 2;

  const bubbleW = bubble.offsetWidth  || 66;
  const bubbleH = bubble.offsetHeight || 66;

  bubble.style.transform =
    `translate(${btnCenterX - bubbleW / 2}px, ${btnCenterY - bubbleH / 2}px)`;
}

function openSidebar()  { /* no-op — dock replaces sidebar */ }
function closeSidebar() { /* no-op — dock replaces sidebar */ }

// ============================================================
// 9. DATA LAYER
// ============================================================

/**
 * Fetch all attendance records for the current user.
 * Updates state.attendanceData and refreshes all views.
 */
async function fetchAttendanceData() {
  if (!state.currentUser) return;

  // Show loading state
  showDashboardLoading();

  try {
    const { data, error } = await db
      .from('attendance')
      .select('*')
      .eq('user_id', state.currentUser.id)
      .order('date', { ascending: true });

    if (error) {
      // Table doesn't exist yet
      if (error.code === '42P01') {
        console.error('[AttendPro] attendance table not found. Run supabase_setup.sql first.');
        showDashboardError('Database not configured. Please run supabase_setup.sql.');
        return;
      }
      throw error;
    }

    state.attendanceData = data || [];
    showDashboardContent();
    refreshAllViews();

  } catch (err) {
    console.error('[AttendPro] fetchAttendanceData error:', err);
    showDashboardError('Unable to load attendance data. Please try again.');
  }
}

/**
 * Save (insert or update) an attendance record.
 * Uses upsert with onConflict on (user_id, date) to prevent duplicates.
 * @param {string} dateStr   YYYY-MM-DD
 * @param {string} status    'present' | 'absent' | 'medical' | 'holiday'
 * @param {string} duration  'full' | 'half'  (defaults to 'full')
 */
async function saveAttendance(dateStr, status, duration = DURATION.FULL) {
  if (!state.currentUser || state.isSaving) return;
  state.isSaving = true;

  try {
    const { data, error } = await db
      .from('attendance')
      .upsert(
        { user_id: state.currentUser.id, date: dateStr, status, duration },
        { onConflict: 'user_id,date' }
      )
      .select()
      .single();

    if (error) throw error;

    // Update local state immediately
    const idx = state.attendanceData.findIndex(r => r.date === dateStr);
    if (idx > -1) {
      state.attendanceData[idx] = data;
    } else {
      state.attendanceData.push(data);
      state.attendanceData.sort((a, b) => a.date.localeCompare(b.date));
    }

    refreshAllViews();

    const durationLabel = duration === DURATION.HALF ? 'Half Day · ' : '';
    showToast(`${STATUS_EMOJI[status]} ${durationLabel}${STATUS_LABELS[status]} marked`, 'success');

  } catch (err) {
    console.error('[AttendPro] saveAttendance error:', err);
    showToast('Something went wrong. Please try again.', 'error');
  } finally {
    state.isSaving = false;
  }
}

/**
 * Delete an attendance record for the given date.
 * Shows a confirmation modal first — actual deletion is triggered by confirmDelete().
 */
function initiateDelete(dateStr) {
  state.pendingDelete = dateStr;

  const formatted = formatDateDisplay(dateStr);
  el.confirmTitle.textContent = 'Remove Attendance?';
  el.confirmBody.textContent  = `Remove attendance for ${formatted}? This will recalculate your statistics.`;

  openConfirmModal();
}

async function deleteAttendance(dateStr) {
  if (!state.currentUser) return;

  setBtnLoading(el.confirmDeleteBtn, true);

  try {
    const { error } = await db
      .from('attendance')
      .delete()
      .eq('user_id', state.currentUser.id)
      .eq('date', dateStr);

    if (error) throw error;

    // Remove from local state immediately
    state.attendanceData = state.attendanceData.filter(r => r.date !== dateStr);

    refreshAllViews();
    showToast('🗑️ Attendance removed', 'info');

  } catch (err) {
    console.error('[AttendPro] deleteAttendance error:', err);
    showToast('Failed to remove attendance. Please try again.', 'error');
  } finally {
    setBtnLoading(el.confirmDeleteBtn, false);
  }
}

// ============================================================
// 10. CENTRALIZED ATTENDANCE CALCULATION ENGINE
// ============================================================

/**
 * calculateAttendance(records, policy)
 *
 * THE single source of truth for all attendance maths.
 *
 * Each record is first normalized via normalizeRecord() to handle the legacy
 * 'half_day' status and missing duration fields.
 *
 * Duration weighting:
 *   'full' → durationValue = 1.0
 *   'half' → durationValue = 0.5
 *
 * Per-status contribution to attended values:
 *   present  → actual += durationValue,  official += durationValue
 *   absent   → actual += 0,              official += 0
 *   medical  → actual += 0,              official += durationValue  (school credits as present)
 *   holiday  → excluded entirely (workingDayValue = 0)
 *
 * @param {Array}  records  Raw records from state.attendanceData
 * @param {Object} policy   Defaults to global POLICY
 * @returns {Object}
 */
function calculateAttendance(records, policy = POLICY) {
  const target = policy.ATTENDANCE_TARGET;

  // Aggregated weighted values
  let totalWorkingDays     = 0;
  let actualAttendedValue  = 0;
  let officialAttendedValue = 0;

  // Raw counts (for display, not for % calculation)
  let fullPresent  = 0;  // full-day present
  let halfPresent  = 0;  // half-day present
  let fullAbsent   = 0;
  let halfAbsent   = 0;
  let fullMedical  = 0;
  let halfMedical  = 0;
  let holidays     = 0;
  let halfDayCount = 0;  // total half-duration records (any status)

  records.forEach(raw => {
    const r  = normalizeRecord(raw);
    const dv = r.duration === DURATION.HALF ? 0.5 : 1.0; // duration value

    if (r.status === STATUS.HOLIDAY) {
      holidays++;
      return; // holidays excluded from working days
    }

    totalWorkingDays += dv;

    if (r.duration === DURATION.HALF) halfDayCount++;

    switch (r.status) {
      case STATUS.PRESENT:
        actualAttendedValue   += dv;
        officialAttendedValue += dv;
        if (r.duration === DURATION.HALF) halfPresent++; else fullPresent++;
        break;
      case STATUS.ABSENT:
        // attended value stays 0
        if (r.duration === DURATION.HALF) halfAbsent++; else fullAbsent++;
        break;
      case STATUS.MEDICAL:
        officialAttendedValue += dv;   // credited as present
        // actual attended stays 0
        if (r.duration === DURATION.HALF) halfMedical++; else fullMedical++;
        break;
    }
  });

  // Convenience totals for display (combine full+half per status)
  const presentDays      = fullPresent + halfPresent;
  const absentDays       = fullAbsent  + halfAbsent;
  const medicalLeaveDays = fullMedical + halfMedical;

  let actualAttendancePercentage   = 0;
  let officialAttendancePercentage = 0;

  if (totalWorkingDays > 0) {
    actualAttendancePercentage   = round1((actualAttendedValue   / totalWorkingDays) * 100);
    officialAttendancePercentage = round1((officialAttendedValue / totalWorkingDays) * 100);
  }

  return {
    // Weighted sums (used for % and predictor)
    totalWorkingDays,
    actualAttendedValue,
    officialAttendedValue,
    // Per-status full+half totals (display)
    presentDays,
    absentDays,
    medicalLeaveDays,
    holidays,
    halfDayCount,       // total half-duration records across all statuses
    // Per-status+duration sub-counts (statistics breakdown)
    fullPresent,  halfPresent,
    fullAbsent,   halfAbsent,
    fullMedical,  halfMedical,
    // Percentages
    actualAttendancePercentage,
    officialAttendancePercentage,
    // Meta
    target:  target * 100,
    hasData: totalWorkingDays > 0,
  };
}

/**
 * calculateLeaveAllowance
 *
 * Additional full-day ordinary absences before official % drops below target.
 * Solve: officialAttendedValue / (totalWorkingDays + x) >= target
 *        x <= floor(officialAttendedValue / target − totalWorkingDays)
 */
function calculateLeaveAllowance(stats) {
  const { officialAttendedValue, totalWorkingDays } = stats;
  const target = POLICY.ATTENDANCE_TARGET;
  return Math.max(0, Math.floor(officialAttendedValue / target - totalWorkingDays));
}

/**
 * calculateRecoveryDays
 *
 * Full present days needed to bring official % back to >= target.
 * Solve: (officialAttendedValue + x) / (totalWorkingDays + x) >= target
 *        x >= ceil((target × total − official) / (1 − target))
 */
function calculateRecoveryDays(stats) {
  const { officialAttendedValue, totalWorkingDays } = stats;
  const target = POLICY.ATTENDANCE_TARGET;

  const raw  = (target * totalWorkingDays - officialAttendedValue) / (1 - target);
  const days = Math.ceil(Math.max(0, raw));

  const newOfficial = officialAttendedValue + days;
  const newTotal    = totalWorkingDays + days;
  const projectedOfficialPct = newTotal > 0 ? round1((newOfficial / newTotal) * 100) : 0;

  return { days, projectedOfficialPct };
}

/**
 * groupByMonth(records)
 * Groups records into { 'YYYY-MM': [records] }
 */
function groupByMonth(records) {
  const groups = {};
  records.forEach(r => {
    const key = r.date.substring(0, 7); // "YYYY-MM"
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  return groups;
}

// ============================================================
// 11. DASHBOARD RENDERER
// ============================================================

function showDashboardLoading() {
  el.dashboardLoading.classList.remove('hidden');
  el.dashboardContent.classList.add('hidden');
  el.dashboardError.classList.add('hidden');
}

function showDashboardContent() {
  el.dashboardLoading.classList.add('hidden');
  el.dashboardContent.classList.remove('hidden');
  el.dashboardError.classList.add('hidden');
  // Hide empty-state whenever we show content
  const emptyEl = document.getElementById('dashboard-empty');
  if (emptyEl) emptyEl.classList.add('hidden');
}

function showDashboardError(msg) {
  el.dashboardLoading.classList.add('hidden');
  el.dashboardContent.classList.add('hidden');
  el.dashboardError.classList.remove('hidden');
  el.dashboardError.querySelector('p').textContent = msg;
}

function renderDashboard() {
  const stats = calculateAttendance(state.attendanceData);

  // ── Empty-state CTA ───────────────────────────────────────────────────
  const emptyEl = document.getElementById('dashboard-empty');
  if (emptyEl) {
    if (!stats.hasData) {
      emptyEl.classList.remove('hidden');
      emptyEl.innerHTML = `
        <div class="empty-state-card">
          <div class="empty-state-icon" aria-hidden="true">
            <i class="ph ph-calendar-blank"></i>
          </div>
          <h3 class="empty-state-title">Welcome to AttendPro</h3>
          <p class="empty-state-sub">
            No attendance records yet. Import your previous attendance or start
            marking days from today.
          </p>
          <div class="empty-state-actions">
            <button class="empty-cta-primary" data-action="open-wizard"
                    aria-label="Import previous attendance">
              <i class="ph ph-upload-simple" aria-hidden="true"></i>
              Enter Previous Attendance
            </button>
            <button class="empty-cta-secondary" id="start-today-btn"
                    aria-label="Start marking from today">
              <i class="ph ph-calendar-check" aria-hidden="true"></i>
              Start From Today
            </button>
          </div>
        </div>`;

      // Wire CTA buttons
      emptyEl.querySelector('[data-action="open-wizard"]')?.addEventListener('click', () => {
        if (typeof openWizard === 'function') openWizard();
      });
      emptyEl.querySelector('#start-today-btn')?.addEventListener('click', () => {
        navigateTo('calendar');
      });

      // Hide the main stats content when empty
      el.dashboardContent.classList.add('hidden');
      return;
    } else {
      emptyEl.classList.add('hidden');
    }
  }

  // Update stat cards
  el.dashTotal.textContent    = round1(stats.totalWorkingDays);
  el.dashPresent.textContent  = stats.presentDays;
  if (el.dashHalfDays) el.dashHalfDays.textContent = stats.halfDayCount;
  el.dashAbsent.textContent   = stats.absentDays;
  el.dashHolidays.textContent = stats.holidays;
  el.dashMedicals.textContent = stats.medicalLeaveDays;

  renderProgressRing(stats);
  renderPredictor(stats);

  // Actual-attendance sub-line
  const actualEl = document.getElementById('dash-actual-pct');
  if (actualEl) {
    if (stats.hasData) {
      actualEl.textContent = `Actual (no medical credit): ${stats.actualAttendancePercentage}%`;
      actualEl.classList.remove('hidden');
    } else {
      actualEl.classList.add('hidden');
    }
  }
}

function renderProgressRing(stats) {
  const circle = el.circularProgress;
  const radius = 70; // matches SVG r="70"
  const circumference = 2 * Math.PI * radius; // 439.82…

  // Ring always shows OFFICIAL attendance (school's rule)
  const pct = stats.hasData ? stats.officialAttendancePercentage : 0;

  // Determine color and badge
  let strokeColor, badgeClass, badgeText;
  if (!stats.hasData) {
    strokeColor = 'var(--color-primary)';
    badgeClass  = 'badge-neutral';
    badgeText   = 'No data yet';
  } else if (pct >= stats.target) {
    strokeColor = 'var(--color-present)';
    badgeClass  = 'badge-safe';
    badgeText   = `Safe (≥${stats.target}%)`;
  } else if (pct >= 70) {
    strokeColor = 'var(--color-warning)';
    badgeClass  = 'badge-warning';
    badgeText   = `Warning (${pct}%)`;
  } else {
    strokeColor = 'var(--color-absent)';
    badgeClass  = 'badge-risk';
    badgeText   = `Risk — ${pct}%`;
  }

  const offset = circumference - (pct / 100) * circumference;

  // Reset then animate (double rAF ensures transition fires)
  circle.style.strokeDasharray  = circumference;
  circle.style.strokeDashoffset = circumference;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      circle.style.strokeDashoffset = offset;
      circle.style.stroke           = strokeColor;
    });
  });

  el.progressText.textContent = stats.hasData ? `${pct}%` : '–';

  // ARIA
  el.progressRingAria.setAttribute('aria-valuenow', pct);
  el.progressRingAria.setAttribute('aria-label', `Official Attendance: ${pct}%`);

  // Badge
  el.attendanceBadge.className   = `status-badge ${badgeClass}`;
  el.attendanceBadge.textContent = badgeText;
}

function renderPredictor(stats) {
  if (!stats.hasData) {
    el.predictorContent.innerHTML = `<p class="placeholder-text">Log some attendance days to see your predictions.</p>`;
    return;
  }

  const target       = POLICY.ATTENDANCE_TARGET * 100; // 75
  const officialPct  = stats.officialAttendancePercentage;
  const offVal       = stats.officialAttendedValue;
  const total        = stats.totalWorkingDays;
  let html = '';

  // Build a compact breakdown line for the predictor footer
  const breakdownParts = [];
  if (stats.presentDays > 0)
    breakdownParts.push(`<strong>${stats.presentDays}</strong> present`);
  if (stats.halfDayCount > 0)
    breakdownParts.push(`<strong>${stats.halfDayCount}</strong> half-day`);
  if (stats.medicalLeaveDays > 0)
    breakdownParts.push(`<strong>${stats.medicalLeaveDays}</strong> medical`);
  const breakdownLine = breakdownParts.join(' · ');

  if (officialPct >= target) {
    const safeLeaves = calculateLeaveAllowance(stats);

    if (safeLeaves === 0) {
      html = `
        <div class="predictor-block predictor-safe">
          <p class="predictor-headline">You're right at the threshold.</p>
          <p class="predictor-detail">
            Your official attendance is <strong>${officialPct}%</strong>.
            Avoid taking additional leave to stay at or above ${target}%.
          </p>
          <p class="predictor-sub">
            Credited: <strong>${offVal}</strong> / <strong>${total}</strong> working days
            ${breakdownLine ? `&nbsp;·&nbsp; ${breakdownLine}` : ''}
          </p>
        </div>`;
    } else {
      html = `
        <div class="predictor-block predictor-safe">
          <p class="predictor-headline">You're doing great! 🎉</p>
          <p class="predictor-detail">
            You can take
            <strong class="predictor-number">${safeLeaves}</strong>
            more day${safeLeaves !== 1 ? 's' : ''} off and still remain at ${target}%.
          </p>
          <p class="predictor-sub">
            Official attendance: <strong>${officialPct}%</strong>
            &nbsp;·&nbsp; Credited: <strong>${offVal}</strong> / <strong>${total}</strong> days
            ${breakdownLine ? `&nbsp;·&nbsp; ${breakdownLine}` : ''}
          </p>
        </div>`;
    }
  } else {
    const recovery = calculateRecoveryDays(stats);

    html = `
      <div class="predictor-block predictor-risk">
        <p class="predictor-headline">Below ${target}% — action needed!</p>
        <p class="predictor-detail">
          Attend the next
          <strong class="predictor-number predictor-warn">${recovery.days}</strong>
          full working day${recovery.days !== 1 ? 's' : ''} to recover.
        </p>
        <p class="predictor-sub">
          After that: projected official attendance
          <strong style="color:var(--color-present)">${recovery.projectedOfficialPct}%</strong>
        </p>
        <p class="predictor-sub">
          Official: <strong>${officialPct}%</strong>
          &nbsp;·&nbsp; Credited: <strong>${offVal}</strong> / <strong>${total}</strong> days
          ${breakdownLine ? `&nbsp;·&nbsp; ${breakdownLine}` : ''}
        </p>
      </div>`;
  }

  el.predictorContent.innerHTML = html;
}

// ============================================================
// 12. CALENDAR RENDERER
// ============================================================

/**
 * Calendar cell icon lookup — shows BOTH duration and status at a glance.
 * Full-day: standard emoji. Half-day: ½ + compact status marker.
 */
function getCalendarCellIcon(status, duration) {
  if (duration === DURATION.HALF) {
    // Half-day variants — distinct from full-day to signal partial attendance
    switch (status) {
      case STATUS.PRESENT: return '½✓';
      case STATUS.ABSENT:  return '½✕';
      case STATUS.MEDICAL: return '½🏥';
      default:             return '½';
    }
  }
  // Full-day: use regular emoji
  return STATUS_EMOJI[status] || '?';
}

function renderCalendar() {
  el.calendarDays.innerHTML = '';

  const year  = state.currentMonth.getFullYear();
  const month = state.currentMonth.getMonth();

  el.calendarMonthYear.textContent = `${MONTH_NAMES[month]} ${year}`;

  const firstDow    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthStr    = String(month + 1).padStart(2, '0');
  const today       = getTodayLocal();

  // Build normalized lookup: date-string → { status, duration }
  const recordMap = {};
  state.attendanceData.forEach(raw => {
    const r = normalizeRecord(raw);
    recordMap[r.date] = r;
  });

  // Empty cells before the 1st
  for (let i = 0; i < firstDow; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    empty.setAttribute('aria-hidden', 'true');
    el.calendarDays.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr   = String(d).padStart(2, '0');
    const fullDate = `${year}-${monthStr}-${dayStr}`;
    const rec      = recordMap[fullDate] || null;   // normalized record or null
    const isToday  = fullDate === today;
    const nonWorkingLabel = getNonWorkingLabel(fullDate);
    const isOff   = nonWorkingLabel !== null;

    const cell = document.createElement('button');
    cell.className = 'cal-day';
    cell.setAttribute('role', 'gridcell');
    if (isToday) cell.classList.add('today');

    if (isOff) {
      // ── Non-working day ──────────────────────────────────────────────────
      cell.classList.add('cal-day-off');
      cell.setAttribute('aria-label',
        `${d} ${MONTH_NAMES[month]} — ${nonWorkingLabel} (non-working day)`);

      const dayNum = document.createElement('span');
      dayNum.className = 'cal-day-num';
      dayNum.textContent = d;
      cell.appendChild(dayNum);

      const offTag = document.createElement('span');
      offTag.className = 'cal-off-tag';
      offTag.setAttribute('aria-hidden', 'true');
      offTag.textContent = nonWorkingLabel === 'Sunday' ? 'OFF' : '2nd Sat';
      cell.appendChild(offTag);

      cell.addEventListener('click', () => openNonWorkingModal(fullDate, nonWorkingLabel));

    } else if (rec) {
      // ── Marked day ───────────────────────────────────────────────────────
      // data-status drives the background color (present/absent/medical/holiday)
      cell.setAttribute('data-status', rec.status);
      // Mark half-day cells so CSS can add the ½ visual treatment
      if (rec.duration === DURATION.HALF) cell.classList.add('cal-day-half');

      const durationLabel = rec.duration === DURATION.HALF ? 'Half Day' : 'Full Day';
      cell.setAttribute('aria-label',
        `${d} ${MONTH_NAMES[month]} — ${durationLabel} ${STATUS_LABELS[rec.status]}`);

      const dayNum = document.createElement('span');
      dayNum.className = 'cal-day-num';
      dayNum.textContent = d;
      cell.appendChild(dayNum);

      const icon = document.createElement('span');
      icon.className = `cal-status-icon`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = getCalendarCellIcon(rec.status, rec.duration);
      cell.appendChild(icon);

      cell.addEventListener('click', () => openStatusModal(fullDate));

    } else {
      // ── Unmarked working day ─────────────────────────────────────────────
      cell.setAttribute('aria-label', `${d} ${MONTH_NAMES[month]} — No record. Tap to mark.`);

      const dayNum = document.createElement('span');
      dayNum.className = 'cal-day-num';
      dayNum.textContent = d;
      cell.appendChild(dayNum);

      cell.addEventListener('click', () => openStatusModal(fullDate));
    }

    el.calendarDays.appendChild(cell);
  }
}

// ============================================================
// NON-WORKING DAY MODAL
// ============================================================

function openNonWorkingModal(dateStr, label) {
  const formatted = formatDateDisplay(dateStr);

  el.nonWorkingTitle.textContent = label === 'Sunday' ? 'Sunday — Non-working Day'
                                                      : 'Second Saturday — Non-working Day';
  el.nonWorkingBody.innerHTML =
    `<strong>${formatted}</strong> is automatically excluded from attendance calculations.` +
    `<br><br>Sundays and Second Saturdays are non-working days and do not count as` +
    ` Present, Absent, or Medical Leave.`;

  el.nonWorkingModal.classList.remove('hidden');
  el.nonWorkingModal.removeAttribute('aria-hidden');
  el.nonWorkingCloseBtn.focus();
}

function closeNonWorkingModal() {
  el.nonWorkingModal.classList.add('hidden');
  el.nonWorkingModal.setAttribute('aria-hidden', 'true');
}

// ============================================================
// 13. STATISTICS RENDERER
// ============================================================

function renderStatistics() {
  const grouped    = groupByMonth(state.attendanceData);
  const sortedKeys = Object.keys(grouped).sort();

  const officialLabels = [];
  const officialPoints = [];
  const actualLabels   = [];
  const actualPoints   = [];
  const cardItems      = [];

  sortedKeys.forEach(key => {
    const stats = calculateAttendance(grouped[key]);
    const [y, m] = key.split('-');
    const label  = `${MONTH_SHORT[parseInt(m, 10) - 1]} ${y}`;

    // Chart only shows months that have at least one working day logged
    if (stats.totalWorkingDays > 0) {
      officialLabels.push(label);
      officialPoints.push(stats.officialAttendancePercentage);
      actualLabels.push(label);
      actualPoints.push(stats.actualAttendancePercentage);
    }

    // Month cards show every month that has any record at all
    if (grouped[key].length > 0) {
      cardItems.push({ key, label, stats });
    }
  });

  // Render chart in whichever mode is currently active
  if (state.chartMode === 'actual') {
    renderChart(actualLabels, actualPoints, 'actual');
  } else {
    renderChart(officialLabels, officialPoints, 'official');
  }

  renderMonthCards(cardItems);
}

/**
 * renderChart(labels, dataPoints, mode)
 *
 * @param {string[]} labels      Month labels e.g. ["Sep 2026"]
 * @param {number[]} dataPoints  Percentage values matching labels
 * @param {string}   mode        'official' | 'actual'
 */
function renderChart(labels, dataPoints, mode = 'official') {
  const ctx = el.chartCanvas.getContext('2d');

  if (state.chartInstance) {
    state.chartInstance.destroy();
    state.chartInstance = null;
  }

  if (labels.length === 0) {
    el.chartEmpty.classList.remove('hidden');
    el.chartCanvas.style.display = 'none';
    return;
  }

  el.chartEmpty.classList.add('hidden');
  el.chartCanvas.style.display = '';

  const isDark    = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#94a3b8' : '#64748b';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  // Official = indigo, Actual = teal — distinct so toggling is visually obvious
  const lineColor = mode === 'official'
    ? (isDark ? '#818cf8' : '#4f46e5')   // indigo
    : (isDark ? '#34d399' : '#059669');  // emerald
  const fillColor = mode === 'official'
    ? (isDark ? 'rgba(129,140,248,0.12)' : 'rgba(79,70,229,0.10)')
    : (isDark ? 'rgba(52,211,153,0.12)'  : 'rgba(5,150,105,0.10)');

  const targetPct   = POLICY.ATTENDANCE_TARGET * 100; // 75
  const modeLabel   = mode === 'official' ? 'Official Attendance %' : 'Actual Attendance %';
  const targetLabel = `${targetPct}% Target`;

  state.chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: modeLabel,
        data: dataPoints,
        borderColor: lineColor,
        backgroundColor: fillColor,
        borderWidth: 2.5,
        pointBackgroundColor: lineColor,
        pointBorderColor: isDark ? '#1e293b' : '#fff',
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 8,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeInOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? '#1e293b' : '#fff',
          titleColor:  isDark ? '#f1f5f9' : '#1e293b',
          bodyColor:   isDark ? '#94a3b8' : '#64748b',
          borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: ctx => ` ${ctx.parsed.y}%  (${modeLabel})`,
          },
        },
      },
      scales: {
        y: {
          min: 0, max: 100,
          grid:  { color: gridColor },
          ticks: { color: textColor, callback: v => `${v}%` },
        },
        x: {
          grid:  { display: false },
          ticks: { color: textColor },
        },
      },
    },
    // Inline plugin: dashed 75% target line with label
    plugins: [{
      id: 'targetLine',
      beforeDraw(chart) {
        const { ctx: c, chartArea: { left, right }, scales: { y } } = chart;
        const yPos = y.getPixelForValue(targetPct);
        c.save();
        c.beginPath();
        c.moveTo(left, yPos);
        c.lineTo(right, yPos);
        c.lineWidth   = 1.5;
        c.strokeStyle = isDark ? 'rgba(239,68,68,0.45)' : 'rgba(239,68,68,0.35)';
        c.setLineDash([6, 4]);
        c.stroke();
        c.fillStyle = isDark ? 'rgba(239,68,68,0.7)' : 'rgba(239,68,68,0.6)';
        c.font      = '11px Inter, sans-serif';
        c.textAlign = 'right';
        c.fillText(targetLabel, right - 4, yPos - 6);
        c.restore();
      },
    }],
  });
}

function renderMonthCards(cardItems) {
  if (cardItems.length === 0) {
    el.monthCardsContainer.innerHTML =
      `<p class="placeholder-text">No attendance data yet. Start marking days on the calendar.</p>`;
    return;
  }

  const html = cardItems.map(({ label, stats }) => {
    const hasWorking = stats.totalWorkingDays > 0;

    let statusClass, statusIcon, statusText;
    if (!hasWorking) {
      statusClass = 'card-neutral'; statusIcon = 'ph-minus-circle'; statusText = 'No working days';
    } else if (stats.officialAttendancePercentage >= stats.target) {
      statusClass = 'card-safe';    statusIcon = 'ph-check-circle'; statusText = 'Above 75%';
    } else if (stats.officialAttendancePercentage >= 70) {
      statusClass = 'card-warning'; statusIcon = 'ph-warning';      statusText = 'Below 75%';
    } else {
      statusClass = 'card-risk';    statusIcon = 'ph-warning-octagon'; statusText = 'At risk';
    }

    const officialDisplay = hasWorking ? `${stats.officialAttendancePercentage}%` : '—';
    const actualDisplay   = hasWorking ? `${stats.actualAttendancePercentage}%`   : '—';
    const officialColor   = !hasWorking ? 'var(--text-muted)'
      : stats.officialAttendancePercentage >= stats.target ? 'var(--color-present)'
      : stats.officialAttendancePercentage >= 70           ? 'var(--color-warning)'
      :                                                      'var(--color-absent)';
    const workingDisplay  = round1(stats.totalWorkingDays);

    // Helper: render a breakdown row for one status showing full + half sub-counts
    function breakdownRow(iconClass, full, half, label) {
      if (full === 0 && half === 0) return '';
      const parts = [];
      if (full > 0)  parts.push(`${full} full`);
      if (half > 0)  parts.push(`${half} half`);
      return `
        <span class="month-stat ${label.toLowerCase().replace(' ', '-')}">
          <i class="ph ${iconClass}" aria-hidden="true"></i>
          ${full + half} ${label}${parts.length ? ` <span class="month-stat-detail">(${parts.join(', ')})</span>` : ''}
        </span>`;
    }

    return `
      <article class="month-card glass-card ${statusClass}" aria-label="${label} attendance">
        <div class="month-card-header">
          <span class="month-name">${label}</span>
          <span class="month-status-badge">
            <i class="ph ${statusIcon}" aria-hidden="true"></i> ${statusText}
          </span>
        </div>

        <div class="month-pct-row">
          <div class="month-pct-block">
            <span class="month-pct-label">Official</span>
            <span class="month-pct" style="color:${officialColor}">${officialDisplay}</span>
            <span class="month-pct-sub">Medical Leave credited</span>
          </div>
          ${hasWorking ? `
          <div class="month-pct-divider" aria-hidden="true"></div>
          <div class="month-pct-block month-pct-secondary">
            <span class="month-pct-label">Actual</span>
            <span class="month-pct month-pct-actual">${actualDisplay}</span>
            <span class="month-pct-sub">Excl. medical credit</span>
          </div>` : ''}
        </div>

        <div class="month-breakdown">
          ${breakdownRow('ph-check-circle', stats.fullPresent,  stats.halfPresent,  'Present')}
          ${breakdownRow('ph-x-circle',     stats.fullAbsent,   stats.halfAbsent,   'Absent')}
          ${breakdownRow('ph-first-aid',    stats.fullMedical,  stats.halfMedical,  'Medical')}
          ${stats.holidays > 0 ? `
          <span class="month-stat holiday">
            <i class="ph ph-sun-horizon" aria-hidden="true"></i>
            ${stats.holidays} Holiday
          </span>` : ''}
        </div>

        <div class="month-card-footer">
          ${hasWorking
            ? `${round1(stats.officialAttendedValue)} credited / ${workingDisplay} working days`
            : 'Holidays only — no working days logged'}
        </div>
      </article>`;
  }).join('');

  el.monthCardsContainer.innerHTML = html;
}

// ============================================================
// 14. STATUS MODAL — Two-step: Duration → Status
// ============================================================

let _activeModalDate    = null; // YYYY-MM-DD
let _selectedDuration   = null; // 'full' | 'half' | null (null = not chosen yet)

/**
 * Build and render the modal body for the two-step flow.
 * Step 1: pick Full Day or Half Day.
 * Step 2 (or Holiday shortcut): pick status.
 *
 * @param {string|null} preselectedDuration  If reopening an existing record,
 *   pass its duration so step 2 shows immediately; null forces step 1.
 */
function renderModalBody(preselectedDuration = null) {
  const body = document.getElementById('modal-body');
  if (!body) return;

  if (preselectedDuration === null) {
    // ── STEP 1: Duration picker ──────────────────────────────────────────
    body.innerHTML = `
      <p class="modal-step-label" id="modal-step1-label">Attendance duration</p>

      <div class="duration-picker" role="group" aria-labelledby="modal-step1-label">
        <button class="dur-btn" data-dur="full" aria-label="Full Day — 1 working day">
          <span class="dur-icon" aria-hidden="true">☀️</span>
          <span class="dur-title">Full Day</span>
          <span class="dur-sub">1 working day</span>
        </button>
        <button class="dur-btn" data-dur="half" aria-label="Half Day — 0.5 working day">
          <span class="dur-icon" aria-hidden="true">🌓</span>
          <span class="dur-title">Half Day</span>
          <span class="dur-sub">0.5 working day</span>
        </button>
      </div>

      <!-- Holiday shortcut: no duration required -->
      <div class="modal-shortcut">
        <button class="status-btn holiday modal-shortcut-btn" data-action="save" data-status="holiday" data-dur="full"
                aria-label="Mark as Holiday">
          <span class="status-icon" aria-hidden="true">🏖️</span>
          <span>Holiday</span>
        </button>
      </div>`;

    // Attach duration button handlers
    body.querySelectorAll('.dur-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _selectedDuration = btn.getAttribute('data-dur');
        renderModalBody(_selectedDuration); // advance to step 2
      });
    });

    // Holiday shortcut handler
    body.querySelector('[data-action="save"]')?.addEventListener('click', handleModalSaveClick);

  } else {
    // ── STEP 2: Status picker ────────────────────────────────────────────
    const isHalf = preselectedDuration === DURATION.HALF;
    const stepLabel = isHalf
      ? 'How should this half day be recorded?'
      : 'Attendance status';

    body.innerHTML = `
      <div class="modal-back-row">
        <button class="modal-back-btn" id="modal-back-btn" aria-label="Back to duration selection">
          <i class="ph ph-caret-left" aria-hidden="true"></i>
          <span>${isHalf ? 'Half Day' : 'Full Day'}</span>
        </button>
      </div>

      <p class="modal-step-label" id="modal-step2-label">${stepLabel}</p>

      <div class="status-options" role="group" aria-labelledby="modal-step2-label">
        <button class="status-btn present${isHalf ? ' half-variant' : ''}"
                data-action="save" data-status="present" data-dur="${preselectedDuration}"
                aria-label="Mark as ${isHalf ? 'Half Day ' : ''}Present">
          <span class="status-icon" aria-hidden="true">${isHalf ? '🟢' : '✅'}</span>
          <span>Present</span>
        </button>
        <button class="status-btn absent${isHalf ? ' half-variant' : ''}"
                data-action="save" data-status="absent" data-dur="${preselectedDuration}"
                aria-label="Mark as ${isHalf ? 'Half Day ' : ''}Absent">
          <span class="status-icon" aria-hidden="true">${isHalf ? '🔴' : '❌'}</span>
          <span>Absent</span>
        </button>
        <button class="status-btn medical${isHalf ? ' half-variant' : ''}"
                data-action="save" data-status="medical" data-dur="${preselectedDuration}"
                aria-label="Mark as ${isHalf ? 'Half Day ' : ''}Medical Leave">
          <span class="status-icon" aria-hidden="true">${isHalf ? '🟣' : '🏥'}</span>
          <span>Medical Leave</span>
        </button>
      </div>`;

    body.querySelectorAll('[data-action="save"]').forEach(btn => {
      btn.addEventListener('click', handleModalSaveClick);
    });

    body.querySelector('#modal-back-btn')?.addEventListener('click', () => {
      _selectedDuration = null;
      renderModalBody(null); // back to step 1
    });
  }
}

/** Shared save handler for both the holiday shortcut and step-2 status buttons. */
async function handleModalSaveClick(e) {
  const btn      = e.currentTarget;
  const status   = btn.getAttribute('data-status');
  const duration = btn.getAttribute('data-dur') || DURATION.FULL;
  const dateStr  = _activeModalDate;

  if (!dateStr || !status) return;

  closeStatusModal();
  await saveAttendance(dateStr, status, duration);
}

function openStatusModal(dateStr) {
  _activeModalDate  = dateStr;
  _selectedDuration = null;

  const raw       = state.attendanceData.find(r => r.date === dateStr);
  const rec       = raw ? normalizeRecord(raw) : null;
  const formatted = formatDateDisplay(dateStr);

  el.modalTitle.textContent    = rec ? 'Update Attendance' : 'Log Attendance';
  el.modalDateText.textContent = formatted;

  if (rec) {
    el.modalCurrentStatus.classList.remove('hidden');
    const durLabel = rec.duration === DURATION.HALF ? 'Half Day · ' : '';
    el.modalStatusValue.textContent = `${STATUS_EMOJI[rec.status]} ${durLabel}${STATUS_LABELS[rec.status]}`;
    el.modalStatusValue.className   = `current-value status-text-${rec.status}`;
    document.getElementById('remove-attendance-btn').classList.remove('hidden');
    // Preselect the existing duration so step 2 opens directly
    _selectedDuration = rec.duration;
  } else {
    el.modalCurrentStatus.classList.add('hidden');
    document.getElementById('remove-attendance-btn').classList.add('hidden');
  }

  renderModalBody(_selectedDuration);

  el.statusModal.classList.remove('hidden');
  el.statusModal.removeAttribute('aria-hidden');

  // Focus the first interactive element in the modal body
  requestAnimationFrame(() => {
    const first = el.statusModal.querySelector('button:not([id="close-modal"]):not([id="remove-attendance-btn"])');
    if (first) first.focus();
  });
}

function closeStatusModal() {
  el.statusModal.classList.add('hidden');
  el.statusModal.setAttribute('aria-hidden', 'true');
  _activeModalDate  = null;
  _selectedDuration = null;
}

// ============================================================
// 15. CONFIRM DELETE MODAL
// ============================================================

function openConfirmModal() {
  el.confirmModal.classList.remove('hidden');
  el.confirmModal.removeAttribute('aria-hidden');
  el.confirmDeleteBtn.focus();
}

function closeConfirmModal() {
  el.confirmModal.classList.add('hidden');
  el.confirmModal.setAttribute('aria-hidden', 'true');
  state.pendingDelete = null;
}

async function handleConfirmDelete() {
  const dateStr = state.pendingDelete;
  if (!dateStr) return;

  closeConfirmModal();
  await deleteAttendance(dateStr);
}

// ============================================================
// 16. TOAST NOTIFICATION SYSTEM
// ============================================================

function showToast(message, type = 'info') {
  // type: 'success' | 'error' | 'info'
  const toast = document.createElement('div');
  toast.className       = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const iconMap = {
    success: 'ph-check-circle',
    error:   'ph-warning-octagon',
    info:    'ph-info',
  };

  toast.innerHTML = `
    <i class="ph ${iconMap[type] || 'ph-info'}" aria-hidden="true"></i>
    <span>${escapeHtml(message)}</span>
  `;

  el.toastContainer.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
  });

  // Auto dismiss after 3.5s
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3500);
}

// ============================================================
// 17. UTILITY HELPERS
// ============================================================

/**
 * Refresh dashboard, calendar (if visible), and statistics (if visible).
 * Called after any data mutation.
 */
function refreshAllViews() {
  renderDashboard();

  // Only re-render tabs if they are currently visible (saves work)
  if (!el.sections.calendar.classList.contains('hidden')) renderCalendar();
  if (!el.sections.stats.classList.contains('hidden'))    renderStatistics();
}

/**
 * Round a number to 1 decimal place: 87.499 → 87.5
 */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Get today's date as YYYY-MM-DD using LOCAL time (no UTC shift).
 */
function getTodayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format a YYYY-MM-DD date string for display: "15 September 2026"
 * Uses local string parsing to avoid UTC shift.
 */
function formatDateDisplay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

/**
 * Toggle password input visibility.
 */
function togglePasswordVisibility(inputEl, btnEl) {
  const isHidden = inputEl.type === 'password';
  inputEl.type   = isHidden ? 'text' : 'password';
  const icon     = btnEl.querySelector('i');
  if (icon) icon.className = isHidden ? 'ph ph-eye-slash' : 'ph ph-eye';
  btnEl.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
}

/**
 * Set a button's loading state.
 */
function setBtnLoading(btn, loading) {
  const label   = btn.querySelector('.btn-label');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled  = loading;
  if (label)   label.classList.toggle('hidden', loading);
  if (spinner) spinner.classList.toggle('hidden', !loading);
}

/**
 * Show a field error message.
 */
function showFieldError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideFieldError(el) {
  el.classList.add('hidden');
  el.textContent = '';
}

/**
 * Basic HTML escaping for toast messages.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// AUTH HANDLERS (using field-level error display)
// ============================================================

async function handleLogin(e) {
  if (e) e.preventDefault();
  hideFieldError(el.authError);

  const email    = el.authEmail.value.trim();
  const password = el.authPassword.value;

  if (!email || !password) {
    showFieldError(el.authError, 'Please enter both email and password.');
    return;
  }

  setBtnLoading(el.loginBtn, true);
  try {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // onAuthStateChange handles the rest
  } catch (err) {
    showFieldError(el.authError, err.message || 'Login failed. Please try again.');
  } finally {
    setBtnLoading(el.loginBtn, false);
  }
}

async function handleSignup() {
  hideFieldError(el.authError);

  const email    = el.authEmail.value.trim();
  const password = el.authPassword.value;

  if (!email || !password) {
    showFieldError(el.authError, 'Please enter both email and password.');
    return;
  }
  if (password.length < 6) {
    showFieldError(el.authError, 'Password must be at least 6 characters.');
    return;
  }

  setBtnLoading(el.signupBtn, true);
  try {
    const { error } = await db.auth.signUp({ email, password });
    if (error) throw error;
    showFieldError(el.authError, '✓ Account created! Check your email or sign in.');
    el.authError.style.color = 'var(--color-present)';
  } catch (err) {
    showFieldError(el.authError, err.message || 'Signup failed. Please try again.');
    el.authError.style.color = '';
  } finally {
    setBtnLoading(el.signupBtn, false);
  }
}

async function handleSendReset() {
  hideFieldError(el.resetError);

  const email = el.resetEmail.value.trim();
  if (!email) {
    showFieldError(el.resetError, 'Please enter your email address.');
    return;
  }

  setBtnLoading(el.sendResetBtn, true);
  try {
    const { error } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.href,
    });
    if (error) throw error;
    showFieldError(el.resetError, '✓ Check your email for the recovery link.');
    el.resetError.style.color = 'var(--color-present)';
  } catch (err) {
    showFieldError(el.resetError, err.message || 'Failed to send reset email.');
    el.resetError.style.color = '';
  } finally {
    setBtnLoading(el.sendResetBtn, false);
  }
}

async function handleUpdatePassword() {
  hideFieldError(el.updateError);

  const password = el.newPassword.value;
  if (!password || password.length < 6) {
    showFieldError(el.updateError, 'Password must be at least 6 characters.');
    return;
  }

  setBtnLoading(el.updatePasswordBtn, true);
  try {
    const { error } = await db.auth.updateUser({ password });
    if (error) throw error;
    showFieldError(el.updateError, '✓ Password updated! Redirecting…');
    el.updateError.style.color = 'var(--color-present)';
    setTimeout(() => showView('auth'), 2000);
  } catch (err) {
    showFieldError(el.updateError, err.message || 'Failed to update password.');
    el.updateError.style.color = '';
  } finally {
    setBtnLoading(el.updatePasswordBtn, false);
  }
}
