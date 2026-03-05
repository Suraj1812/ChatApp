const profilePreview = document.getElementById('profilePreview');
const userTitle = document.getElementById('userTitle');
const statusEl = document.getElementById('status');

const chatsList = document.getElementById('chatsList');
const chatsSection = document.getElementById('chatsSection');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const railChatsBtn = document.getElementById('railChatsBtn');
const railProfileBtn = document.getElementById('railProfileBtn');
const mobileBackBtn = document.getElementById('mobileBackBtn');

const profileFirstName = document.getElementById('profileFirstName');
const profileLastName = document.getElementById('profileLastName');
const profileBio = document.getElementById('profileBio');
const profileAvatar = document.getElementById('profileAvatar');
const profileAvatarPreview = document.getElementById('profileAvatarPreview');
const saveProfileBtn = document.getElementById('saveProfileBtn');
const logoutBtn = document.getElementById('logoutBtn');


const messagesEl = document.getElementById('messages');
const textInput = document.getElementById('textInput');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const sendBtn = document.getElementById('sendBtn');
const fileMeta = document.getElementById('fileMeta');
const chatFilePreview = document.getElementById('chatFilePreview');

const profileModal = document.getElementById('profileModal');
const userProfileModal = document.getElementById('userProfileModal');
const logoutModal = document.getElementById('logoutModal');
const confirmLogoutBtn = document.getElementById('confirmLogoutBtn');

const viewProfileAvatar = document.getElementById('viewProfileAvatar');
const viewProfileName = document.getElementById('viewProfileName');
const viewProfileUsername = document.getElementById('viewProfileUsername');
const viewProfileBio = document.getElementById('viewProfileBio');

let socket = null;
let currentUser = null;
let currentRoom = '';
let currentRoomInfo = null;
let currentPeerUserId = '';
let pendingAttachment = null;
let pendingProfileAvatar = null;
let members = [];
let searchTimer = null;
let sidebarCache = { chats: [] };


function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function isMobileView() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function setMobileChatOpen(isOpen) {
  if (!isMobileView()) {
    document.body.classList.remove('mobile-chat-open');
    return;
  }
  document.body.classList.toggle('mobile-chat-open', Boolean(isOpen));
}

function updateFooterActionIcon() {
  const hasRoom = Boolean(currentRoom);
  const hasContent = Boolean(textInput.value.trim()) || Boolean(pendingAttachment);
  sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
  sendBtn.disabled = !hasRoom || !hasContent;
  sendBtn.style.opacity = !hasRoom || !hasContent ? '0.6' : '1';
}

function updateComposerState() {
  const hasRoom = Boolean(currentRoom);
  textInput.disabled = !hasRoom;
  attachBtn.disabled = !hasRoom;
  fileInput.disabled = !hasRoom;
  textInput.placeholder = hasRoom ? 'Type a message' : 'Open a chat to start messaging';
  updateFooterActionIcon();
}

function fmtTime(ts) {
  const date = new Date(ts);
  const now = new Date();

  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

  const timePart = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (dayStart === todayStart) return `Today, ${timePart}`;
  if (dayStart === yesterdayStart) return `Yesterday, ${timePart}`;

  const datePart = date.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  });
  return `${datePart}, ${timePart}`;
}

function fmtSidebarTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function fmtSidebarDate(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

  if (dayStart === todayStart) return 'Today';
  if (dayStart === yesterdayStart) return 'Yesterday';

  return date.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function openModal(modal) {
  modal.classList.remove('hidden');
}

function closeModal(modal) {
  modal.classList.add('hidden');
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

function renderSelectedFilePreview(file, target) {
  if (!file || !target) return;
  const url = URL.createObjectURL(file);
  target.classList.remove('hidden');

  if (file.type.startsWith('image/')) {
    target.innerHTML = `<img src="${url}" alt="${file.name}" />`;
    return;
  }

  if (file.type.startsWith('video/')) {
    target.innerHTML = `<video controls src="${url}"></video>`;
    return;
  }

  if (file.type.startsWith('audio/')) {
    target.innerHTML = `<audio controls src="${url}"></audio>`;
    return;
  }

  target.innerHTML = `<div class="file-chip"><i class="fa-solid fa-file"></i> ${file.name}</div>`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setUserUI(user) {
  currentUser = user;
  userTitle.textContent = `${user.displayName} (@${user.username})`;
  profileFirstName.value = user.firstName;
  profileLastName.value = user.lastName;
  profileBio.value = user.bio || '';

  if (user.avatarBase64) {
    profilePreview.src = `data:image/*;base64,${user.avatarBase64}`;
    profileAvatarPreview.src = `data:image/*;base64,${user.avatarBase64}`;
    profileAvatarPreview.classList.remove('hidden');
  } else {
    profilePreview.removeAttribute('src');
    profileAvatarPreview.classList.add('hidden');
    profileAvatarPreview.removeAttribute('src');
  }
}

function setActiveChatHeader(room, memberRows = []) {
  if (!currentUser || !room) return;

  const peer = memberRows.find((m) => m.id !== currentUser.id);
  currentPeerUserId = peer?.id || '';
  const peerName = peer?.name || (room.name && !String(room.name).startsWith('dm_') ? room.name : 'Chat');
  const peerUsername = peer?.username ? ` (@${peer.username})` : '';

  userTitle.textContent = `${peerName}${peerUsername}`;
  setStatus(peer?.online ? 'online' : '');

  if (room.avatarBase64) {
    profilePreview.src = `data:image/*;base64,${room.avatarBase64}`;
    profilePreview.classList.remove('hidden');
    return;
  }

  if (peer?.avatarBase64) {
    profilePreview.src = `data:image/*;base64,${peer.avatarBase64}`;
    profilePreview.classList.remove('hidden');
    return;
  }

  profilePreview.removeAttribute('src');
  profilePreview.classList.add('hidden');
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
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
  div.className = `msg ${msg.userId === currentUser?.id ? 'mine' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const editedLabel = msg.editedAt ? ' · edited' : '';
  const senderLabel = msg.userId === currentUser?.id ? 'You' : msg.user;
  meta.innerHTML = `<strong>${senderLabel}</strong> <span>${fmtTime(msg.at)}${editedLabel}</span>`;

  div.appendChild(meta);

  if (msg.text) {
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = msg.text;
    div.appendChild(text);
  }

  renderAttachment(div, msg.attachment);

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderSideList(container, rooms, type) {
  container.innerHTML = '';

  if (!rooms.length) {
    return;
  }

  rooms.forEach((room) => {
    const lastTs = room.lastActivity || null;
    const item = document.createElement('button');
    item.className = `side-item ${currentRoom === room.id ? 'active' : ''}`;
    item.innerHTML = `
      <div class="side-item-row">
        <img class="avatar side-avatar ${room.avatarBase64 ? '' : 'hidden'}" data-peer-id="${room.peerId || ''}" alt="profile" ${room.avatarBase64 ? `src="data:image/*;base64,${room.avatarBase64}"` : ''} />
        <div class="side-item-main">
          <div class="side-item-title">${room.name || room.id}</div>
          <div class="side-item-sub">${room.lastSender ? `${room.lastSender}: ` : ''}${room.lastMessage || room.bio || ''}</div>
        </div>
        <div class="side-item-meta">
          <span class="side-item-time">${fmtSidebarTime(lastTs)}</span>
          <span class="side-item-date">${fmtSidebarDate(lastTs)}</span>
        </div>
      </div>
    `;
    const avatarEl = item.querySelector('.side-avatar');
    if (avatarEl) {
      avatarEl.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const peerId = avatarEl.getAttribute('data-peer-id');
        if (peerId) viewUserProfile(peerId);
      });
    }
    item.addEventListener('click', () => joinRoom(room.id));
    container.appendChild(item);
  });
}

function applySidebarFilter() {
  const chats = sidebarCache.chats || [];

  chatsSection.style.display = '';
  renderSideList(chatsList, chats, 'chats');
}

async function loadSidebar() {
  try {
    const data = await api('/api/sidebar', { method: 'GET' });
    sidebarCache = { chats: data.chats || [] };
    applySidebarFilter();
  } catch (error) {
    setStatus(error.message);
  }
}

function renderMembers(memberRows) {
  members = memberRows;
  if (currentRoomInfo) {
    setActiveChatHeader(currentRoomInfo, memberRows);
  }
}

async function joinRoom(roomId) {
  if (!socket || !socket.connected) {
    setStatus('Socket not connected');
    return;
  }

  socket.emit(
    'createOrJoinRoom',
    { roomId },
    (res) => {
      if (!res?.ok) {
        if (localStorage.getItem('chat-last-room') === roomId) {
          localStorage.removeItem('chat-last-room');
        }
        setStatus(res?.error || 'Join failed');
        return;
      }

      currentRoom = res.room.id;
      currentRoomInfo = res.room;
      localStorage.setItem('chat-last-room', currentRoom);

      messagesEl.innerHTML = '';
      res.messages.forEach(addMessage);
      renderMembers(res.members || []);
      setActiveChatHeader(res.room, res.members || []);
      setMobileChatOpen(true);
      setStatus('');
      updateComposerState();
      loadSidebar();
    }
  );
}

async function searchDiscovery(term) {
  if (!term) {
    searchResults.innerHTML = '';
    return;
  }

  try {
    const data = await api(`/api/discovery?q=${encodeURIComponent(term)}`, { method: 'GET' });
    searchResults.innerHTML = '';

    [...(data.people || [])].forEach((person) => {
      const item = document.createElement('div');
      item.className = 'search-item';
      item.innerHTML = `<div><strong>${person.name}</strong><small>@${person.username}</small></div>`;

      const actions = document.createElement('div');
      actions.className = 'search-actions';

      const msgBtn = document.createElement('button');
      msgBtn.textContent = 'Chat';
      msgBtn.className = 'secondary tiny';
      msgBtn.addEventListener('click', () => {
        socket.emit('openDirectChat', { targetUserId: person.id }, (res) => {
          if (!res?.ok) {
            setStatus(res?.error || 'Unable to open chat');
            return;
          }
          joinRoom(res.roomId);
          searchResults.innerHTML = '';
          searchInput.value = '';
        });
      });

      const profileBtn = document.createElement('button');
      profileBtn.textContent = 'Profile';
      profileBtn.className = 'secondary tiny';
      profileBtn.addEventListener('click', () => viewUserProfile(person.id));

      actions.appendChild(msgBtn);
      actions.appendChild(profileBtn);
      item.appendChild(actions);
      searchResults.appendChild(item);
    });

    if (!searchResults.children.length) {
      searchResults.innerHTML = '<div class="empty-note">No people found</div>';
    }
  } catch (error) {
    setStatus(error.message);
  }
}

async function viewUserProfile(userId) {
  try {
    const data = await api(`/api/users/${encodeURIComponent(userId)}`, { method: 'GET' });
    const p = data.profile;
    viewProfileName.textContent = p.name;
    viewProfileUsername.textContent = `@${p.username}`;
    viewProfileBio.textContent = p.bio || 'No bio set';
    if (p.avatarBase64) {
      viewProfileAvatar.src = `data:image/*;base64,${p.avatarBase64}`;
    } else {
      viewProfileAvatar.removeAttribute('src');
    }
    openModal(userProfileModal);
  } catch (error) {
    setStatus(error.message);
  }
}

function connectSocket() {
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect_error', (err) => setStatus(err.message || 'Socket connection error.'));

  socket.on('chatMessage', addMessage);
  socket.on('membersUpdated', (payload) => renderMembers(payload || []));
  socket.on('memberJoined', (payload) => addSystemMessage(`${payload.name} joined`));
  socket.on('memberLeft', (payload) => addSystemMessage(`${payload.name} left`));
}

async function loadMeOrRedirect() {
  try {
    const response = await api('/api/auth/me', { method: 'GET' });
    setUserUI(response.user);
    connectSocket();
    setStatus('');
    await loadSidebar();

    const remembered = localStorage.getItem('chat-last-room');
    if (remembered) {
      joinRoom(remembered);
    }
  } catch {
    location.href = '/';
  }
}

saveProfileBtn.addEventListener('click', async () => {
  try {
    const response = await api('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({
        firstName: profileFirstName.value,
        lastName: profileLastName.value,
        bio: profileBio.value,
        avatarBase64: pendingProfileAvatar !== null ? pendingProfileAvatar : currentUser.avatarBase64,
      }),
    });

    setUserUI(response.user);
    closeModal(profileModal);
    setStatus('Profile updated');
  } catch (error) {
    setStatus(error.message);
  }
});

async function performLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    location.href = '/';
  }
}

logoutBtn.addEventListener('click', () => {
  openModal(logoutModal);
});

confirmLogoutBtn.addEventListener('click', async () => {
  confirmLogoutBtn.disabled = true;
  await performLogout();
});

profileAvatar.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    pendingProfileAvatar = null;
    if (currentUser?.avatarBase64) {
      profileAvatarPreview.src = `data:image/*;base64,${currentUser.avatarBase64}`;
      profileAvatarPreview.classList.remove('hidden');
    } else {
      profileAvatarPreview.classList.add('hidden');
      profileAvatarPreview.removeAttribute('src');
    }
    return;
  }

  try {
    pendingProfileAvatar = await toBase64(file);
    profileAvatarPreview.src = URL.createObjectURL(file);
    profileAvatarPreview.classList.remove('hidden');
    setStatus(`Profile avatar selected: ${file.name}`);
  } catch (error) {
    pendingProfileAvatar = null;
    profileAvatarPreview.classList.add('hidden');
    profileAvatarPreview.removeAttribute('src');
    setStatus(error.message);
  }
});

sendBtn.addEventListener('click', () => {
  if (!socket || !socket.connected || !currentRoom) {
    setStatus('Join a room first.');
    return;
  }

  const text = textInput.value.trim();
  if (!text && !pendingAttachment) {
    setStatus('Type a message or attach a file.');
    return;
  }

  socket.emit('chatMessage', { text, attachment: pendingAttachment }, (res) => {
    if (!res?.ok) {
      setStatus(res?.error || 'Send failed.');
      return;
    }

    textInput.value = '';
    fileInput.value = '';
    fileMeta.textContent = '';
    chatFilePreview.classList.add('hidden');
    chatFilePreview.innerHTML = '';
    pendingAttachment = null;
    updateFooterActionIcon();
    loadSidebar();
  });
});

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    chatFilePreview.classList.add('hidden');
    chatFilePreview.innerHTML = '';
    pendingAttachment = null;
    updateFooterActionIcon();
    return;
  }

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
    renderSelectedFilePreview(file, chatFilePreview);
    updateFooterActionIcon();
  } catch (error) {
    fileMeta.textContent = error.message;
    pendingAttachment = null;
    chatFilePreview.classList.add('hidden');
    chatFilePreview.innerHTML = '';
    updateFooterActionIcon();
  }
});

textInput.addEventListener('input', updateFooterActionIcon);
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendBtn.click();
  }
});

attachBtn.addEventListener('click', () => {
  if (!currentRoom) {
    setStatus('Open a chat first.');
    return;
  }
  fileInput.click();
});
profilePreview.addEventListener('click', () => {
  if (currentPeerUserId) viewUserProfile(currentPeerUserId);
});

railChatsBtn.addEventListener('click', () => {
  railChatsBtn.classList.add('active');
  railProfileBtn.classList.remove('active');
  closeModal(profileModal);
});
railProfileBtn.addEventListener('click', () => {
  railProfileBtn.classList.add('active');
  railChatsBtn.classList.remove('active');
  openModal(profileModal);
});

mobileBackBtn.addEventListener('click', () => {
  setMobileChatOpen(false);
});

window.addEventListener('resize', () => {
  if (!isMobileView()) {
    document.body.classList.remove('mobile-chat-open');
    return;
  }
  setMobileChatOpen(Boolean(currentRoom));
});

document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => {
    const modalId = button.getAttribute('data-close');
    const modal = document.getElementById(modalId);
    if (modal) closeModal(modal);
  });
});

document.querySelectorAll('.modal').forEach((modal) => {
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal(modal);
  });
});

searchInput.addEventListener('input', () => {
  const term = searchInput.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchDiscovery(term), 250);
});

updateComposerState();
setMobileChatOpen(false);
loadMeOrRedirect();
