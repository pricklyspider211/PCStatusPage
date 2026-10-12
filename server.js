require('dotenv').config();

const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const USERS_PATH = path.join(__dirname, 'users.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'pricklystatus-page-secret';
const DEFAULT_BACKGROUND_URL = 'https://motionbgs.com/media/10092/minecraft-fishing.960x540.mp4';

const defaultConfig = {
  pterodactylApiUrl: '',
  apiKey: '',
  statusPanelName: 'PricklyStatus Page',
  backgroundUrl: DEFAULT_BACKGROUND_URL,
  logoUrl: ''
};

const defaultUserStore = { users: [] };

function getConfigCandidates() {
  const candidates = [
    CONFIG_PATH,
    path.join(process.cwd(), 'config.json'),
    path.resolve('config.json')
  ];

  return Array.from(new Set(candidates.filter(Boolean)));
}

function ensureJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

function readJsonFile(filePath, fallbackValue) {
  try {
    const file = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(file);
  } catch (error) {
    return fallbackValue;
  }
}

function getConfig() {
  const candidates = getConfigCandidates();
  const loadedConfig = candidates
    .map((filePath) => readJsonFile(filePath, null))
    .find((config) => config && typeof config === 'object');

  const envConfig = {};
  const envMap = {
    pterodactylApiUrl: process.env.PTERODACTYL_API_URL || process.env.PANEL_API_URL || '',
    apiKey: process.env.PTERODACTYL_API_KEY || process.env.PANEL_API_KEY || '',
    statusPanelName: process.env.STATUS_PANEL_NAME || '',
    backgroundUrl: process.env.BACKGROUND_URL || '',
    logoUrl: process.env.LOGO_URL || ''
  };

  Object.entries(envMap).forEach(([key, value]) => {
    if (typeof value === 'string' && value.trim() !== '') {
      envConfig[key] = value.trim();
    }
  });

  const mergedConfig = { ...defaultConfig, ...(loadedConfig || {}), ...envConfig };
  if (!mergedConfig.backgroundUrl || !String(mergedConfig.backgroundUrl).trim()) {
    mergedConfig.backgroundUrl = DEFAULT_BACKGROUND_URL;
  }

  return mergedConfig;
}

function saveConfig(nextConfig) {
  const configToSave = {
    ...defaultConfig,
    ...(nextConfig || {})
  };

  if (!configToSave.backgroundUrl || !String(configToSave.backgroundUrl).trim()) {
    configToSave.backgroundUrl = DEFAULT_BACKGROUND_URL;
  }
  const candidates = getConfigCandidates();

  process.env.PTERODACTYL_API_URL = configToSave.pterodactylApiUrl || '';
  process.env.PTERODACTYL_API_KEY = configToSave.apiKey || '';
  process.env.STATUS_PANEL_NAME = configToSave.statusPanelName || '';
  process.env.BACKGROUND_URL = configToSave.backgroundUrl || '';
  process.env.LOGO_URL = configToSave.logoUrl || '';

  for (const filePath of candidates) {
    ensureJsonFile(filePath, defaultConfig);
    fs.writeFileSync(filePath, JSON.stringify(configToSave, null, 2));
  }

  return configToSave;
}

function getUsers() {
  const store = readJsonFile(USERS_PATH, defaultUserStore);
  let users = Array.isArray(store.users) ? store.users : [];

  const hasExplicitAdmin = users.some((user) => isAdminRole(user.role));
  if (!hasExplicitAdmin && users.length > 0) {
    users = users.map((user) => ({
      ...user,
      role: user.role || 'admin'
    }));
    saveUsers(users);
  }

  return users;
}

function saveUsers(users) {
  const store = { users };
  fs.writeFileSync(USERS_PATH, JSON.stringify(store, null, 2));
}

function isAdminRole(role) {
  return role === 'admin' || role === 'superadmin';
}

function normalizeUser(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }

  const nextRole = typeof user.role === 'string' ? user.role.toLowerCase() : '';
  const normalizedRole = nextRole === 'user' ? 'user' : nextRole === 'admin' || nextRole === 'superadmin' ? nextRole : 'admin';

  return {
    ...user,
    role: normalizedRole,
    isAdmin: isAdminRole(normalizedRole)
  };
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const normalized = normalizeUser(user);
  const { salt, hash, iterations, ...safeUser } = normalized;
  return safeUser;
}

function normalizeServerStatus(status) {
  const value = String(status || '').toLowerCase();

  if (value.includes('suspend')) {
    return 'Suspended';
  }

  if (value.includes('offline') || value.includes('stopped') || value.includes('install')) {
    return 'Offline';
  }

  return 'Online';
}

function getServerLimitValue(server, key, fallback = '0') {
  const attrs = server?.attributes || {};
  const limits = attrs.limits || server?.limits || {};
  const rawValue = limits[key] ?? attrs[key] ?? fallback;

  return rawValue === undefined || rawValue === null || rawValue === '' ? fallback : rawValue;
}

function getNodeId(node) {
  const attrs = node?.attributes || {};
  const candidate = node?.id ?? attrs.id ?? attrs.node_id ?? node?.node_id ?? attrs.uuid ?? node?.uuid ?? null;
  return candidate === undefined || candidate === null ? null : String(candidate);
}

function normalizeServerDetails(server) {
  const attrs = server?.attributes || server || {};
  const allocation = attrs.allocation || attrs.allocation_data || attrs.relationships?.allocations?.data?.[0]?.attributes || {};
  const port = Number(allocation.port ?? attrs.port ?? server?.port ?? 0) || 'N/A';
  const fqdn = allocation.alias || attrs.fqdn || attrs.hostname || attrs.ip || 'N/A';
  const status = normalizeServerStatus(attrs.status || server?.status || server?.state);

  return {
    ...server,
    status,
    name: attrs.name || server?.name || 'Unnamed Server',
    identifier: attrs.identifier || server?.identifier || allocation.id || null,
    port,
    fqdn,
    allocation,
    limits: {
      memory: getServerLimitValue(server, 'memory', '0'),
      disk: getServerLimitValue(server, 'disk', '0'),
      cpu: getServerLimitValue(server, 'cpu', '0')
    }
  };
}

async function fetchNodeServers(nodeId, baseUrl, apiKey) {
  if (!nodeId || !baseUrl || !apiKey) {
    return [];
  }

  try {
    const response = await axios.get(`${baseUrl.replace(/\/+$/, '')}/api/application/nodes/${nodeId}/servers`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      timeout: 10000
    });

    const servers = Array.isArray(response?.data?.data) ? response.data.data : [];
    return servers;
  } catch (error) {
    return [];
  }
}

async function fetchApplicationServers(baseUrl, apiKey) {
  if (!baseUrl || !apiKey) {
    return [];
  }

  try {
    const response = await axios.get(`${baseUrl.replace(/\/+$/, '')}/api/application/servers?include=allocations`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      timeout: 15000
    });

    return Array.isArray(response?.data?.data) ? response.data.data : [];
  } catch (error) {
    return [];
  }
}

function mapServersByNodeId(servers) {
  const map = new Map();

  for (const server of Array.isArray(servers) ? servers : []) {
    const attrs = server?.attributes || {};
    const nodeId = attrs.node ?? attrs.node_id ?? attrs.relationships?.node?.data?.id ?? server?.node ?? server?.node_id ?? null;
    const key = nodeId === undefined || nodeId === null ? 'unknown' : String(nodeId);

    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key).push(server);
  }

  return map;
}

function buildNodeHealthCandidates(node) {
  const attrs = node?.attributes || {};
  const host = String(attrs.fqdn || attrs.hostname || attrs.public_ip || '').trim().replace(/^https?:\/\//i, '');

  if (!host) {
    return [];
  }

  const daemonPort = Number(attrs.daemon_listen) || Number(attrs.daemon_listen_port) || Number(attrs.daemon_info?.listen) || Number(attrs.daemon_info?.port) || 8080;
  const ports = Array.from(new Set([daemonPort, 443, 8443, 8080])).filter((port) => Number.isInteger(port) && port > 0);
  const urls = [];

  for (const port of ports) {
    urls.push(`https://${host}:${port}/health`);
    urls.push(`http://${host}:${port}/health`);
    urls.push(`https://${host}:${port}/api/system`);
    urls.push(`http://${host}:${port}/api/system`);
  }

  urls.push(`https://${host}`);
  urls.push(`http://${host}`);

  return Array.from(new Set(urls));
}

async function probeNodeHealth(node) {
  const attrs = node?.attributes || {};
  const fqdn = String(attrs.fqdn || attrs.hostname || attrs.public_ip || '').trim();

  if (!fqdn) {
    return {
      online: false,
      reason: 'Node is missing a valid FQDN or hostname.'
    };
  }

  if (attrs.maintenance) {
    return {
      online: false,
      maintenance: true,
      reason: 'Pterodactyl reported the node is under maintenance.'
    };
  }

  if (attrs.status === 'offline' || attrs.status === 'suspended' || attrs.daemon_unreachable) {
    return {
      online: false,
      reason: 'Pterodactyl reported the node as offline or unreachable.'
    };
  }

  for (const url of buildNodeHealthCandidates(node)) {
    try {
      const response = await axios.get(url, {
        timeout: 2000,
        validateStatus: () => true,
        maxRedirects: 2,
        headers: {
          'User-Agent': 'PricklyStatus/1.0'
        }
      });

      if (response && response.status >= 200 && response.status < 500) {
        return {
          online: true,
          reason: `Daemon responded successfully at ${url}.`
        };
      }
    } catch (error) {
      // Keep checking alternate endpoints until one responds.
    }
  }

  return {
    online: false,
    reason: `No viable response from ${fqdn} within the daemon health timeout.`
  };
}

function verifyPassword(password, user) {
  if (!user || !user.hash || !user.salt) {
    return false;
  }

  try {
    const saltBuffer = Buffer.from(user.salt, 'hex');
    const derivedHash = crypto.pbkdf2Sync(password, saltBuffer, Number(user.iterations || 100000), 64, 'sha512').toString('hex');
    const expectedHash = Buffer.from(user.hash, 'hex');
    const actualHash = Buffer.from(derivedHash, 'hex');

    return crypto.timingSafeEqual(expectedHash, actualHash);
  } catch (error) {
    return false;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 100000;
  const hash = crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), iterations, 64, 'sha512').toString('hex');

  return { salt, hash, iterations };
}

function canManageUser(currentUser, targetUser) {
  if (!currentUser || !targetUser) {
    return false;
  }

  if (currentUser.role === 'superadmin') {
    return true;
  }

  if (currentUser.role === 'admin') {
    return targetUser.role !== 'superadmin';
  }

  return currentUser.username === targetUser.username;
}

ensureJsonFile(CONFIG_PATH, defaultConfig);
ensureJsonFile(USERS_PATH, defaultUserStore);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      cb(null, filename);
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
      return;
    }

    cb(new Error('Only image uploads are allowed.'));
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  return res.status(401).json({ success: false, message: 'Authentication required.' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.isAdmin) {
    return next();
  }

  return res.status(403).json({ success: false, message: 'Administrator access required.' });
}

function requireAuthPage(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  return res.redirect('/login');
}

function requireAdminPage(req, res, next) {
  if (req.session && req.session.user && req.session.isAdmin) {
    return next();
  }

  return res.redirect('/login');
}

app.get('/', (req, res) => {
  res.redirect('/status');
});

app.get('/status', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'status.html'));
});

app.get('/api/auth-status', (req, res) => {
  const user = req.session && req.session.user ? req.session.user : null;
  const isAdmin = Boolean(req.session && req.session.isAdmin && user);
  return res.json({
    success: true,
    isAdmin,
    user: user ? { username: user.username, role: user.role } : null
  });
});

app.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return req.session.isAdmin ? res.redirect('/admin') : res.redirect('/status');
  }

  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/admin', requireAdminPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/users', requireAdminPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  const users = getUsers();
  const user = normalizeUser(users.find((storedUser) => storedUser.username.toLowerCase() === username.toLowerCase()));

  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  }

  req.session.user = { username: user.username, role: user.role };
  req.session.isAdmin = isAdminRole(user.role);

  return res.json({
    success: true,
    user: { username: user.username, role: user.role },
    redirectPath: req.session.isAdmin ? '/admin' : '/status'
  });
});

app.post('/api/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => {
      res.json({ success: true, message: 'Logged out.' });
    });
    return;
  }

  res.json({ success: true, message: 'Logged out.' });
});

app.get('/api/users', requireAdmin, (req, res) => {
  const users = getUsers().map((user) => sanitizeUser(normalizeUser(user))).filter(Boolean);
  return res.json({ success: true, users });
});

app.get('/api/users/me', requireAuth, (req, res) => {
  const currentUser = getUsers().find((user) => user.username === req.session.user.username);
  if (!currentUser) {
    return res.status(404).json({ success: false, message: 'Current user not found.' });
  }

  return res.json({ success: true, user: sanitizeUser(normalizeUser(currentUser)) });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const requestedRole = String(req.body.role || 'user').toLowerCase();
  const safeRole = requestedRole === 'admin' || requestedRole === 'superadmin' ? requestedRole : 'user';

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  if (safeRole === 'superadmin' && req.session.user.role !== 'superadmin') {
    return res.status(403).json({ success: false, message: 'Only a superadmin can create another superadmin.' });
  }

  const users = getUsers();
  const existingUser = users.find((user) => user.username.toLowerCase() === username.toLowerCase());

  if (existingUser) {
    return res.status(409).json({ success: false, message: 'A user with that username already exists.' });
  }

  const passwordHash = hashPassword(password);
  const newUser = {
    username,
    role: safeRole,
    salt: passwordHash.salt,
    hash: passwordHash.hash,
    iterations: passwordHash.iterations
  };

  users.push(newUser);
  saveUsers(users);

  return res.json({ success: true, user: sanitizeUser(normalizeUser(newUser)), message: 'User created successfully.' });
});

app.put('/api/users/me', requireAuth, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const currentUsername = req.session.user.username;
  const users = getUsers();
  const targetUser = users.find((user) => user.username === currentUsername);

  if (!targetUser) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  if (!username && !password) {
    return res.status(400).json({ success: false, message: 'Provide a username or password to update.' });
  }

  const nextUsername = username || targetUser.username;
  const duplicateUser = users.find((user) => user.username.toLowerCase() === nextUsername.toLowerCase() && user.username !== currentUsername);

  if (duplicateUser) {
    return res.status(409).json({ success: false, message: 'That username is already in use.' });
  }

  targetUser.username = nextUsername;
  if (password) {
    const passwordHash = hashPassword(password);
    targetUser.salt = passwordHash.salt;
    targetUser.hash = passwordHash.hash;
    targetUser.iterations = passwordHash.iterations;
  }

  saveUsers(users);

  req.session.user = { username: targetUser.username, role: targetUser.role || 'user' };
  req.session.isAdmin = isAdminRole(targetUser.role);

  return res.json({ success: true, user: sanitizeUser(normalizeUser(targetUser)), message: 'Account updated successfully.' });
});

app.put('/api/users/:username', requireAuth, (req, res) => {
  const currentUsername = req.session.user.username;
  const currentRole = req.session.user.role || 'user';
  const targetUsername = String(req.params.username || '').trim();
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (!targetUsername) {
    return res.status(400).json({ success: false, message: 'User is required.' });
  }

  const users = getUsers();
  const targetUser = users.find((user) => user.username === targetUsername);

  if (!targetUser) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  const isSelfUpdate = currentUsername === targetUsername;
  const canEditUser = canManageUser({ username: currentUsername, role: currentRole }, normalizeUser(targetUser));

  if (!isSelfUpdate && !canEditUser) {
    return res.status(403).json({ success: false, message: 'You cannot modify this user.' });
  }

  if (isSelfUpdate && currentRole === 'user' && !username && !password) {
    return res.status(400).json({ success: false, message: 'Provide a username or password to update.' });
  }

  const nextUsername = username || targetUser.username;
  const duplicateUser = users.find((user) => user.username.toLowerCase() === nextUsername.toLowerCase() && user.username !== targetUsername);
  if (duplicateUser) {
    return res.status(409).json({ success: false, message: 'That username is already in use.' });
  }

  if (targetUser.role === 'superadmin' && currentRole !== 'superadmin' && !isSelfUpdate) {
    return res.status(403).json({ success: false, message: 'Superadmin accounts are protected.' });
  }

  targetUser.username = nextUsername;
  if (password) {
    const passwordHash = hashPassword(password);
    targetUser.salt = passwordHash.salt;
    targetUser.hash = passwordHash.hash;
    targetUser.iterations = passwordHash.iterations;
  }

  saveUsers(users);

  req.session.user = { username: targetUser.username, role: targetUser.role || 'user' };
  req.session.isAdmin = isAdminRole(targetUser.role);

  return res.json({ success: true, user: sanitizeUser(normalizeUser(targetUser)), message: 'User updated successfully.' });
});

app.delete('/api/users/:username', requireAdmin, (req, res) => {
  const currentRole = req.session.user.role || 'user';
  const targetUsername = String(req.params.username || '').trim();
  const users = getUsers();
  const targetIndex = users.findIndex((user) => user.username === targetUsername);

  if (targetIndex === -1) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  const targetUser = normalizeUser(users[targetIndex]);
  if (targetUser.role === 'superadmin' && currentRole !== 'superadmin') {
    return res.status(403).json({ success: false, message: 'Superadmin accounts cannot be deleted by regular admins.' });
  }

  users.splice(targetIndex, 1);
  saveUsers(users);

  return res.json({ success: true, message: 'User deleted successfully.' });
});

app.get('/api/config', (req, res) => {
  return res.json({ success: true, config: getConfig() });
});

app.get('/api/settings', (req, res) => {
  return res.json({ success: true, config: getConfig() });
});

app.post('/api/admin/config', requireAdmin, upload.single('logoFile'), (req, res) => {
  const currentConfig = getConfig();
  const nextConfig = {
    ...currentConfig,
    ...req.body
  };

  if (req.file) {
    nextConfig.logoUrl = `/uploads/${req.file.filename}`;
  }

  const savedConfig = saveConfig(nextConfig);
  return res.json({ success: true, config: savedConfig, message: 'Settings saved successfully.' });
});

app.get('/api/nodes', async (req, res) => {
  const config = getConfig();

  if (!config.pterodactylApiUrl || !config.apiKey) {
    return res.status(400).json({
      success: false,
      message: 'Panel API URL and API key must be configured before fetching node data.'
    });
  }

  try {
    const response = await axios.get(`${config.pterodactylApiUrl.replace(/\/+$/, '')}/api/application/nodes?include=allocations,servers`, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json'
      },
      timeout: 15000
    });

    const nodes = Array.isArray(response?.data?.data) ? response.data.data : [];
    const applicationServers = await fetchApplicationServers(config.pterodactylApiUrl, config.apiKey);
    const allServersByNode = mapServersByNodeId(applicationServers);

    const verifiedNodes = await Promise.all(
      nodes.map(async (node) => {
        const normalizedNodeId = getNodeId(node);
        const health = await probeNodeHealth(node);
        const status = node?.attributes?.maintenance ? 'maintenance' : health.online ? 'online' : 'offline';
        const mappedServers = (allServersByNode.get(normalizedNodeId || 'unknown') || []).map(normalizeServerDetails);

        return {
          ...node,
          id: normalizedNodeId,
          status,
          servers: mappedServers,
          attributes: {
            ...(node?.attributes || {}),
            id: normalizedNodeId,
            daemon_unreachable: !health.online,
            maintenance: Boolean(node?.attributes?.maintenance || health.maintenance),
            status
          }
        };
      })
    );

    return res.json({ success: true, nodes: verifiedNodes });
  } catch (error) {
    const detail = error?.response?.data?.errors?.[0]?.detail || error.message || 'Unknown panel API error';
    return res.status(error?.response?.status || 500).json({
      success: false,
      message: detail
    });
  }
});

app.get('/api/nodes/:id/servers', async (req, res) => {
  const config = getConfig();

  if (!config.pterodactylApiUrl || !config.apiKey) {
    return res.status(400).json({
      success: false,
      message: 'Panel API URL and API key must be configured before fetching server data.'
    });
  }

  try {
    const servers = await fetchApplicationServers(config.pterodactylApiUrl, config.apiKey);
    const mapped = mapServersByNodeId(servers);
    const normalizedServers = (mapped.get(String(req.params.id)) || []).map(normalizeServerDetails);

    return res.json({ success: true, nodeId: req.params.id, servers: normalizedServers });
  } catch (error) {
    const detail = error?.response?.data?.errors?.[0]?.detail || error.message || 'Unknown panel API error';
    return res.status(error?.response?.status || 500).json({
      success: false,
      message: detail
    });
  }
});

app.use(express.static(PUBLIC_DIR));

app.get('*', (req, res) => {
  if (req.path === '/status') {
    return res.sendFile(path.join(PUBLIC_DIR, 'status.html'));
  }

  if (req.path === '/login') {
    return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  }

  if (req.path === '/admin' || req.path === '/users') {
    return requireAdminPage(req, res, () => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
  }

  return res.redirect('/status');
});

app.listen(PORT, () => {
  console.log(`PricklyStatus Page running on http://localhost:${PORT}`);
});
