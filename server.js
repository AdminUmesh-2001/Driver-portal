const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const path = require('path');

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);
const dataDir = path.join(__dirname, 'data');
const accountsPath = path.join(dataDir, 'accounts.json');
const sharedStatePath = path.join(dataDir, 'shared-state.json');
const defaultAdminAccount = {
  id: 'admin-umesh',
  role: 'admin',
  name: 'UMESH',
  email: 'umesh@local',
  username: 'umesh',
  password: 'umesh123',
  appBlocked: false,
  accountUpdatedAtSort: 0,
};

app.use(
  cors({
    origin: true,
  })
);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const requiredMailFields = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function scoreLanInterface(name, address) {
  const lowerName = String(name || '').toLowerCase();
  let score = 0;

  if (
    lowerName.includes('virtualbox') ||
    lowerName.includes('vmware') ||
    lowerName.includes('hyper-v') ||
    lowerName.includes('host-only') ||
    lowerName.includes('vethernet')
  ) {
    score -= 100;
  }

  if (
    lowerName.includes('wi-fi') ||
    lowerName.includes('wifi') ||
    lowerName.includes('wireless') ||
    lowerName.includes('wlan')
  ) {
    score += 40;
  }

  if (lowerName.includes('ethernet')) {
    score += 20;
  }

  if (address.startsWith('10.')) {
    score += 15;
  } else if (address.startsWith('192.168.')) {
    score += 10;
  }

  return score;
}

function parseWindowsLanAddresses() {
  try {
    const output = execSync('ipconfig /all', {
      encoding: 'utf8',
      windowsHide: true,
    });
    const blocks = output.split(/\r?\n\r?\n+/);
    const candidates = [];

    blocks.forEach((block) => {
      const lowerBlock = block.toLowerCase();
      const ipv4Match = block.match(/IPv4 Address[^\:]*:\s*([0-9.]+)/i);
      if (!ipv4Match) {
        return;
      }

      const address = ipv4Match[1].trim();
      if (address.startsWith('169.254.')) {
        return;
      }
      if (address.startsWith('192.168.56.')) {
        return;
      }

      let score = 0;
      if (lowerBlock.includes('default gateway') && !/default gateway[^\:]*:\s*$/im.test(block)) {
        score += 60;
      }
      if (lowerBlock.includes('wireless lan adapter wi-fi')) {
        score += 80;
      }
      if (lowerBlock.includes('virtualbox') || lowerBlock.includes('host-only')) {
        score -= 200;
      }
      if (lowerBlock.includes('media disconnected')) {
        score -= 200;
      }
      if (address.startsWith('10.')) {
        score += 15;
      } else if (address.startsWith('192.168.')) {
        score += 10;
      }

      candidates.push({ address, score });
    });

    return [...new Set(candidates.sort((a, b) => b.score - a.score).map((item) => item.address))];
  } catch {
    return [];
  }
}

function getLanAddresses() {
  if (process.platform === 'win32') {
    const windowsAddresses = parseWindowsLanAddresses();
    if (windowsAddresses.length) {
      return windowsAddresses;
    }
  }

  const interfaces = os.networkInterfaces();
  const addresses = [];

  Object.entries(interfaces).forEach(([name, entries]) => {
    (entries || []).forEach((entry) => {
      if (
        entry &&
        entry.family === 'IPv4' &&
        !entry.internal &&
        !entry.address.startsWith('169.254.')
      ) {
        addresses.push({
          address: entry.address,
          score: scoreLanInterface(name, entry.address),
        });
      }
    });
  });

  return [...new Set(addresses.sort((a, b) => b.score - a.score).map((item) => item.address))];
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeName(value) {
  return normalizeString(value).toUpperCase();
}

function sanitizeAccount(account) {
  return {
    id: normalizeString(account?.id),
    role: account?.role === 'admin' ? 'admin' : 'driver',
    name: normalizeName(account?.name),
    email: normalizeEmail(account?.email),
    username: normalizeName(account?.username),
    password: normalizeString(account?.password),
    appBlocked: Boolean(account?.appBlocked),
    accountUpdatedAtSort: Number(account?.accountUpdatedAtSort || 0),
  };
}

function withAdminAccount(accounts) {
  const sanitized = Array.isArray(accounts) ? accounts.map(sanitizeAccount) : [];
  const filtered = sanitized.filter(
    (account) => account.id && account.name && account.email && account.username && account.password
  );
  const withoutAdmin = filtered.filter((account) => account.id !== defaultAdminAccount.id);
  return [defaultAdminAccount, ...withoutAdmin];
}

function readAccounts() {
  ensureDataDir();
  if (!fs.existsSync(accountsPath)) {
    const initial = [defaultAdminAccount];
    fs.writeFileSync(accountsPath, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    const raw = fs.readFileSync(accountsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = withAdminAccount(parsed);
    fs.writeFileSync(accountsPath, JSON.stringify(normalized, null, 2));
    return normalized;
  } catch {
    const fallback = [defaultAdminAccount];
    fs.writeFileSync(accountsPath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function writeAccounts(accounts) {
  ensureDataDir();
  const normalized = withAdminAccount(accounts);
  fs.writeFileSync(accountsPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function readSharedState() {
  ensureDataDir();
  const defaults = {
    accounts: readAccounts(),
    moves: [],
    waitRecords: [],
    savedFiles: [],
    waitSavedFiles: [],
    companyFiles: [],
    messages: [],
    recycleBin: [],
    purgedRecycleIds: [],
    restoredRecycleIds: [],
    clearedMoveIds: [],
    deletedSourceIdsState: [],
    adminNotificationEmail: defaultAdminAccount.email,
  };

  if (!fs.existsSync(sharedStatePath)) {
    fs.writeFileSync(sharedStatePath, JSON.stringify(defaults, null, 2));
    return defaults;
  }

  try {
    const raw = fs.readFileSync(sharedStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = {
      ...defaults,
      ...parsed,
      accounts: withAdminAccount(parsed?.accounts?.length ? parsed.accounts : defaults.accounts),
    };
    fs.writeFileSync(sharedStatePath, JSON.stringify(normalized, null, 2));
    return normalized;
  } catch {
    fs.writeFileSync(sharedStatePath, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

function writeSharedState(nextState) {
  ensureDataDir();
  const defaults = readSharedState();
  const normalized = {
    ...defaults,
    ...nextState,
    accounts: withAdminAccount(nextState?.accounts?.length ? nextState.accounts : defaults.accounts),
    moves: Array.isArray(nextState?.moves) ? nextState.moves : defaults.moves,
    waitRecords: Array.isArray(nextState?.waitRecords) ? nextState.waitRecords : defaults.waitRecords,
    savedFiles: Array.isArray(nextState?.savedFiles) ? nextState.savedFiles : defaults.savedFiles,
    waitSavedFiles: Array.isArray(nextState?.waitSavedFiles)
      ? nextState.waitSavedFiles
      : defaults.waitSavedFiles,
    companyFiles: Array.isArray(nextState?.companyFiles) ? nextState.companyFiles : defaults.companyFiles,
    messages: Array.isArray(nextState?.messages) ? nextState.messages : defaults.messages,
    recycleBin: Array.isArray(nextState?.recycleBin) ? nextState.recycleBin : defaults.recycleBin,
    purgedRecycleIds: Array.isArray(nextState?.purgedRecycleIds)
      ? nextState.purgedRecycleIds
      : defaults.purgedRecycleIds,
    restoredRecycleIds: Array.isArray(nextState?.restoredRecycleIds)
      ? nextState.restoredRecycleIds
      : defaults.restoredRecycleIds,
    clearedMoveIds: Array.isArray(nextState?.clearedMoveIds)
      ? nextState.clearedMoveIds
      : defaults.clearedMoveIds,
    deletedSourceIdsState: Array.isArray(nextState?.deletedSourceIdsState)
      ? nextState.deletedSourceIdsState
      : defaults.deletedSourceIdsState,
    adminNotificationEmail: normalizeEmail(
      nextState?.adminNotificationEmail || defaults.adminNotificationEmail
    ),
  };
  fs.writeFileSync(sharedStatePath, JSON.stringify(normalized, null, 2));
  writeAccounts(normalized.accounts);
  return normalized;
}

function getMailConfigStatus() {
  return requiredMailFields.every((field) => Boolean(process.env[field]));
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mailConfigured: getMailConfigStatus(),
    adminEmail: process.env.ADMIN_EMAIL || '',
  });
});

app.get('/api/network-info', (_req, res) => {
  const lanAddresses = getLanAddresses();
  res.json({
    ok: true,
    lanAddresses,
    preferredAddress: lanAddresses[0] || '',
    driverLink: lanAddresses[0] ? `http://${lanAddresses[0]}:3000` : '',
    adminLink: lanAddresses[0] ? `http://${lanAddresses[0]}:3001` : '',
  });
});

app.get('/api/accounts', (_req, res) => {
  res.json({
    ok: true,
    accounts: readSharedState().accounts,
  });
});

app.put('/api/accounts', (req, res) => {
  const { accounts } = req.body || {};

  if (!Array.isArray(accounts)) {
    return res.status(400).json({
      ok: false,
      message: 'Accounts array is required.',
    });
  }

  const sharedState = readSharedState();
  const savedState = writeSharedState({
    ...sharedState,
    accounts,
  });
  return res.json({
    ok: true,
    accounts: savedState.accounts,
  });
});

app.get('/api/shared-state', (_req, res) => {
  res.json({
    ok: true,
    state: readSharedState(),
  });
});

app.put('/api/shared-state', (req, res) => {
  const { state } = req.body || {};

  if (!state || typeof state !== 'object') {
    return res.status(400).json({
      ok: false,
      message: 'Shared state object is required.',
    });
  }

  const savedState = writeSharedState(state);
  return res.json({
    ok: true,
    state: savedState,
  });
});

app.post('/api/email/register-driver', async (req, res) => {
  const { driverName, driverEmail, username, password, adminEmail } = req.body || {};

  if (!driverName || !driverEmail || !username || !password) {
    return res.status(400).json({ ok: false, message: 'Missing driver registration data.' });
  }

  if (!getMailConfigStatus()) {
    return res.status(500).json({
      ok: false,
      message: 'SMTP is not configured yet. Update your .env file first.',
    });
  }

  try {
    const transporter = createTransporter();
    const fromAddress = process.env.MAIL_FROM || process.env.SMTP_USER;
    const activeAdminEmail = adminEmail || process.env.ADMIN_EMAIL || process.env.SMTP_USER;

    await transporter.sendMail({
      from: fromAddress,
      to: driverEmail,
      subject: `Driver App registration for ${driverName}`,
      text: [
        `Hello ${driverName},`,
        '',
        'Your Driver App account is ready.',
        `Username: ${username}`,
        `Password: ${password}`,
        '',
        'You can now log in to the local Driver App.',
      ].join('\n'),
    });

    if (activeAdminEmail) {
      await transporter.sendMail({
        from: fromAddress,
        to: activeAdminEmail,
        subject: `Driver registered: ${driverName}`,
        text: [
          `A new driver was registered in Driver App.`,
          '',
          `Driver name: ${driverName}`,
          `Driver email: ${driverEmail}`,
          `Username: ${username}`,
        ].join('\n'),
      });
    }

    return res.json({
      ok: true,
      message: `Registration email sent to ${driverEmail}.`,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Email sending failed.',
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Driver App email backend running on http://0.0.0.0:${port}`);
});
