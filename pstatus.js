#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const USERS_PATH = path.join(__dirname, 'users.json');

function ensureUsersFile() {
  if (!fs.existsSync(USERS_PATH)) {
    fs.writeFileSync(USERS_PATH, JSON.stringify({ users: [] }, null, 2));
  }
}

function readUsers() {
  ensureUsersFile();
  try {
    const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    let users = Array.isArray(data.users) ? data.users : [];
    const hasExplicitAdmin = users.some((user) => user.role === 'admin' || user.role === 'superadmin');

    if (!hasExplicitAdmin && users.length > 0) {
      users = users.map((user) => ({
        ...user,
        role: user.role || 'admin'
      }));
      saveUsers(users);
    }

    return users;
  } catch (error) {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify({ users }, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 100000;
  const hash = crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), iterations, 64, 'sha512').toString('hex');

  return {
    salt,
    hash,
    iterations
  };
}

module.exports = {
  ensureUsersFile,
  readUsers,
  saveUsers,
  hashPassword
};

async function promptUser(roleLabel) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

  const username = (await ask(`${roleLabel} username: `)).trim();
  const password = await ask(`${roleLabel} password: `);
  const repeatPassword = await ask(`${roleLabel} repeat password: `);
  const confirmation = (await ask(`Are you sure, creating this ${roleLabel.toLowerCase()} (yes/no): `)).trim().toLowerCase();

  rl.close();

  return { username, password, repeatPassword, confirmation };
}

async function main() {
  const [command, action] = process.argv.slice(2);
  const validRoles = new Set(['admin', 'superadmin']);

  if (command !== 'add' || !validRoles.has(action)) {
    console.log('Usage: node pstatus.js add admin | node pstatus.js add superadmin');
    process.exit(1);
  }

  const role = action;
  const roleLabel = role === 'superadmin' ? 'SuperAdmin' : 'Admin';
  const { username, password, repeatPassword, confirmation } = await promptUser(roleLabel);

  if (!username) {
    console.log('Username cannot be empty.');
    process.exit(1);
  }

  if (!password || !repeatPassword) {
    console.log('Password fields cannot be empty.');
    process.exit(1);
  }

  if (password !== repeatPassword) {
    console.log('Passwords do not match.');
    process.exit(1);
  }

  if (confirmation !== 'yes') {
    console.log('User creation cancelled.');
    process.exit(0);
  }

  const users = readUsers();
  const existingUser = users.find((user) => user.username.toLowerCase() === username.toLowerCase());

  if (existingUser) {
    console.log(`User "${username}" already exists.`);
    process.exit(1);
  }

  const securedPassword = hashPassword(password);
  users.push({
    username,
    role,
    salt: securedPassword.salt,
    hash: securedPassword.hash,
    iterations: securedPassword.iterations
  });

  saveUsers(users);
  console.log(`${roleLabel} user "${username}" created successfully.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Error creating user:', error.message);
    process.exit(1);
  });
}
