/**
 * AttendPro — Historical Attendance Import Wizard + Reset
 *
 * This module is self-contained. It relies on globals already defined
 * in script.js: db, state, DURATION, STATUS, MONTH_NAMES, MONTH_SHORT,
 * isNonWorkingDay, round1, formatDateDisplay, refreshAllViews,
 * fetchAttendanceData, showToast.
 *
 * Architecture:
 *   A. Wizard State
 *   B. Calendar / Date Helpers
 *   C. Distribution Algorithm (core math)
 *   D. Wizard UI — Step Controller
 *   E. Step 1 — Month Picker
 *   F. Step 2 — Attendance Details
 *   G. Step 3 — Review
 *   H. Step 4 — Importing
 *   I. Post-Import: Tracking Start Date
 *   J. Reset Feature
 *   K. Entry-Point Wiring
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// A. WIZARD STATE
// ─────────────────────────────────────────────────────────────

const wiz = {
  // Step 1
  selectedMonths: [],   // ['2026-04', '2026-05', ...]  YYYY-MM
  endDateStr: '',       // 'YYYY-MM-DD'

  // Step 2
  inputMethod: 'pct',  // 'pct' | 'counts'
  pctInput: '',        // string, e.g. '72.5'
  totalDaysInput: '',
  presentInput: '',    // used in 'counts' mode
  absentInput: '',     // used in 'counts' mode
  medicalInput: '',
  halfDayInput: '0',

  // Computed
  plan: null,           // result of buildDistributionPlan()
  existingCount: 0,     // how many existing records fall inside the range

  // Current step
  step: 1,              // 1 | 2 | 3 | 4
};

function wizReset() {
  wiz.selectedMonths = [];
  wiz.endDateStr = '';
  wiz.inputMethod = 'pct';
  wiz.pctInput = '';
  wiz.totalDaysInput = '';
  wiz.presentInput = '';
  wiz.absentInput = '';
  wiz.medicalInput = '';
  wiz.halfDayInput = '0';
  wiz.plan = null;
  wiz.existingCount = 0;
  wiz.step = 1;
}

// ─────────────────────────────────────────────────────────────
// B. CALENDAR / DATE HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Returns every calendar date (as 'YYYY-MM-DD') that falls within the
 * user-selected school period AND is a working day (not Sunday, not 2nd Sat).
 *
 * @param {string[]} selectedMonths  e.g. ['2026-04','2026-05']
 * @param {string}   endDateStr      'YYYY-MM-DD'
 * @returns {string[]} sorted working dates
 */
function buildWorkingDates(selectedMonths, endDateStr) {
  if (!selectedMonths.length || !endDateStr) return [];

  const dates = [];
  const sortedMonths = [...selectedMonths].sort();
  const [ey, em, ed] = endDateStr.split('-').map(Number);
  const endDate = new Date(ey, em - 1, ed);

  for (const monthKey of sortedMonths) {
    const [y, m] = monthKey.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate(); // days in this month

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = String(d).padStart(2, '0');
      const ms = String(m).padStart(2, '0');
      const dateStr = `${y}-${ms}-${ds}`;
      const candidate = new Date(y, m - 1, d);

      // Must not exceed end date
      if (candidate > endDate) continue;

      // Must be a working day
      if (!isNonWorkingDay(dateStr)) {
        dates.push(dateStr);
      }
    }
  }

  return dates;
}

/**
 * Counts working days in a range for informational display.
 */
function countWorkingDaysInRange(selectedMonths, endDateStr) {
  return buildWorkingDates(selectedMonths, endDateStr).length;
}

/**
 * Get the first date string of the selected months.
 */
function getStartDateStr(selectedMonths) {
  if (!selectedMonths.length) return '';
  const sorted = [...selectedMonths].sort();
  const [y, m] = sorted[0].split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

// ─────────────────────────────────────────────────────────────
// C. DISTRIBUTION ALGORITHM
// ─────────────────────────────────────────────────────────────

/**
 * buildDistributionPlan(opts)
 *
 * Core math: given user inputs, compute a valid set of daily records
 * that best matches the supplied attendance statistics.
 *
 * Returns a plan object describing the records to create.
 *
 * Working-day contributions:
 *   Full Present  → working=1, actual=1, official=1
 *   Half Present  → working=0.5, actual=0.5, official=0.5
 *   Full Absent   → working=1, actual=0, official=0
 *   Half Absent   → working=0.5, actual=0, official=0
 *   Full Medical  → working=1, actual=0, official=1
 *   Half Medical  → working=0.5, actual=0, official=0.5
 *
 * @param {Object} opts
 *   totalDays     {number}  school-working-day total provided by user
 *   medicalDays   {number}  medical leave days (full equivalents)
 *   halfDays      {number}  half-day records (full equivalents = halfDays*0.5)
 *   officialPct   {number}  0–100, official credited attendance percentage
 *   workingDates  {string[]} actual calendar working dates available
 * @returns {Object} plan
 */
function buildDistributionPlan(opts) {
  const { totalDays, medicalDays, halfDays, officialPct, workingDates } = opts;

  // ── 1. Resolve medical ────────────────────────────────────────────────
  // Medical provided as whole-day count. We use fullMedical records only
  // (simpler, and half-medical is rarely tracked historically).
  const fullMedical = Math.round(medicalDays);

  // ── 2. Resolve half-day allocation ───────────────────────────────────
  // We allocate half-days as Half Present records to maximise official %.
  // If the user supplied halfDays > 0 we honour it; otherwise 0.
  const halfPresentCount = Math.max(0, Math.round(halfDays));
  const halfDayValue = halfPresentCount * 0.5;

  // ── 3. Total working-day value we have to fill ───────────────────────
  // working = fullPresent + halfDayValue + fullAbsent + fullMedical
  // (halfAbsent not modelled for simplicity; user input doesn't distinguish)
  const totalWorkingValue = totalDays;
  const usedByMedical     = fullMedical;
  const usedByHalf        = halfDayValue;
  const remainingValue    = totalWorkingValue - usedByMedical - usedByHalf;

  // remainingValue must be split into fullPresent + fullAbsent
  // officialAttended = fullPresent + halfDayValue + fullMedical
  // officialPct      = officialAttended / totalDays * 100
  const officialAttendedTarget = (officialPct / 100) * totalDays;
  const presentPlusCredit      = officialAttendedTarget; // = fullPresent + halfValue + fullMedical
  const fullPresentRaw         = presentPlusCredit - halfDayValue - fullMedical;

  // Round to nearest integer (we only create whole-day records)
  let fullPresent = Math.max(0, Math.round(fullPresentRaw));
  let fullAbsent  = Math.max(0, Math.round(remainingValue - fullPresent));

  // Recompute actual totals with rounded values
  const actualWorkingDays =
    fullPresent + halfDayValue + fullAbsent + fullMedical;
  const actualOfficialAttended =
    fullPresent + halfDayValue + fullMedical;
  const generatedOfficialPct = actualWorkingDays > 0
    ? round1((actualOfficialAttended / actualWorkingDays) * 100)
    : 0;
  const generatedActualPct = actualWorkingDays > 0
    ? round1(((fullPresent + halfDayValue) / actualWorkingDays) * 100)
    : 0;

  // ── 4. Clip to available dates ────────────────────────────────────────
  // Total records to create must not exceed available working dates
  const totalRecords = fullPresent + halfPresentCount + fullAbsent + fullMedical;
  const available    = workingDates.length;
  const recordsToPlace = Math.min(totalRecords, available);

  // Scale proportionally if we exceed available dates
  let scaledPresent = fullPresent;
  let scaledHalf    = halfPresentCount;
  let scaledAbsent  = fullAbsent;
  let scaledMedical = fullMedical;

  if (totalRecords > available && totalRecords > 0) {
    const scale    = available / totalRecords;
    scaledMedical  = Math.round(fullMedical * scale);
    scaledHalf     = Math.round(halfPresentCount * scale);
    const remaining = available - scaledMedical - scaledHalf;
    const pRatio    = fullPresent / (fullPresent + fullAbsent || 1);
    scaledPresent   = Math.round(remaining * pRatio);
    scaledAbsent    = remaining - scaledPresent;
  }

  // ── 5. Build the record list ──────────────────────────────────────────
  // Create an array of {status, duration} pairs in the right quantities
  const slots = [];
  for (let i = 0; i < scaledPresent;  i++) slots.push({ status: 'present', duration: 'full' });
  for (let i = 0; i < scaledHalf;    i++) slots.push({ status: 'present', duration: 'half' });
  for (let i = 0; i < scaledAbsent;  i++) slots.push({ status: 'absent',  duration: 'full' });
  for (let i = 0; i < scaledMedical; i++) slots.push({ status: 'medical', duration: 'full' });

  // ── 6. Deterministic shuffle ──────────────────────────────────────────
  // Distribute statuses naturally across the school period.
  // Uses a seeded linear-congruential PRNG so same inputs = same output.
  const shuffled = deterministicShuffle(slots, totalDays * 1000 + medicalDays * 100 + halfDays * 10);

  // ── 7. Assign dates ───────────────────────────────────────────────────
  // Use only as many working dates as we have records
  const usedDates = workingDates.slice(0, shuffled.length);
  const records   = usedDates.map((dateStr, i) => ({
    date:     dateStr,
    status:   shuffled[i].status,
    duration: shuffled[i].duration,
    source:   'historical_import',
  }));

  return {
    records,
    // Counts for review screen
    fullPresent:   scaledPresent,
    halfPresent:   scaledHalf,
    fullAbsent:    scaledAbsent,
    halfAbsent:    0,
    fullMedical:   scaledMedical,
    halfMedical:   0,
    totalWorkingDays: actualWorkingDays,
    generatedOfficialPct,
    generatedActualPct,
    suppliedOfficialPct: round1(officialPct),
    diffPct: round1(Math.abs(generatedOfficialPct - officialPct)),
    isExactMatch: round1(generatedOfficialPct) === round1(officialPct),
    calendarDates: workingDates.length,
  };
}

/**
 * Deterministic Fisher-Yates shuffle using a seeded LCG PRNG.
 * Same seed → same output every time.
 */
function deterministicShuffle(arr, seed) {
  const result = [...arr];
  let s = Math.abs(Math.floor(seed)) || 1;
  for (let i = result.length - 1; i > 0; i--) {
    // LCG: s = (a*s + c) mod m
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// D. WIZARD UI — STEP CONTROLLER
// ─────────────────────────────────────────────────────────────

function openWizard() {
  wizReset();
  const modal = document.getElementById('import-wizard-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.removeAttribute('aria-hidden');
  renderWizardStep();
  // Focus trap: first focusable element
  requestAnimationFrame(() => {
    const first = modal.querySelector('button, input, select, [tabindex]');
    if (first) first.focus();
  });
}

function closeWizard() {
  const modal = document.getElementById('import-wizard-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  wizReset();
}

function renderWizardStep() {
  updateStepper(wiz.step);
  const body = document.getElementById('wizard-body');
  if (!body) return;
  body.innerHTML = '';
  body.style.opacity = '0';
  body.style.transform = 'translateY(8px)';

  switch (wiz.step) {
    case 1: renderStep1(body); break;
    case 2: renderStep2(body); break;
    case 3: renderStep3(body); break;
    case 4: renderStep4(body); break;
  }

  requestAnimationFrame(() => {
    body.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
    body.style.opacity    = '1';
    body.style.transform  = 'translateY(0)';
  });
}

function updateStepper(currentStep) {
  document.querySelectorAll('.wiz-step-item').forEach(el => {
    const s = parseInt(el.getAttribute('data-step'));
    el.classList.toggle('wiz-step-active',    s === currentStep);
    el.classList.toggle('wiz-step-completed', s < currentStep);
  });
}

function wizNext() {
  if (wiz.step === 1) {
    if (!validateStep1()) return;
    wiz.step = 2;
  } else if (wiz.step === 2) {
    if (!validateStep2()) return;
    buildPlan();
    wiz.step = 3;
  } else if (wiz.step === 3) {
    confirmAndImport();
    return;
  }
  renderWizardStep();
}

function wizBack() {
  if (wiz.step > 1) {
    wiz.step--;
    renderWizardStep();
  } else {
    closeWizard();
  }
}

// ─────────────────────────────────────────────────────────────
// E. STEP 1 — MONTH PICKER + END DATE
// ─────────────────────────────────────────────────────────────

function renderStep1(body) {
  const today    = new Date();
  const thisYear = today.getFullYear();

  // Build available months: up to and including the current month (past only)
  const months = [];
  // Offer the 18 months up to today so it covers a full academic year
  for (let i = 17; i >= 0; i--) {
    const d   = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ key, label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` });
  }

  body.innerHTML = `
    <div class="wiz-section-title">Which months had school?</div>
    <p class="wiz-hint">Select all months that were part of your school period.</p>

    <div class="month-picker-grid" role="group" aria-label="Select school months">
      ${months.map(({ key, label }) => {
        const checked = wiz.selectedMonths.includes(key);
        return `
          <button
            type="button"
            class="month-pill${checked ? ' selected' : ''}"
            data-month="${key}"
            aria-pressed="${checked}"
            aria-label="${label}"
          >${label}</button>`;
      }).join('')}
    </div>

    <div id="step1-end-date-section" class="${wiz.selectedMonths.length ? '' : 'hidden'}">
      <div class="wiz-section-title" style="margin-top:24px;">
        Last date covered by your current attendance
      </div>
      <p class="wiz-hint">Select the exact date your current attendance percentage covers up to.</p>

      <div class="wiz-input-row">
        <label for="wiz-end-date" class="wiz-label">End date</label>
        <input
          type="date"
          id="wiz-end-date"
          class="wiz-input"
          max="${today.toISOString().split('T')[0]}"
          value="${wiz.endDateStr}"
          aria-label="Historical attendance end date"
        >
      </div>

      <div id="step1-range-summary" class="wiz-range-summary"></div>
    </div>

    <div id="step1-error" class="wiz-error hidden" role="alert"></div>

    <div class="wiz-btn-row">
      <button class="wiz-btn-secondary" id="wiz-cancel-btn">Cancel</button>
      <button class="wiz-btn-primary" id="wiz-next-btn">
        Continue <i class="ph ph-arrow-right"></i>
      </button>
    </div>`;

  // Month pill toggle
  body.querySelectorAll('.month-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-month');
      const idx = wiz.selectedMonths.indexOf(key);
      if (idx > -1) {
        wiz.selectedMonths.splice(idx, 1);
        btn.classList.remove('selected');
        btn.setAttribute('aria-pressed', 'false');
      } else {
        wiz.selectedMonths.push(key);
        btn.classList.add('selected');
        btn.setAttribute('aria-pressed', 'true');
      }
      const section = document.getElementById('step1-end-date-section');
      if (section) section.classList.toggle('hidden', wiz.selectedMonths.length === 0);
      updateStep1Summary();
    });
  });

  // End-date input
  body.querySelector('#wiz-end-date')?.addEventListener('change', e => {
    wiz.endDateStr = e.target.value;
    updateStep1Summary();
  });

  body.querySelector('#wiz-next-btn')?.addEventListener('click', wizNext);
  body.querySelector('#wiz-cancel-btn')?.addEventListener('click', closeWizard);

  if (wiz.selectedMonths.length) updateStep1Summary();
}

function updateStep1Summary() {
  const summary = document.getElementById('step1-range-summary');
  if (!summary) return;

  if (!wiz.selectedMonths.length || !wiz.endDateStr) {
    summary.innerHTML = '';
    return;
  }

  const startStr  = getStartDateStr(wiz.selectedMonths);
  const workDays  = countWorkingDaysInRange(wiz.selectedMonths, wiz.endDateStr);
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = wiz.endDateStr.split('-').map(Number);

  summary.innerHTML = `
    <div class="wiz-range-card">
      <div class="wiz-range-row">
        <span class="wiz-range-label">Period</span>
        <span class="wiz-range-value">
          ${MONTH_NAMES[sm-1]} ${sd}, ${sy}
          &nbsp;→&nbsp;
          ${MONTH_NAMES[em-1]} ${ed}, ${ey}
        </span>
      </div>
      <div class="wiz-range-row">
        <span class="wiz-range-label">Working days in range</span>
        <span class="wiz-range-value"><strong>${workDays}</strong>
          <span class="wiz-range-note">(Sundays &amp; 2nd Saturdays excluded)</span>
        </span>
      </div>
    </div>`;
}

function validateStep1() {
  const errEl = document.getElementById('step1-error');
  const hide  = () => errEl?.classList.add('hidden');
  const show  = msg => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };

  if (!wiz.selectedMonths.length) { show('Please select at least one school month.'); return false; }
  if (!wiz.endDateStr)            { show('Please select the attendance end date.'); return false; }

  const startStr = getStartDateStr(wiz.selectedMonths);
  if (wiz.endDateStr < startStr) { show('End date cannot be before the first selected month.'); return false; }

  const today = new Date();
  const [ey, em, ed] = wiz.endDateStr.split('-').map(Number);
  if (new Date(ey, em-1, ed) > today) { show('End date cannot be in the future.'); return false; }

  const workDays = countWorkingDaysInRange(wiz.selectedMonths, wiz.endDateStr);
  if (workDays === 0) { show('No working days found in the selected period.'); return false; }

  hide();
  return true;
}

// ─────────────────────────────────────────────────────────────
// F. STEP 2 — ATTENDANCE DETAILS
// ─────────────────────────────────────────────────────────────

function renderStep2(body) {
  const workDays = countWorkingDaysInRange(wiz.selectedMonths, wiz.endDateStr);

  body.innerHTML = `
    <div class="wiz-section-title">Enter your attendance details</div>
    <p class="wiz-hint">
      School period: <strong>${workDays} working days</strong> in the selected range.
      Your school may have counted fewer days — enter what your school reported.
    </p>

    <!-- Method toggle -->
    <div class="wiz-method-toggle" role="group" aria-label="Input method">
      <button type="button" class="wiz-method-btn${wiz.inputMethod === 'pct' ? ' active' : ''}"
        id="method-pct" aria-pressed="${wiz.inputMethod === 'pct'}">
        I know my attendance %
      </button>
      <button type="button" class="wiz-method-btn${wiz.inputMethod === 'counts' ? ' active' : ''}"
        id="method-counts" aria-pressed="${wiz.inputMethod === 'counts'}">
        I know my day counts
      </button>
    </div>

    <div id="pct-section" class="${wiz.inputMethod === 'pct' ? '' : 'hidden'}">
      <div class="wiz-field">
        <label for="wiz-pct" class="wiz-label">
          Official Attendance Percentage <span class="wiz-required">*</span>
        </label>
        <div class="wiz-input-with-unit">
          <input type="number" id="wiz-pct" class="wiz-input" min="0" max="100" step="0.1"
            placeholder="e.g. 72.5" value="${wiz.pctInput}" aria-label="Attendance percentage">
          <span class="wiz-unit">%</span>
        </div>
        <p class="wiz-field-hint">The official percentage shown on your school report.</p>
      </div>
    </div>

    <div id="counts-section" class="${wiz.inputMethod === 'counts' ? '' : 'hidden'}">
      <div class="wiz-field-row">
        <div class="wiz-field">
          <label for="wiz-present" class="wiz-label">Days Present <span class="wiz-required">*</span></label>
          <input type="number" id="wiz-present" class="wiz-input" min="0" step="1"
            placeholder="e.g. 52" value="${wiz.presentInput}">
        </div>
        <div class="wiz-field">
          <label for="wiz-absent" class="wiz-label">Days Absent</label>
          <input type="number" id="wiz-absent" class="wiz-input" min="0" step="1"
            placeholder="e.g. 25" value="${wiz.absentInput}">
        </div>
      </div>
    </div>

    <!-- Common fields -->
    <div class="wiz-field">
      <label for="wiz-total" class="wiz-label">
        Total School Days <span class="wiz-required">*</span>
      </label>
      <input type="number" id="wiz-total" class="wiz-input" min="1" step="0.5"
        placeholder="e.g. 90" value="${wiz.totalDaysInput}"
        aria-label="Total school working days">
      <p class="wiz-field-hint">
        The number of working days your school counted
        (${workDays} days in the selected calendar range — adjust if your school counted differently).
      </p>
    </div>

    <div class="wiz-field">
      <label for="wiz-medical" class="wiz-label">Medical Leave Days</label>
      <input type="number" id="wiz-medical" class="wiz-input" min="0" step="1"
        placeholder="0" value="${wiz.medicalInput}"
        aria-label="Medical leave days">
      <p class="wiz-field-hint">
        Medical Leave is credited as Present in your school's official attendance calculation.
      </p>
    </div>

    <div class="wiz-field">
      <label for="wiz-half" class="wiz-label">Half Days <span class="wiz-optional">(optional)</span></label>
      <input type="number" id="wiz-half" class="wiz-input" min="0" step="1"
        placeholder="0" value="${wiz.halfDayInput}"
        aria-label="Half day count">
      <p class="wiz-field-hint">Leave as 0 if you don't know.</p>
    </div>

    <div id="step2-preview" class="wiz-preview-card hidden"></div>
    <div id="step2-error" class="wiz-error hidden" role="alert"></div>

    <div class="wiz-btn-row">
      <button class="wiz-btn-secondary" id="wiz-back-btn">
        <i class="ph ph-arrow-left"></i> Back
      </button>
      <button class="wiz-btn-primary" id="wiz-next-btn">
        Review <i class="ph ph-arrow-right"></i>
      </button>
    </div>`;

  // Method toggle
  ['pct','counts'].forEach(m => {
    body.querySelector(`#method-${m}`)?.addEventListener('click', () => {
      wiz.inputMethod = m;
      body.querySelector('#pct-section').classList.toggle('hidden', m !== 'pct');
      body.querySelector('#counts-section').classList.toggle('hidden', m !== 'counts');
      body.querySelectorAll('.wiz-method-btn').forEach(b => {
        b.classList.toggle('active', b.id === `method-${m}`);
        b.setAttribute('aria-pressed', String(b.id === `method-${m}`));
      });
    });
  });

  // Live preview
  const updatePreview = () => {
    saveStep2Inputs(body);
    const preview = document.getElementById('step2-preview');
    if (!preview) return;
    const v = getStep2Values();
    if (!v) { preview.classList.add('hidden'); return; }
    const credited = round1(v.officialPct / 100 * v.total);
    preview.classList.remove('hidden');
    preview.innerHTML = `
      <div class="wiz-preview-title">Live calculation</div>
      <div class="wiz-preview-row">
        <span>Credited attendance</span>
        <strong>${credited} days</strong>
      </div>
      <div class="wiz-preview-row">
        <span>Official %</span>
        <strong>${round1(v.officialPct)}%</strong>
      </div>
      <div class="wiz-preview-row">
        <span>Medical (credited as Present)</span>
        <strong>${v.medical} days</strong>
      </div>`;
  };

  body.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updatePreview));
  body.querySelector('#wiz-next-btn')?.addEventListener('click', wizNext);
  body.querySelector('#wiz-back-btn')?.addEventListener('click', wizBack);

  updatePreview();
}

/** Read current step-2 form values and store in wiz. */
function saveStep2Inputs(body) {
  if (!body) return;
  const g = id => (body.querySelector(`#${id}`) || {}).value || '';
  wiz.pctInput        = g('wiz-pct');
  wiz.totalDaysInput  = g('wiz-total');
  wiz.medicalInput    = g('wiz-medical');
  wiz.halfDayInput    = g('wiz-half') || '0';
  wiz.presentInput    = g('wiz-present');
  wiz.absentInput     = g('wiz-absent');
}

/**
 * Returns {total, medical, halfDays, officialPct} or null if invalid.
 */
function getStep2Values() {
  const total   = parseFloat(wiz.totalDaysInput);
  const medical = parseFloat(wiz.medicalInput || '0');
  const halfDay = parseFloat(wiz.halfDayInput  || '0');
  if (isNaN(total) || total <= 0) return null;

  let officialPct;
  if (wiz.inputMethod === 'pct') {
    officialPct = parseFloat(wiz.pctInput);
    if (isNaN(officialPct)) return null;
  } else {
    const present = parseFloat(wiz.presentInput || '0');
    if (isNaN(present)) return null;
    // Official % = (present + medical + halfDay*0.5) / total * 100
    const credited = present + medical + (halfDay * 0.5);
    officialPct = total > 0 ? (credited / total) * 100 : 0;
  }

  return { total, medical, halfDays: halfDay, officialPct };
}

function validateStep2() {
  const body  = document.getElementById('wizard-body');
  saveStep2Inputs(body);

  const errEl = document.getElementById('step2-error');
  const show  = msg => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
  const hide  = ()  => errEl?.classList.add('hidden');

  const total   = parseFloat(wiz.totalDaysInput);
  const medical = parseFloat(wiz.medicalInput || '0');
  const half    = parseFloat(wiz.halfDayInput  || '0');

  if (isNaN(total) || total <= 0)  { show('Please enter a valid total school days count.'); return false; }
  if (isNaN(medical) || medical < 0) { show('Medical leave cannot be negative.'); return false; }
  if (medical > total)             { show('Medical leave cannot exceed total school days.'); return false; }
  if (isNaN(half) || half < 0)    { show('Half days cannot be negative.'); return false; }
  if (half > total)                { show('Half days cannot exceed total school days.'); return false; }

  if (wiz.inputMethod === 'pct') {
    const pct = parseFloat(wiz.pctInput);
    if (isNaN(pct) || pct < 0 || pct > 100) { show('Attendance percentage must be between 0 and 100.'); return false; }
  } else {
    const present = parseFloat(wiz.presentInput || '0');
    const absent  = parseFloat(wiz.absentInput  || '0');
    if (isNaN(present) || present < 0) { show('Present days cannot be negative.'); return false; }
    if (present + absent + medical + (half * 0.5) > total + 1) {
      show('Present + Absent + Medical exceeds the total school days you entered.'); return false;
    }
  }

  hide();
  return true;
}

// ─────────────────────────────────────────────────────────────
// G. STEP 3 — REVIEW
// ─────────────────────────────────────────────────────────────

function buildPlan() {
  const v = getStep2Values();
  if (!v) return;
  const workingDates = buildWorkingDates(wiz.selectedMonths, wiz.endDateStr);

  wiz.plan = buildDistributionPlan({
    totalDays:   v.total,
    medicalDays: v.medical,
    halfDays:    v.halfDays,
    officialPct: v.officialPct,
    workingDates,
  });

  // Count existing records in range
  const startStr = getStartDateStr(wiz.selectedMonths);
  wiz.existingCount = (state?.attendanceData || [])
    .filter(r => r.date >= startStr && r.date <= wiz.endDateStr).length;
}

function renderStep3(body) {
  const plan = wiz.plan;
  if (!plan) { wizBack(); return; }

  const startStr  = getStartDateStr(wiz.selectedMonths);
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = wiz.endDateStr.split('-').map(Number);

  const matchIcon  = plan.isExactMatch ? '✓ Exact match' : `⚠ Closest match (${plan.diffPct} pp off)`;
  const matchClass = plan.isExactMatch ? 'wiz-match-exact' : 'wiz-match-approx';

  body.innerHTML = `
    <div class="wiz-section-title">Review Historical Attendance</div>
    <p class="wiz-hint">Check the details below before importing.</p>

    <div class="wiz-review-card">
      <div class="wiz-review-row">
        <span class="wiz-review-label">Attendance period</span>
        <span class="wiz-review-value">
          ${MONTH_NAMES[sm-1]} ${sd}, ${sy} → ${MONTH_NAMES[em-1]} ${ed}, ${ey}
        </span>
      </div>
      <div class="wiz-review-row">
        <span class="wiz-review-label">School days (entered)</span>
        <span class="wiz-review-value">${round1(plan.totalWorkingDays)}</span>
      </div>
      <div class="wiz-review-row">
        <span class="wiz-review-label">Calendar working days</span>
        <span class="wiz-review-value">${plan.calendarDates}</span>
      </div>
      <div class="wiz-review-divider"></div>
      <div class="wiz-review-row">
        <span class="wiz-review-label">Full Day Present</span>
        <span class="wiz-review-value wiz-val-present">${plan.fullPresent}</span>
      </div>
      <div class="wiz-review-row">
        <span class="wiz-review-label">Half Day Present</span>
        <span class="wiz-review-value wiz-val-present">${plan.halfPresent}</span>
      </div>
      <div class="wiz-review-row">
        <span class="wiz-review-label">Full Day Absent</span>
        <span class="wiz-review-value wiz-val-absent">${plan.fullAbsent}</span>
      </div>
      <div class="wiz-review-row">
        <span class="wiz-review-label">Full Day Medical Leave</span>
        <span class="wiz-review-value wiz-val-medical">${plan.fullMedical}</span>
      </div>
      <div class="wiz-review-divider"></div>
      <div class="wiz-review-row wiz-review-highlight">
        <span class="wiz-review-label">Official Attendance (generated)</span>
        <span class="wiz-review-value">${plan.generatedOfficialPct}%</span>
      </div>
      <div class="wiz-review-row">
        <span class="wiz-review-label">Official Attendance (you entered)</span>
        <span class="wiz-review-value">${plan.suppliedOfficialPct}%</span>
      </div>
      <div class="wiz-review-row">
        <span class="wiz-review-label">Match</span>
        <span class="wiz-review-value ${matchClass}">${matchIcon}</span>
      </div>
      <div class="wiz-review-row">
        <span class="wiz-review-label">Records to create</span>
        <span class="wiz-review-value">${plan.records.length}</span>
      </div>
    </div>

    ${!plan.isExactMatch ? `
    <div class="wiz-notice wiz-notice-warn">
      <i class="ph ph-warning" aria-hidden="true"></i>
      <span>
        An exact match isn't possible with whole/half days.
        The generated calendar will show <strong>${plan.generatedOfficialPct}%</strong>.
        Your school-reported figure of <strong>${plan.suppliedOfficialPct}%</strong>
        is preserved in the historical summary.
      </span>
    </div>` : ''}

    ${wiz.existingCount > 0 ? `
    <div class="wiz-notice wiz-notice-info">
      <i class="ph ph-info" aria-hidden="true"></i>
      <span>
        <strong>${wiz.existingCount} existing attendance record${wiz.existingCount !== 1 ? 's' : ''}</strong>
        found in this period. They will be replaced.
      </span>
    </div>` : ''}

    <p class="wiz-footnote">
      <i class="ph ph-info-circle" aria-hidden="true"></i>
      Historical records are reconstructed estimates based on your overall attendance figure.
    </p>

    <div class="wiz-btn-row">
      <button class="wiz-btn-secondary" id="wiz-back-btn">
        <i class="ph ph-arrow-left"></i> Back
      </button>
      <button class="wiz-btn-primary" id="wiz-import-btn">
        <span class="btn-label">Import Attendance</span>
        <span class="btn-spinner hidden" aria-hidden="true">
          <i class="ph ph-spinner" style="animation:spin 0.75s linear infinite"></i>
        </span>
      </button>
    </div>`;

  body.querySelector('#wiz-back-btn')?.addEventListener('click', wizBack);
  body.querySelector('#wiz-import-btn')?.addEventListener('click', wizNext);
}

// ─────────────────────────────────────────────────────────────
// H. STEP 4 — IMPORT EXECUTION
// ─────────────────────────────────────────────────────────────

async function confirmAndImport() {
  const plan    = wiz.plan;
  const importBtn = document.getElementById('wiz-import-btn');
  if (!plan || !state.currentUser) return;

  // Disable button, show spinner
  if (importBtn) {
    importBtn.disabled = true;
    importBtn.querySelector('.btn-label')?.classList.add('hidden');
    importBtn.querySelector('.btn-spinner')?.classList.remove('hidden');
  }

  try {
    const userId    = state.currentUser.id;
    const startStr  = getStartDateStr(wiz.selectedMonths);

    // 1. Delete existing records in the range (safe — scoped to user)
    const { error: delError } = await db
      .from('attendance')
      .delete()
      .eq('user_id', userId)
      .gte('date', startStr)
      .lte('date', wiz.endDateStr);

    if (delError) throw delError;

    // 2. Batch insert new records
    const rows = plan.records.map(r => ({
      user_id:  userId,
      date:     r.date,
      status:   r.status,
      duration: r.duration,
      source:   'historical_import',
    }));

    // Insert in chunks of 200 to avoid payload limits
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error: insError } = await db
        .from('attendance')
        .upsert(rows.slice(i, i + CHUNK), { onConflict: 'user_id,date' });
      if (insError) throw insError;
    }

    // 3. Save historical summary (best-effort — may fail if table not created yet)
    const v = getStep2Values();
    if (v) {
      await db.from('historical_summary').upsert({
        user_id:             userId,
        start_date:          startStr,
        end_date:            wiz.endDateStr,
        reported_attendance: round1(v.officialPct),
        total_school_days:   v.total,
        medical_leave_days:  v.medical,
        source:              'historical_import',
      }, { onConflict: 'user_id' }).then(() => {}).catch(() => {});
      // Silently ignore if historical_summary table doesn't exist yet
    }

    // 4. Refresh app state
    await fetchAttendanceData();

    // 5. Show step 4 (post-import)
    wiz.step = 4;
    renderWizardStep();

  } catch (err) {
    console.error('[AttendPro] Import error:', err);
    if (importBtn) {
      importBtn.disabled = false;
      importBtn.querySelector('.btn-label')?.classList.remove('hidden');
      importBtn.querySelector('.btn-spinner')?.classList.add('hidden');
    }
    const body = document.getElementById('wizard-body');
    const existing = body?.querySelector('#import-error');
    if (body && !existing) {
      const errDiv = document.createElement('div');
      errDiv.id        = 'import-error';
      errDiv.className = 'wiz-error';
      errDiv.textContent = `Import failed: ${err.message || 'Unknown error. Please try again.'}`;
      body.insertBefore(errDiv, body.querySelector('.wiz-btn-row'));
    }
  }
}

function renderStep4(body) {
  const plan     = wiz.plan;
  const endStr   = wiz.endDateStr;

  // Default next-tracking date = day after end date
  const [ey, em, ed] = endStr.split('-').map(Number);
  const nextDay  = new Date(ey, em - 1, ed + 1);
  const nextStr  = `${nextDay.getFullYear()}-${String(nextDay.getMonth()+1).padStart(2,'0')}-${String(nextDay.getDate()).padStart(2,'0')}`;
  const nextFmt  = `${MONTH_NAMES[nextDay.getMonth()]} ${nextDay.getDate()}, ${nextDay.getFullYear()}`;
  const today    = new Date();
  const maxDate  = today.toISOString().split('T')[0];

  body.innerHTML = `
    <div class="wiz-success-icon" aria-hidden="true">
      <i class="ph ph-check-circle"></i>
    </div>
    <div class="wiz-section-title" style="text-align:center">
      Historical attendance imported!
    </div>
    <p class="wiz-hint" style="text-align:center">
      ${plan?.records.length || 0} records were created covering your historical period.
    </p>

    <div class="wiz-review-card" style="margin-top:20px">
      <div class="wiz-review-row">
        <span class="wiz-review-label">Historical period</span>
        <span class="wiz-review-value">→ ${MONTH_NAMES[em-1]} ${ed}, ${ey}</span>
      </div>
      <div class="wiz-review-row wiz-review-highlight">
        <span class="wiz-review-label">Official Attendance</span>
        <span class="wiz-review-value">${plan?.generatedOfficialPct ?? '—'}%</span>
      </div>
    </div>

    <div class="wiz-tracking-section">
      <div class="wiz-section-title" style="margin-top:24px">
        Start daily tracking from which date?
      </div>
      <p class="wiz-hint">
        From this date onward, mark attendance manually every day.
      </p>
      <div class="wiz-input-row">
        <label for="wiz-track-start" class="wiz-label">Start tracking date</label>
        <input
          type="date"
          id="wiz-track-start"
          class="wiz-input"
          value="${nextStr}"
          max="${maxDate}"
          aria-label="Start tracking from date"
        >
      </div>
      <p class="wiz-field-hint" id="track-start-hint">
        From <strong>${nextFmt}</strong> onward, mark attendance normally.
      </p>
    </div>

    <div class="wiz-btn-row" style="justify-content:center">
      <button class="wiz-btn-primary" id="wiz-done-btn" style="min-width:160px">
        Start Tracking
      </button>
    </div>`;

  body.querySelector('#wiz-track-start')?.addEventListener('change', e => {
    const [ty, tm, td] = e.target.value.split('-').map(Number);
    const hint = document.getElementById('track-start-hint');
    if (hint && ty) {
      hint.innerHTML = `From <strong>${MONTH_NAMES[tm-1]} ${td}, ${ty}</strong> onward, mark attendance normally.`;
    }
  });

  body.querySelector('#wiz-done-btn')?.addEventListener('click', () => {
    closeWizard();
    showToast('✅ Historical attendance imported. Start marking from today!', 'success');
    // Navigate to dashboard
    if (typeof navigateTo === 'function') navigateTo('dashboard');
  });
}

// ─────────────────────────────────────────────────────────────
// I. RESET FEATURE
// ─────────────────────────────────────────────────────────────

function openResetModal() {
  const modal = document.getElementById('reset-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.removeAttribute('aria-hidden');
  // Reset the type-to-confirm input
  const input = document.getElementById('reset-confirm-input');
  if (input) { input.value = ''; }
  const btn = document.getElementById('reset-execute-btn');
  if (btn) { btn.disabled = true; }
  requestAnimationFrame(() => {
    const first = modal.querySelector('button, input');
    if (first) first.focus();
  });
}

function closeResetModal() {
  const modal = document.getElementById('reset-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

async function executeReset() {
  const btn = document.getElementById('reset-execute-btn');
  if (!state.currentUser) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner" style="animation:spin 0.75s linear infinite"></i> Deleting…';
  }

  try {
    // Delete ALL attendance for this user only
    const { error } = await db
      .from('attendance')
      .delete()
      .eq('user_id', state.currentUser.id);

    if (error) throw error;

    // Also clear historical_summary if it exists
    await db.from('historical_summary')
      .delete()
      .eq('user_id', state.currentUser.id)
      .then(() => {}).catch(() => {});

    // Clear local state
    state.attendanceData = [];
    // Reset to loading state briefly so renderDashboard can show empty-state cleanly
    if (typeof showDashboardLoading === 'function') {
      showDashboardLoading();
      // showDashboardContent will be called by refreshAllViews → renderDashboard flow
      // but we need to transition through loading first, then immediately show content
      setTimeout(() => {
        if (typeof showDashboardContent === 'function') showDashboardContent();
        refreshAllViews();
      }, 0);
    } else {
      refreshAllViews();
    }
    closeResetModal();
    showToast('🗑️ Attendance data reset successfully.', 'info');

  } catch (err) {
    console.error('[AttendPro] Reset error:', err);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Reset All Attendance';
    }
    showToast('Reset failed. Please try again.', 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// K. ENTRY-POINT WIRING (called once DOM is ready)
// ─────────────────────────────────────────────────────────────

function initImportWizard() {
  // Wizard open buttons
  document.querySelectorAll('[data-action="open-wizard"]').forEach(btn => {
    btn.addEventListener('click', openWizard);
  });

  // Wizard modal close
  document.getElementById('wizard-close-btn')?.addEventListener('click', closeWizard);
  document.getElementById('wizard-backdrop')?.addEventListener('click', closeWizard);

  // Reset modal open
  document.querySelectorAll('[data-action="open-reset"]').forEach(btn => {
    btn.addEventListener('click', openResetModal);
  });

  // Reset modal close
  document.getElementById('reset-cancel-btn')?.addEventListener('click', closeResetModal);
  document.getElementById('reset-backdrop')?.addEventListener('click', closeResetModal);

  // Type-to-confirm input
  document.getElementById('reset-confirm-input')?.addEventListener('input', e => {
    const btn = document.getElementById('reset-execute-btn');
    if (btn) btn.disabled = e.target.value.trim().toUpperCase() !== 'RESET';
  });

  // Execute reset
  document.getElementById('reset-execute-btn')?.addEventListener('click', executeReset);

  // ESC key closes wizard and reset modal
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const wm = document.getElementById('import-wizard-modal');
    if (wm && !wm.classList.contains('hidden')) { closeWizard(); return; }
    const rm = document.getElementById('reset-modal');
    if (rm && !rm.classList.contains('hidden')) { closeResetModal(); }
  });
}

// Auto-init once DOM is ready (import.js is loaded after script.js)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initImportWizard);
} else {
  initImportWizard();
}
