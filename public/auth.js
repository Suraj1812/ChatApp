const tabRegister = document.getElementById('tabRegister');
const tabLogin = document.getElementById('tabLogin');
const registerForm = document.getElementById('registerForm');
const loginForm = document.getElementById('loginForm');
const authStatus = document.getElementById('authStatus');

const regFirstName = document.getElementById('regFirstName');
const regLastName = document.getElementById('regLastName');
const regUsername = document.getElementById('regUsername');
const regPassword = document.getElementById('regPassword');
const regAvatar = document.getElementById('regAvatar');
const regAvatarPreview = document.getElementById('regAvatarPreview');
const toggleRegPassword = document.getElementById('toggleRegPassword');

const loginUsername = document.getElementById('loginUsername');
const loginPassword = document.getElementById('loginPassword');
const toggleLoginPassword = document.getElementById('toggleLoginPassword');

let pendingRegisterAvatar = null;

function setAuthStatus(text) {
  authStatus.textContent = text;
}

function switchTab(mode) {
  const registerMode = mode === 'register';
  tabRegister.classList.toggle('active', registerMode);
  tabLogin.classList.toggle('active', !registerMode);
  registerForm.classList.toggle('hidden', !registerMode);
  loginForm.classList.toggle('hidden', registerMode);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const parts = dataUrl.split(',');
      resolve(parts[1] || '');
    };
    reader.onerror = () => reject(new Error('Unable to read file.'));
    reader.readAsDataURL(file);
  });
}

function togglePassword(inputEl, buttonEl) {
  const isHidden = inputEl.type === 'password';
  inputEl.type = isHidden ? 'text' : 'password';
  buttonEl.innerHTML = isHidden
    ? '<i class="fa-regular fa-eye-slash"></i>'
    : '<i class="fa-regular fa-eye"></i>';
}

function validateRegisterInput() {
  const firstName = String(regFirstName.value || '').trim();
  const lastName = String(regLastName.value || '').trim();
  const username = String(regUsername.value || '').trim().toLowerCase();
  const password = String(regPassword.value || '');

  if (!/^[a-zA-Z][a-zA-Z '\-]{0,39}$/.test(firstName)) {
    return 'First name invalid. Use letters only, max 40 chars.';
  }
  if (!/^[a-zA-Z][a-zA-Z '\-]{0,39}$/.test(lastName)) {
    return 'Last name invalid. Use letters only, max 40 chars.';
  }
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    return 'Username invalid. Use lowercase letters, numbers, underscore (3-30).';
  }
  if (password.length < 8 || password.length > 128) {
    return 'Password must be 8 to 128 characters.';
  }
  return '';
}

async function bootstrap() {
  try {
    await api('/api/auth/me', { method: 'GET' });
    location.href = '/chat.html';
  } catch {
    const rememberedUsername = localStorage.getItem('chat-username');
    if (rememberedUsername) loginUsername.value = rememberedUsername;
  }
}

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const validationError = validateRegisterInput();
  if (validationError) {
    setAuthStatus(validationError);
    return;
  }

  try {
    const response = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        firstName: regFirstName.value,
        lastName: regLastName.value,
        username: regUsername.value,
        password: regPassword.value,
        avatarBase64: pendingRegisterAvatar,
      }),
    });

    localStorage.setItem('chat-username', response.user.username);
    location.href = '/chat.html';
  } catch (error) {
    setAuthStatus(error.message);
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const response = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: loginUsername.value,
        password: loginPassword.value,
      }),
    });

    localStorage.setItem('chat-username', response.user.username);
    location.href = '/chat.html';
  } catch (error) {
    setAuthStatus(error.message);
  }
});

regAvatar.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    pendingRegisterAvatar = null;
    regAvatarPreview.classList.add('hidden');
    regAvatarPreview.removeAttribute('src');
    return;
  }

  try {
    pendingRegisterAvatar = await toBase64(file);
    regAvatarPreview.src = URL.createObjectURL(file);
    regAvatarPreview.classList.remove('hidden');
    setAuthStatus(`Avatar selected: ${file.name}`);
  } catch (error) {
    pendingRegisterAvatar = null;
    regAvatarPreview.classList.add('hidden');
    regAvatarPreview.removeAttribute('src');
    setAuthStatus(error.message);
  }
});

tabRegister.addEventListener('click', () => switchTab('register'));
tabLogin.addEventListener('click', () => switchTab('login'));
toggleRegPassword.addEventListener('click', () => togglePassword(regPassword, toggleRegPassword));
toggleLoginPassword.addEventListener('click', () =>
  togglePassword(loginPassword, toggleLoginPassword)
);

bootstrap();
