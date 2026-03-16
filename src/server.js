const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const DB_FILE = path.join(__dirname, 'db.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ── helpers ──────────────────────────────────────────────────────────────────

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, war: { active: false, startDate: null, adminPassword: ADMIN_PASSWORD } }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Get current IST time
function nowIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

// Get war day index (0-based) for a given IST date string "YYYY-MM-DD"
// Day resets at 5am IST
function getWarDay(startDate, targetDateStr) {
  if (!startDate) return -1;
  const start = new Date(startDate + 'T05:00:00+05:30');
  const target = new Date(targetDateStr + 'T05:00:00+05:30');
  const diff = Math.floor((target - start) / (1000 * 60 * 60 * 24));
  return diff; // 0 = day 1
}

// Get the "war date" string for a SP date key (which is YYYY-MM-DD in local time)
// If time is before 5am IST, it belongs to previous day
function getWarDateStr(spDateKey, hourOfDay) {
  // spDateKey is already YYYY-MM-DD from SP (in user's local time ~IST)
  // hourOfDay: 0-23 in IST. If < 5, belongs to previous calendar day
  if (hourOfDay < 5) {
    const d = new Date(spDateKey + 'T12:00:00Z');
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return spDateKey;
}

// ── existing leaderboard endpoint ────────────────────────────────────────────

app.post('/api/update', (req, res) => {
  const { username, timeSpentMs, isActive, taskBreakdown } = req.body;

  // Drop empty or "unknown" usernames silently
  const trimmed = (username || '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return res.json({ ok: false, reason: 'unknown user ignored' });
  }

  const db = loadDB();
  if (!db.users[trimmed]) db.users[trimmed] = { timeSpentMs: 0, isActive: false, lastUpdate: null, dailyMs: {} };

  db.users[trimmed].timeSpentMs = timeSpentMs || 0;
  db.users[trimmed].isActive = isActive || false;
  db.users[trimmed].lastUpdate = new Date().toISOString();

  // Store daily breakdown for war calculations
  if (taskBreakdown) {
    db.users[trimmed].dailyMs = taskBreakdown; // { "2025-01-01": ms, ... }
  }

  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
  const db = loadDB();
  const banned = new Set(db.war?.banned || []);

  const users = Object.entries(db.users)
    .filter(([name]) => !banned.has(name))
    .map(([name, data]) => {
      // Sum dailyMs for correct total — same logic as war leaderboard
      const dailyMs = data.dailyMs || {};
      const totalMs = Object.values(dailyMs).reduce((s, v) => s + v, 0);
      // Fall back to stored timeSpentMs only if no dailyMs at all
      const timeSpentMs = Object.keys(dailyMs).length > 0 ? totalMs : (data.timeSpentMs || 0);

      return {
        username: name,
        timeSpentMs,
        isActive: data.isActive || false,
        lastUpdate: data.lastUpdate,
      };
    });

  users.sort((a, b) => b.timeSpentMs - a.timeSpentMs);
  res.json(users);
});

// ── WAR endpoints ─────────────────────────────────────────────────────────────

function verifyAdmin(req, res) {
  const pwd = req.headers['x-admin-password'] || req.body?.adminPassword;
  const db = loadDB();
  if (pwd !== (db.war?.adminPassword || ADMIN_PASSWORD)) {
    res.status(403).json({ error: 'Invalid admin password' });
    return false;
  }
  return true;
}

// Get war config + status
app.get('/api/war/status', (req, res) => {
  const db = loadDB();
  const war = db.war || {};
  const users = db.users || {};

  if (!war.startDate) {
    return res.json({ active: false, startDate: null, days: [] });
  }

  const now = nowIST();
  const todayStr = now.toISOString().slice(0, 10);
  const currentHour = now.getHours();
  // Current war date (respecting 5am reset)
  const currentWarDateStr = currentHour < 5
    ? (() => { const d = new Date(now); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })()
    : todayStr;

  const startDay = getWarDay(war.startDate, war.startDate);
  const currentDay = getWarDay(war.startDate, currentWarDateStr);
  const totalWarDays = 7;

  // Filter banned users
  const banned = new Set(war.banned || []);

  // Build per-user data
  const userStats = {};
  for (const [username, data] of Object.entries(users)) {
    if (banned.has(username)) continue;
    const dailyMs = data.dailyMs || {};
    const days = []; // index 0 = war day 1

    for (let d = 0; d < totalWarDays; d++) {
      const warDateObj = new Date(war.startDate + 'T05:00:00+05:30');
      warDateObj.setDate(warDateObj.getDate() + d);
      const dateStr = warDateObj.toISOString().slice(0, 10);

      // Sum all SP daily entries that belong to this war day
      let ms = 0;
      for (const [spDate, spMs] of Object.entries(dailyMs)) {
        // Check if this SP date belongs to this war day
        // SP date key is already adjusted at source; we use simple date match here
        if (spDate === dateStr) ms += spMs;
      }

      const hours = ms / (1000 * 60 * 60);
      const isPast = d < currentDay;
      const isCurrent = d === currentDay;
      const isFuture = d > currentDay;

      // Red badges: stored in war.failBadges[username] = [dayIndex, ...]
      const failBadges = (war.failBadges || {})[username] || [];
      const hasRedBadge = failBadges.includes(d);

      days.push({
        dayIndex: d,
        dateStr,
        hours: Math.round(hours * 10) / 10,
        ms,
        isPast,
        isCurrent,
        isFuture,
        hasRedBadge,
        met10h: hours >= 10,
        met14h: hours >= 14
      });
    }

    const totalHours = days.reduce((sum, d) => sum + d.hours, 0);
    const daysMet = days.filter(d => d.met10h && !d.isFuture).length;
    const redBadgeCount = days.filter(d => d.hasRedBadge).length;

    // Rank
    let rank = null;
    if (daysMet >= 7) rank = 'gold';
    else if (daysMet >= 5) rank = 'silver';
    else if (daysMet >= 3) rank = 'bronze';

    userStats[username] = { username, days, totalHours, daysMet, rank, redBadgeCount };
  }

  // King of the Day: highest hours each day
  const kingsPerDay = {};
  for (let d = 0; d < totalWarDays; d++) {
    let king = null, kingHours = 0;
    for (const [username, stat] of Object.entries(userStats)) {
      if (stat.days[d] && stat.days[d].hours > kingHours) {
        kingHours = stat.days[d].hours;
        king = username;
      }
    }
    if (king && kingHours > 0) kingsPerDay[d] = king;
  }

  // Legend: highest total hours
  let legend = null, legendHours = 0;
  for (const [username, stat] of Object.entries(userStats)) {
    if (stat.totalHours > legendHours) {
      legendHours = stat.totalHours;
      legend = username;
    }
  }

  res.json({
    active: war.active || false,
    startDate: war.startDate,
    currentDay,
    totalWarDays,
    users: Object.values(userStats),
    kingsPerDay,
    legend,
    challengeComplete: currentDay >= totalWarDays
  });
});

// Admin: set/update war config
app.post('/api/war/config', (req, res) => {
  if (!verifyAdmin(req, res)) return;
  const { startDate, active } = req.body;
  const db = loadDB();
  if (!db.war) db.war = {};
  if (startDate !== undefined) db.war.startDate = startDate;
  if (active !== undefined) db.war.active = active;
  saveDB(db);
  res.json({ ok: true, war: db.war });
});

// Admin: reset entire challenge
app.post('/api/war/reset', (req, res) => {
  if (!verifyAdmin(req, res)) return;
  const db = loadDB();
  db.war = { active: false, startDate: null, failBadges: {}, adminPassword: db.war?.adminPassword || ADMIN_PASSWORD };
  saveDB(db);
  res.json({ ok: true });
});

// Admin: approve red badge for a user on a day
app.post('/api/war/fail-badge', (req, res) => {
  if (!verifyAdmin(req, res)) return;
  const { username, dayIndex, action } = req.body; // action: 'add' | 'remove'
  const db = loadDB();
  if (!db.war.failBadges) db.war.failBadges = {};
  if (!db.war.failBadges[username]) db.war.failBadges[username] = [];

  if (action === 'add') {
    if (!db.war.failBadges[username].includes(dayIndex)) {
      db.war.failBadges[username].push(dayIndex);
      db.war.failBadges[username].sort((a, b) => a - b);
    }
  } else if (action === 'remove') {
    const idx = db.war.failBadges[username].indexOf(dayIndex);
    if (idx !== -1) db.war.failBadges[username].splice(idx, 1);
  }

  saveDB(db);

  // Auto-redeem: if user has 14h+ on any subsequent day, remove oldest red badge
  autoRedeem(db, username);
  saveDB(db);

  res.json({ ok: true });
});

// Auto-redeem logic: for each red badge day, if any later day has 14h+, remove oldest badge
function autoRedeem(db, username) {
  const userData = db.users[username];
  if (!userData || !db.war.startDate) return;
  const failBadges = (db.war.failBadges || {})[username] || [];
  if (failBadges.length === 0) return;

  const dailyMs = userData.dailyMs || {};

  // Build hours per war day
  const hoursPerDay = {};
  for (let d = 0; d < 7; d++) {
    const warDateObj = new Date(db.war.startDate + 'T05:00:00+05:30');
    warDateObj.setDate(warDateObj.getDate() + d);
    const dateStr = warDateObj.toISOString().slice(0, 10);
    let ms = 0;
    for (const [spDate, spMs] of Object.entries(dailyMs)) {
      if (spDate === dateStr) ms += spMs;
    }
    hoursPerDay[d] = ms / (1000 * 60 * 60);
  }

  // For each red badge day, check if the NEXT day has 14h+
  const toRemove = [];
  for (const badgeDay of [...failBadges]) {
    const nextDay = badgeDay + 1;
    if (nextDay < 7 && hoursPerDay[nextDay] >= 14) {
      toRemove.push(badgeDay);
    }
  }

  if (toRemove.length > 0) {
    db.war.failBadges[username] = failBadges.filter(d => !toRemove.includes(d));
  }
}

// Admin: list all users (including banned) for admin panel
app.get('/api/admin/users', (req, res) => {
  const pwd = req.headers['x-admin-password'] || req.query.password;
  const db = loadDB();
  if (pwd !== (db.war?.adminPassword || ADMIN_PASSWORD)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const banned = new Set(db.war?.banned || []);
  const dailySumMs = (data) => {
    const dailyMs = data.dailyMs || {};
    const total = Object.values(dailyMs).reduce((s, v) => s + v, 0);
    return Object.keys(dailyMs).length > 0 ? total : (data.timeSpentMs || 0);
  };

  const users = Object.entries(db.users)
    .map(([name, data]) => ({
      username: name,
      timeSpentMs: dailySumMs(data),
      isActive: data.isActive || false,
      lastUpdate: data.lastUpdate,
      banned: banned.has(name),
    }))
    .sort((a, b) => b.timeSpentMs - a.timeSpentMs);

  res.json(users);
});

// Admin: ban (hide) or restore a user — data is preserved, user just disappears from boards
app.post('/api/admin/ban', (req, res) => {
  if (!verifyAdmin(req, res)) return;
  const { username, action } = req.body; // action: 'ban' | 'unban'
  if (!username) return res.status(400).json({ error: 'username required' });

  const db = loadDB();
  if (!db.war.banned) db.war.banned = [];

  if (action === 'unban') {
    db.war.banned = db.war.banned.filter(u => u !== username);
  } else {
    if (!db.war.banned.includes(username)) db.war.banned.push(username);
  }

  saveDB(db);
  res.json({ ok: true, banned: db.war.banned });
});

// Delete user
app.post('/api/delete-user', (req, res) => {
  if (!verifyAdmin(req, res)) return;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const db = loadDB();
  if (!db.users[username]) return res.status(404).json({ error: 'User not found' });
  delete db.users[username];
  if (db.war?.failBadges?.[username]) delete db.war.failBadges[username];
  if (db.war?.banned) db.war.banned = db.war.banned.filter(u => u !== username);
  saveDB(db);
  res.json({ ok: true });
});

// Rename user
app.post('/api/rename', (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
  const trimmed = newName.trim();
  if (!trimmed) return res.status(400).json({ error: 'newName cannot be empty' });

  const db = loadDB();
  if (!db.users[oldName]) return res.status(404).json({ error: 'User not found' });
  if (db.users[trimmed] && trimmed !== oldName) return res.status(409).json({ error: 'Name already taken' });

  // Move user data
  db.users[trimmed] = db.users[oldName];
  if (trimmed !== oldName) delete db.users[oldName];

  // Update war fail badges
  if (db.war?.failBadges?.[oldName]) {
    db.war.failBadges[trimmed] = db.war.failBadges[oldName];
    if (trimmed !== oldName) delete db.war.failBadges[oldName];
  }

  // Update banned list
  if (db.war?.banned) {
    const idx = db.war.banned.indexOf(oldName);
    if (idx !== -1 && trimmed !== oldName) {
      db.war.banned[idx] = trimmed;
    }
  }

  saveDB(db);
  res.json({ ok: true, newName: trimmed });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
