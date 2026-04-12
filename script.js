/**
 * Smart Attendance Tracker
 * Premium SaaS Style Application Logic
 */

// ==========================================
// 1. SUPABASE CONFIGURATION
// ==========================================
// ⚠️ REPLACE THESE WITH YOUR ACTUAL SUPABASE PROJECT CREDENTIALS
const supabaseUrl = 'https://rounltiateeimeersgzc.supabase.co';
const supabaseKey = 'sb_publishable_6833UTzjlxNrNuz0hCYgcA_Zxaj-bKR';
const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

// ==========================================
// 2. STATE MANAGEMENT
// ==========================================
let currentUser = null;
let currentMonth = new Date();
let attendanceData = []; // Array of { id, user_id, date, status }
let chartInstance = null;

// ==========================================
// 3. DOM ELEMENTS
// ==========================================
// Views
const authView = document.getElementById('auth-view');
const appView = document.getElementById('app-view');
const resetPasswordView = document.getElementById('reset-password-view');
const updatePasswordView = document.getElementById('update-password-view');
const sections = {
  dashboard: document.getElementById('dashboard'),
  calendar: document.getElementById('calendar'),
  stats: document.getElementById('stats')
};

// Auth Elements
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authError = document.getElementById('auth-error');
const loginBtn = document.getElementById('login-btn');
const signupBtn = document.getElementById('signup-btn');
const logoutBtn = document.getElementById('logout-btn');
const forgotPasswordBtn = document.getElementById('forgot-password-btn');
const backToLoginBtn = document.getElementById('back-to-login-btn');
const sendResetBtn = document.getElementById('send-reset-btn');
const updatePasswordBtn = document.getElementById('update-password-btn');
const resetEmail = document.getElementById('reset-email');
const newPassword = document.getElementById('new-password');
const resetError = document.getElementById('reset-error');
const updateError = document.getElementById('update-error');

// Navigation & Theme
const navItems = document.querySelectorAll('.nav-item[data-target]');
const pageTitle = document.getElementById('page-title');
const userGreeting = document.getElementById('user-greeting');
const themeToggle = document.getElementById('theme-toggle');
const mobileToggle = document.getElementById('mobile-toggle');
const sidebar = document.querySelector('.sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

// Dashboard Elements
const dashTotal = document.getElementById('dash-totaldays');
const dashPresent = document.getElementById('dash-present');
const dashAbsent = document.getElementById('dash-absent');
const dashHolidays = document.getElementById('dash-holidays');
const circularProgress = document.getElementById('circular-progress');
const progressText = document.getElementById('progress-text');
const attendanceBadge = document.getElementById('attendance-badge');
const predictorContent = document.getElementById('predictor-content');

// Calendar Elements
const calendarGrid = document.getElementById('calendar-days');
const calendarMonthYear = document.getElementById('calendar-month-year');
const prevMonthBtn = document.getElementById('prev-month');
const nextMonthBtn = document.getElementById('next-month');

// Modal Elements
const modal = document.getElementById('status-modal');
const modalDateText = document.getElementById('modal-date-text');
const closeModalBtn = document.getElementById('close-modal');
const statusBtns = document.querySelectorAll('.status-btn');
let selectedModalDate = null; // Store the date being edited in format YYYY-MM-DD

// ==========================================
// 4. INITIALIZATION & AUTHENTICATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  checkSession();
  setupEventListeners();
});

function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.body.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
}

function updateThemeIcon(theme) {
  const icon = themeToggle.querySelector('i');
  if (theme === 'dark') {
    icon.className = 'ph ph-sun';
    themeToggle.querySelector('span').textContent = 'Light Mode';
  } else {
    icon.className = 'ph ph-moon';
    themeToggle.querySelector('span').textContent = 'Dark Mode';
  }
}

themeToggle.addEventListener('click', () => {
  const currentTheme = document.body.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  updateThemeIcon(newTheme);
});

async function checkSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    handleLogin(session.user);
  } else {
    showAuthView();
  }
}

// Listen for auth state changes
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    showUpdatePasswordView();
  } else if (event === 'SIGNED_IN') {
    handleLogin(session.user);
  } else if (event === 'SIGNED_OUT') {
    showAuthView();
  }
});

function showAuthView() {
  authView.classList.remove('hidden');
  appView.classList.add('hidden');
  resetPasswordView.classList.add('hidden');
  updatePasswordView.classList.add('hidden');
  currentUser = null;
}

function showResetPasswordView() {
  authView.classList.add('hidden');
  resetPasswordView.classList.remove('hidden');
  updatePasswordView.classList.add('hidden');
}

function showUpdatePasswordView() {
  authView.classList.add('hidden');
  appView.classList.add('hidden');
  resetPasswordView.classList.add('hidden');
  updatePasswordView.classList.remove('hidden');
}

function handleLogin(user) {
  currentUser = user;
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
  resetPasswordView.classList.add('hidden');
  updatePasswordView.classList.add('hidden');

  // Set greeting
  const emailName = user.email.split('@')[0];
  userGreeting.textContent = `Hello, ${emailName}`;

  // Initial data fetch
  fetchAttendanceData();
}

function showMessage(el, msg, isSuccess = false) {
  el.textContent = msg;
  el.style.color = isSuccess ? "var(--present-color)" : "var(--absent-color)";
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ==========================================
// 5. EVENT LISTENERS
// ==========================================
function setupEventListeners() {
  // Auth
  loginBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!authEmail.value || !authPassword.value) {
      showMessage(authError, 'Please enter both email and password.');
      return;
    }
    loginBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Loading...';
    try {
      const { error } = await supabaseClient.auth.signInWithPassword({
        email: authEmail.value,
        password: authPassword.value,
      });
      if (error) throw error;
    } catch (err) {
      showMessage(authError, err.message);
    } finally {
      loginBtn.innerHTML = 'Login';
    }
  });

  signupBtn.addEventListener('click', async () => {
    if (!authEmail.value || !authPassword.value) {
      showMessage(authError, 'Please enter both email and password.');
      return;
    }
    signupBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Wait...';
    try {
      const { error } = await supabaseClient.auth.signUp({
        email: authEmail.value,
        password: authPassword.value,
      });
      if (error) throw error;
      showMessage(authError, "Signup successful! Please check email or login.", true);
    } catch (err) {
      showMessage(authError, err.message);
    } finally {
      signupBtn.innerHTML = 'Create Account';
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
  });

  forgotPasswordBtn.addEventListener('click', () => {
    showResetPasswordView();
  });

  backToLoginBtn.addEventListener('click', () => {
    showAuthView();
  });

  sendResetBtn.addEventListener('click', async () => {
    if (!resetEmail.value) {
      showMessage(resetError, 'Please enter your email.');
      return;
    }
    sendResetBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Wait...';
    try {
      const { error } = await supabaseClient.auth.resetPasswordForEmail(resetEmail.value, {
        redirectTo: window.location.href
      });
      if (error) throw error;
      showMessage(resetError, "Check your email for the reset link!", true);
    } catch (err) {
      showMessage(resetError, err.message);
    } finally {
      sendResetBtn.innerHTML = 'Send Link';
    }
  });

  updatePasswordBtn.addEventListener('click', async () => {
    if (!newPassword.value || newPassword.value.length < 6) {
      showMessage(updateError, 'Password must be at least 6 characters.');
      return;
    }
    updatePasswordBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Wait...';
    try {
      const { error } = await supabaseClient.auth.updateUser({ password: newPassword.value });
      if (error) throw error;
      showMessage(updateError, "Password updated successfully!", true);
      setTimeout(() => { showAuthView(); }, 2000);
    } catch (err) {
      showMessage(updateError, err.message);
    } finally {
      updatePasswordBtn.innerHTML = 'Update Password';
    }
  });

  // Navigation
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(ni => ni.classList.remove('active'));
      item.classList.add('active');

      const target = item.getAttribute('data-target');
      pageTitle.textContent = item.querySelector('span').textContent;

      Object.keys(sections).forEach(key => sections[key].classList.add('hidden'));
      sections[target].classList.remove('hidden');

      // Refresh specific views
      if (target === 'calendar') renderCalendar();
      if (target === 'stats') renderStats();

      // Close sidebar on mobile
      if (window.innerWidth <= 768) {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
      }
    });
  });

  // Mobile Menu Toggle
  if(mobileToggle) {
    mobileToggle.addEventListener('click', () => {
      sidebar.classList.add('open');
      sidebarOverlay.classList.add('active');
    });
  }

  if(sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      sidebarOverlay.classList.remove('active');
    });
  }

  // Calendar Navigation
  prevMonthBtn.addEventListener('click', () => {
    currentMonth.setMonth(currentMonth.getMonth() - 1);
    renderCalendar();
  });

  nextMonthBtn.addEventListener('click', () => {
    currentMonth.setMonth(currentMonth.getMonth() + 1);
    renderCalendar();
  });

  // Modal actions
  closeModalBtn.addEventListener('click', hideModal);

  statusBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = btn.getAttribute('data-status');
      await updateAttendance(selectedModalDate, status);
      hideModal();
    });
  });
}

// ==========================================
// 6. DB OPERATIONS & DATA PROCESSING
// ==========================================
async function fetchAttendanceData() {
  if (!currentUser) return;

  try {
    const { data, error } = await supabaseClient
      .from('attendance')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('date', { ascending: true });

    if (error) {
      if (error.code === '42P01') {
        console.error("Table does not exist. Please create the table in Supabase.");
        return;
      }
      throw error;
    }

    attendanceData = data || [];

    // Update all views
    updateDashboardStats();
    renderCalendar();
    renderStats();
  } catch (err) {
    console.error("Error fetching data:", err);
  }
}

async function updateAttendance(dateStr, status) {
  if (!currentUser) return;

  try {
    if (status === 'clear') {
      // Delete record safely
      const { error } = await supabaseClient
        .from('attendance')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('date', dateStr);

      if (error) throw error;

      attendanceData = attendanceData.filter(d => d.date !== dateStr);
    } else {
      // Upsert record
      const { data, error } = await supabaseClient
        .from('attendance')
        .upsert({ user_id: currentUser.id, date: dateStr, status }, { onConflict: 'user_id, date' })
        .select();

      if (error) throw error;

      // Update local cache
      const idx = attendanceData.findIndex(d => d.date === dateStr);
      if (idx > -1) {
        attendanceData[idx] = data[0];
      } else {
        attendanceData.push(data[0]);
      }
    }

    // Refresh UI
    updateDashboardStats();
    renderCalendar();
    renderStats();

  } catch (err) {
    console.error("Error updating attendance:", err);
    alert("Failed to update attendance");
  }
}

// ==========================================
// 7. DASHBOARD LOGIC (SMART PREDICTOR)
// ==========================================
function updateDashboardStats() {
  const presents = attendanceData.filter(d => d.status === 'present').length;
  const absents = attendanceData.filter(d => d.status === 'absent').length;
  const holidays = attendanceData.filter(d => d.status === 'holiday').length;
  const medicals = attendanceData.filter(d => d.status === 'medical').length;
  const workingDays = presents + absents + medicals;

  dashTotal.textContent = workingDays;
  dashPresent.textContent = presents;
  dashAbsent.textContent = absents;
  dashHolidays.textContent = holidays;

  const percentage = workingDays === 0 ? 0 : Math.round((presents / workingDays) * 100);

  // Animate progress ring
  const circle = document.getElementById('circular-progress');
  const radius = circle.r.baseVal.value;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (percentage / 100) * circumference;

  circle.style.strokeDashoffset = offset;
  progressText.textContent = `${percentage}%`;

  // Set stroke color and badge based on status
  let statusClass = 'safe';
  let badgeText = 'Safe (>=75%)';
  if (percentage < 70) {
    statusClass = 'risk';
    badgeText = 'Risk (<70%)';
    circle.style.stroke = 'var(--absent-color)';
  } else if (percentage < 75) {
    statusClass = 'warning';
    badgeText = 'Warning (70-75%)';
    circle.style.stroke = 'var(--warning-color)';
  } else {
    circle.style.stroke = 'var(--present-color)';
  }

  attendanceBadge.className = `status-badge ${statusClass}`;
  attendanceBadge.textContent = badgeText;

  // Set Smart Predictor logic
  updatePredictor(presents, workingDays, percentage);
}

function updatePredictor(present, total, currentPercentage) {
  if (total === 0) {
    predictorContent.innerHTML = `<div class="predictor-placeholder">Log attendance to see predictions.</div>`;
    return;
  }

  let html = '';

  if (currentPercentage >= 75) {
    // How many leaves can I take and still maintain 75%?
    // present / (total + leaves) >= 0.75  =>  present >= 0.75 * total + 0.75 * leaves
    // leaves <= (present - 0.75 * total) / 0.75
    const safeLeaves = Math.floor((present - 0.75 * total) / 0.75);

    html = `
      <p>Your attendance is completely safe. 🎉</p>
      <p style="margin-top: 10px;">
        You can take <strong style="color: var(--present-color); font-size: 1.3rem;">${safeLeaves}</strong> more leave(s) 
        and still maintain 75% attendance.
      </p>
    `;
  } else {
    // How many days must I attend continuously?
    // (present + days) / (total + days) >= 0.75
    // present + days >= 0.75 * total + 0.75 * days
    // 0.25 * days >= 0.75 * total - present
    // days >= (0.75 * total - present) / 0.25
    const requiredDays = Math.ceil((0.75 * total - present) / 0.25);

    html = `
      <p style="color: var(--absent-color); font-weight: 600;">You are below the 75% threshold!</p>
      <p style="margin-top: 10px;">
        You must attend the next <strong style="color: var(--warning-color); font-size: 1.3rem;">${requiredDays}</strong> 
        classes/days continuously to recover to 75%.
      </p>
    `;
  }

  predictorContent.innerHTML = html;
}

// ==========================================
// 8. CALENDAR LOGIC
// ==========================================
function renderCalendar() {
  calendarGrid.innerHTML = '';

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  calendarMonthYear.textContent = `${monthNames[month]} ${year}`;

  const firstDay = new Date(year, month, 1).getDay(); // 0 (Sun) to 6 (Sat)
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Create empty boxes for days before 1st
  for (let i = 0; i < firstDay; i++) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'cal-day empty';
    calendarGrid.appendChild(emptyDiv);
  }

  // Current Date for highlighting today
  const today = new Date();

  // Format MM and string tools
  const monthStr = String(month + 1).padStart(2, '0');

  // Create day boxes
  for (let i = 1; i <= daysInMonth; i++) {
    const dayDiv = document.createElement('div');
    dayDiv.className = 'cal-day';
    dayDiv.textContent = i;

    const dayStr = String(i).padStart(2, '0');
    const fullDateStr = `${year}-${monthStr}-${dayStr}`;

    // Check if it's today
    if (today.getFullYear() === year && today.getMonth() === month && today.getDate() === i) {
      dayDiv.classList.add('today');
    }

    // Attach data if exists
    const record = attendanceData.find(d => d.date === fullDateStr);
    if (record) {
      dayDiv.setAttribute('data-status', record.status);
    }

    // Click to open modal
    dayDiv.addEventListener('click', () => {
      openModal(fullDateStr);
    });

    calendarGrid.appendChild(dayDiv);
  }
}

function openModal(dateStr) {
  selectedModalDate = dateStr;

  const record = attendanceData.find(d => d.date === dateStr);
  if (record) {
    modalDateText.innerHTML = `Update Status for ${dateStr} <br><span style="font-size: 0.9rem; color: var(--text-secondary);">(Current: <strong>${record.status}</strong>)</span>`;
  } else {
    modalDateText.textContent = `Log status for ${dateStr}`;
  }

  modal.classList.remove('hidden');
}

function hideModal() {
  modal.classList.add('hidden');
  selectedModalDate = null;
}

// ==========================================
// 9. STATISTICS LOGIC (CHART.JS)
// ==========================================
function renderStats() {
  // Aggregate data by month. e.g "2026-04"
  const monthlyData = {};

  attendanceData.forEach(record => {
    // record.date is "YYYY-MM-DD"
    if (record.status === 'holiday') return; // Do not count holidays

    const monthKey = record.date.substring(0, 7);

    if (!monthlyData[monthKey]) {
      monthlyData[monthKey] = {
        key: monthKey,
        present: 0,
        absent: 0,
        total: 0
      };
    }

    monthlyData[monthKey].total += 1;
    if (record.status === 'present') {
      monthlyData[monthKey].present += 1;
    } else if (record.status === 'absent') {
      monthlyData[monthKey].absent += 1;
    }
  });

  // Extract non-empty months and calculate percentage
  const labels = [];
  const dataPoints = [];
  const cardsHtml = [];

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Sort chronologically
  const sortedKeys = Object.keys(monthlyData).sort();

  sortedKeys.forEach(key => {
    const d = monthlyData[key];
    if (d.total === 0) return; // ignore completely empty

    const perc = Math.round((d.present / d.total) * 100);

    // Format "Apr 2026"
    const [y, m] = key.split('-');
    const label = `${monthNames[parseInt(m) - 1]} ${y}`;

    labels.push(label);
    dataPoints.push(perc);

    // Build card HTML
    let statusClass = 'safe';
    let statusIcon = 'ph-check-circle';
    let statusText = 'Safe';
    let color = 'var(--present-color)';

    if (perc < 70) {
      statusClass = 'risk';
      statusIcon = 'ph-warning-octagon';
      statusText = 'Risk';
      color = 'var(--absent-color)';
    } else if (perc < 75) {
      statusClass = 'warning';
      statusIcon = 'ph-warning';
      statusText = 'Warning';
      color = 'var(--warning-color)';
    }

    cardsHtml.push(`
      <div class="month-card glass-card">
        <div class="month-card-header">
          <span>${label}</span>
          <div class="month-card-status" style="color: ${color}">
            <i class="ph ${statusIcon}"></i> ${statusText}
          </div>
        </div>
        <div class="month-card-perc" style="color: ${color}">${perc}%</div>
        <div style="font-size: 0.85rem; color: var(--text-secondary)">
          ${d.present} / ${d.total} days Present
        </div>
      </div>
    `);
  });

  const cardsContainer = document.getElementById('month-cards-container');
  if (cardsHtml.length > 0) {
    cardsContainer.innerHTML = cardsHtml.join('');
  } else {
    cardsContainer.innerHTML = `<p style="color: var(--text-secondary)">No attendance data available yet.</p>`;
  }

  // Draw Chart
  drawChart(labels, dataPoints);
}

function drawChart(labels, dataPoints) {
  const ctx = document.getElementById('attendanceChart').getContext('2d');

  if (chartInstance) {
    chartInstance.destroy();
  }

  // Get current theme styling for chart
  const isDark = document.body.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#94a3b8' : '#64748b';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Attendance %',
        data: dataPoints,
        borderColor: '#4f46e5',
        backgroundColor: 'rgba(79, 70, 229, 0.1)',
        borderWidth: 3,
        pointBackgroundColor: '#4f46e5',
        pointRadius: 5,
        pointHoverRadius: 8,
        fill: true,
        tension: 0.4 // Smooth curves
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        annotation: {
          // If we want to add 75% target line, we could add chartjs-plugin-annotation
          // but we will just simulate it using Chart.js capabilities or draw custom.
          // For vanilla ChartJs, we keep it clean.
        }
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          grid: { color: gridColor },
          ticks: { color: textColor, callback: (v) => v + '%' }
        },
        x: {
          grid: { display: false },
          ticks: { color: textColor }
        }
      }
    },
    // Custom plugin to draw 75% target line
    plugins: [{
      id: 'targetLine',
      beforeDraw: chart => {
        const { ctx, chartArea: { left, right }, scales: { y } } = chart;
        const yPos = y.getPixelForValue(75);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(left, yPos);
        ctx.lineTo(right, yPos);
        ctx.lineWidth = 2;
        ctx.strokeStyle = isDark ? 'rgba(239, 68, 68, 0.5)' : 'rgba(239, 68, 68, 0.3)';
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.restore();
      }
    }]
  });
}
