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

const loginUsername = document.getElementById('loginUsername');
const loginPassword = document.getElementById('loginPassword');

const profilePreview = document.getElementById('profilePreview');
const userTitle = document.getElementById('userTitle');
const statusEl = document.getElementById('status');
const memberCount = document.getElementById('memberCount');
const membersList = document.getElementById('membersList');

const profileFirstName = document.getElementById('profileFirstName');
const profileLastName = document.getElementById('profileLastName');
const profileAvatar = document.getElementById('profileAvatar');
const saveProfileBtn = document.getElementById('saveProfileBtn');
const logoutBtn = document.getElementById('logoutBtn');

const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const messagesEl = document.getElementById('messages');
const textInput = document.getElementById('textInput');
const fileInput = document.getElementById('fileInput');
const sendBtn = document.getElementById('sendBtn');
const fileMeta = document.getElementById('fileMeta');

let socket = null;
let currentUser = null;
let currentRoom = localStorage.getItem('chat-last-room') || '';
let pendingAttachment = null;
let pendingRegisterAvatar = null;
let pendingProfileAvatar = null;

if (currentRoom) roomInput.value = currentRoom;

function setStatus(text) {
  statusEl.textContent = text;
}

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

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

function setUserUI(user) {
  currentUser = user;

  if (!user) {
    userTitle.textContent = 'Not logged in';
    profilePreview.removeAttribute('src');
    profileFirstName.value = '';
    profileLastName.value = '';
    return;
  }

  userTitle.textContent = `${user.displayName} (@${user.username})`;
  profileFirstName.value = user.firstName;
  profileLastName.value = user.lastName;
  if (user.avatarBase64) {
    profilePreview.src = `data:image/*;base64,${user.avatarBase64}`;
  } else {
    profilePreview.removeAttribute('src');
  }
}

function connectSocket() {
  if (!currentUser) return;
  if (socket && socket.connected) return;

  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect_error', (err) => {
    setStatus(err.message || 'Socket connection error.');
  });

  socket.on('chatMessage', addMessage);
  socket.on('membersUpdated', (members) => renderMembers(members || []));
  socket.on('memberJoined', (payload) => addSystemMessage(`${payload.name} joined`));
  socket.on('memberLeft', (payload) => addSystemMessage(`${payload.name} left`));
}

function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg';
  const em = document.createElement('em');
  em.textContent = text;
  div.appendChild(em);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderAttachment(container, attachment) {
  if (!attachment) return;
  const src = `data:${attachment.type};base64,${attachment.data}`;

  if (attachment.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = attachment.name;
    img.loading = 'lazy';
    container.appendChild(img);
    return;
  }

  if (attachment.type.startsWith('video/')) {
    const video = document.createElement('video');
    video.controls = true;
    video.src = src;
    container.appendChild(video);
    return;
  }

  if (attachment.type.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = src;
    container.appendChild(audio);
    return;
  }

  const link = document.createElement('a');
  link.href = src;
  link.download = attachment.name;
  link.textContent = `Download ${attachment.name}`;
  container.appendChild(link);
}

function addMessage(msg) {
  const div = document.createElement('div');
  div.className = 'msg';

  const name = document.createElement('strong');
  name.textContent = msg.user;
  div.appendChild(name);

  if (msg.text) {
    const text = document.createElement('div');
    text.textContent = msg.text;
    div.appendChild(text);
  }

  renderAttachment(div, msg.attachment);

  const time = document.createElement('time');
  time.textContent = fmtTime(msg.at);
  div.appendChild(time);

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMembers(members) {
  memberCount.textContent = `${members.length} online`;
  membersList.innerHTML = '';

  members.forEach((member) => {
    const li = document.createElement('li');
    li.textContent = member.name;
    membersList.appendChild(li);
  });
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

async function loadMe() {
  try {
    const response = await api('/api/auth/me', { method: 'GET' });
    setUserUI(response.user);
    connectSocket();
    setAuthStatus('Logged in.');
    setStatus('Ready');
  } catch {
    setUserUI(null);
    disconnectSocket();
    setAuthStatus('Not logged in.');
    setStatus('Please login first');
  }
}

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();

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

    setUserUI(response.user);
    connectSocket();
    setAuthStatus('Account created and logged in.');
    setStatus('Ready');
    localStorage.setItem('chat-username', response.user.username);
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

    setUserUI(response.user);
    connectSocket();
    setAuthStatus('Logged in.');
    setStatus('Ready');
    localStorage.setItem('chat-username', response.user.username);
  } catch (error) {
    setAuthStatus(error.message);
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    setUserUI(null);
    messagesEl.innerHTML = '';
    renderMembers([]);
    disconnectSocket();
    setAuthStatus('Logged out.');
    setStatus('Please login first');
  }
});

saveProfileBtn.addEventListener('click', async () => {
  if (!currentUser) {
    setStatus('Login first.');
    return;
  }

  try {
    const response = await api('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({
        firstName: profileFirstName.value,
        lastName: profileLastName.value,
        avatarBase64: pendingProfileAvatar !== null ? pendingProfileAvatar : currentUser.avatarBase64,
      }),
    });

    setUserUI(response.user);
    setStatus('Profile updated');
  } catch (error) {
    setStatus(error.message);
  }
});

joinBtn.addEventListener('click', () => {
  if (!socket || !socket.connected) {
    setStatus('Login first.');
    return;
  }

  const roomId = roomInput.value.trim().toLowerCase();
  if (!roomId) {
    setStatus('Enter group ID');
    return;
  }

  localStorage.setItem('chat-last-room', roomId);

  socket.emit('createOrJoinRoom', { roomId }, (res) => {
    if (!res?.ok) {
      setStatus(res?.error || 'Join failed');
      return;
    }

    messagesEl.innerHTML = '';
    res.messages.forEach(addMessage);
    renderMembers(res.members || []);
    setStatus(`Connected to group: ${res.roomId}`);
  });
});

sendBtn.addEventListener('click', () => {
  if (!socket || !socket.connected) {
    setStatus('Login first.');
    return;
  }

  const text = textInput.value.trim();
  socket.emit('chatMessage', { text, attachment: pendingAttachment }, (res) => {
    if (!res?.ok) {
      setStatus(res?.error || 'Send failed.');
      return;
    }

    textInput.value = '';
    fileInput.value = '';
    fileMeta.textContent = '';
    pendingAttachment = null;
  });
});

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const data = await toBase64(file);
    pendingAttachment = {
      name: file.name,
      type: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      data,
      format: 'base64',
    };

    const kb = (file.size / 1024).toFixed(1);
    fileMeta.textContent = `Attached: ${file.name} (${kb} KB).`;
  } catch (error) {
    fileMeta.textContent = error.message;
    pendingAttachment = null;
  }
});

regAvatar.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    pendingRegisterAvatar = null;
    return;
  }

  try {
    pendingRegisterAvatar = await toBase64(file);
    setAuthStatus(`Avatar selected: ${file.name}`);
  } catch (error) {
    setAuthStatus(error.message);
    pendingRegisterAvatar = null;
  }
});

profileAvatar.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    pendingProfileAvatar = null;
    return;
  }

  try {
    pendingProfileAvatar = await toBase64(file);
    setStatus(`Profile avatar selected: ${file.name}`);
  } catch (error) {
    setStatus(error.message);
    pendingProfileAvatar = null;
  }
});

textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendBtn.click();
  }
});

document.querySelectorAll('.emoji').forEach((button) => {
  button.addEventListener('click', () => {
    textInput.value += button.dataset.emoji;
    textInput.focus();
  });
});

tabRegister.addEventListener('click', () => switchTab('register'));
tabLogin.addEventListener('click', () => switchTab('login'));

const rememberedUsername = localStorage.getItem('chat-username');
if (rememberedUsername) loginUsername.value = rememberedUsername;

loadMe();
