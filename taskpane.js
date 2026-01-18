/**
 * AAM Chat - Outlook Add-in
 * Provides real-time chat and presence tracking via SignalR
 */

// Configuration
const CONFIG = {
    intranetUrl: 'https://aamintranettest-aamcompanyllc.msappproxy.net',
    signalRHub: '/chathub',
    apiBase: '/api/calendar',
    chatApi: '/api/chat',
    clientId: '390b1d30-04f2-4063-b28a-4e2c8aefc9bf', // Same as AAM Intranet Calendar app
    graphScopes: ['User.Read', 'Calendars.Read', 'Calendars.Read.Shared']
};

// State
let connection = null;
let currentUser = null;
let currentUserEmail = null;
let directoryUsers = [];
let onlineUsers = new Set();
let userPresence = {};  // email -> { status, calendarStatus, lastSeen }
let conversations = {};  // username -> { messages, unreadCount }
let activeChatUser = null;
let typingTimeout = null;
let isTyping = false;
let accessToken = null;

// Initialize when Office is ready
Office.onReady((info) => {
    if (info.host === Office.HostType.Outlook) {
        console.log('AAM Chat Add-in loaded in Outlook');
        initialize();
    }
});

/**
 * Main initialization
 */
async function initialize() {
    try {
        // Get current user info
        await getCurrentUser();
        
        // Try SSO first, fallback to interactive
        await authenticate();
        
        // Connect to SignalR
        await connectSignalR();
        
        // Load directory
        await loadDirectory();
        
        // Load conversations
        await loadConversations();
        
        // Start presence refresh
        startPresenceRefresh();
        
        // Setup event handlers
        setupEventHandlers();
        
    } catch (error) {
        console.error('Initialization failed:', error);
        showError('Failed to initialize: ' + error.message);
    }
}

/**
 * Get current user from Office context
 */
async function getCurrentUser() {
    return new Promise((resolve, reject) => {
        try {
            const mailbox = Office.context.mailbox;
            if (mailbox && mailbox.userProfile) {
                currentUserEmail = mailbox.userProfile.emailAddress;
                currentUser = {
                    email: currentUserEmail,
                    displayName: mailbox.userProfile.displayName,
                    username: currentUserEmail.split('@')[0]
                };
                console.log('Current user:', currentUser.displayName);
                resolve(currentUser);
            } else {
                reject(new Error('Could not get user profile'));
            }
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Authenticate using SSO or fallback
 */
async function authenticate() {
    try {
        // Try Office SSO first
        const result = await Office.auth.getAccessToken({
            allowSignInPrompt: true,
            allowConsentPrompt: true,
            forMSGraphAccess: true
        });
        
        accessToken = result;
        console.log('SSO authentication successful');
        return accessToken;
        
    } catch (ssoError) {
        console.warn('SSO failed, using fallback:', ssoError);
        
        // For now, we'll proceed without Graph token
        // The SignalR hub will use Windows auth
        accessToken = null;
        return null;
    }
}

/**
 * Connect to SignalR hub
 */
async function connectSignalR() {
    updateConnectionStatus('connecting');
    
    try {
        connection = new signalR.HubConnectionBuilder()
            .withUrl(CONFIG.intranetUrl + CONFIG.signalRHub, {
                withCredentials: true  // Send Windows auth cookies
            })
            .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
            .configureLogging(signalR.LogLevel.Information)
            .build();
        
        // Setup event handlers
        setupSignalRHandlers();
        
        // Start connection
        await connection.start();
        
        console.log('SignalR connected');
        updateConnectionStatus('connected');
        
        // Get initial online users
        const users = await connection.invoke('GetOnlineUsers');
        onlineUsers = new Set(users);
        console.log('Online users:', users);
        
        // Report our presence with source
        await connection.invoke('ReportPresence', 'Outlook', 'Available');
        
    } catch (error) {
        console.error('SignalR connection failed:', error);
        updateConnectionStatus('disconnected');
        showConnectionError();
        throw error;
    }
}

/**
 * Setup SignalR event handlers
 */
function setupSignalRHandlers() {
    // Receive message
    connection.on('ReceiveMessage', (message) => {
        console.log('Message received:', message);
        handleIncomingMessage(message);
    });
    
    // Message sent confirmation
    connection.on('MessageSent', (message) => {
        console.log('Message sent:', message);
        if (activeChatUser && message.recipientUsername.toLowerCase() === activeChatUser.username.toLowerCase()) {
            appendMessage(message, true);
        }
    });
    
    // User online
    connection.on('UserOnline', (username) => {
        console.log('User online:', username);
        onlineUsers.add(username.toLowerCase());
        updateUserPresenceUI(username, 'available');
    });
    
    // User offline
    connection.on('UserOffline', (username) => {
        console.log('User offline:', username);
        onlineUsers.delete(username.toLowerCase());
        updateUserPresenceUI(username, 'offline');
    });
    
    // User typing
    connection.on('UserTyping', (username) => {
        if (activeChatUser && username.toLowerCase() === activeChatUser.username.toLowerCase()) {
            showTypingIndicator(username);
        }
    });
    
    // User stopped typing
    connection.on('UserStoppedTyping', (username) => {
        if (activeChatUser && username.toLowerCase() === activeChatUser.username.toLowerCase()) {
            hideTypingIndicator();
        }
    });
    
    // Messages read
    connection.on('MessagesRead', (username) => {
        // Update read receipts
        console.log('Messages read by:', username);
    });
    
    // Presence update (extended for calendar status)
    connection.on('PresenceUpdate', (username, source, status, calendarStatus) => {
        console.log('Presence update:', username, source, status, calendarStatus);
        userPresence[username.toLowerCase()] = {
            status: status,
            calendarStatus: calendarStatus,
            source: source,
            lastSeen: new Date()
        };
        updateUserPresenceUI(username, status, calendarStatus);
    });
    
    // Reconnection handlers
    connection.onreconnecting((error) => {
        console.log('Reconnecting...', error);
        updateConnectionStatus('connecting');
    });
    
    connection.onreconnected((connectionId) => {
        console.log('Reconnected:', connectionId);
        updateConnectionStatus('connected');
        hideConnectionError();
        
        // Re-report presence
        connection.invoke('ReportPresence', 'Outlook', 'Available');
    });
    
    connection.onclose((error) => {
        console.log('Connection closed:', error);
        updateConnectionStatus('disconnected');
        showConnectionError();
    });
}

/**
 * Load directory users
 */
async function loadDirectory() {
    try {
        const response = await fetch(CONFIG.intranetUrl + CONFIG.apiBase + '/directory', {
            credentials: 'include'
        });
        
        if (response.ok) {
            directoryUsers = await response.json();
            console.log('Loaded directory:', directoryUsers.length, 'users');
            renderUserList();
        } else {
            throw new Error('Failed to load directory');
        }
    } catch (error) {
        console.error('Directory load failed:', error);
        document.getElementById('userList').innerHTML = `
            <div class="empty-state">
                <i class="fas fa-exclamation-circle"></i>
                <div>Could not load directory</div>
            </div>
        `;
    }
}

/**
 * Load existing conversations
 */
async function loadConversations() {
    try {
        const response = await fetch(CONFIG.intranetUrl + CONFIG.chatApi + '/conversations', {
            credentials: 'include'
        });
        
        if (response.ok) {
            const convos = await response.json();
            convos.forEach(c => {
                conversations[c.username.toLowerCase()] = {
                    messages: [],
                    unreadCount: c.unreadCount || 0,
                    lastMessage: c.lastMessage,
                    lastMessageTime: c.lastMessageTime
                };
            });
            
            updateUnreadBadge();
            renderConversationList();
        }
    } catch (error) {
        console.error('Failed to load conversations:', error);
    }
}

/**
 * Load calendar free/busy for users
 */
async function loadCalendarStatus(emails) {
    if (!accessToken) return;
    
    try {
        const now = new Date();
        const endTime = new Date(now.getTime() + 60 * 60 * 1000); // Next hour
        
        const response = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + accessToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                schedules: emails,
                startTime: {
                    dateTime: now.toISOString(),
                    timeZone: 'UTC'
                },
                endTime: {
                    dateTime: endTime.toISOString(),
                    timeZone: 'UTC'
                },
                availabilityViewInterval: 60
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            data.value.forEach(schedule => {
                const email = schedule.scheduleId.toLowerCase();
                const status = schedule.availabilityView === '2' ? 'busy' : 
                              schedule.availabilityView === '1' ? 'tentative' : 'free';
                
                if (!userPresence[email]) {
                    userPresence[email] = {};
                }
                userPresence[email].calendarStatus = status;
            });
            
            renderUserList();
        }
    } catch (error) {
        console.error('Failed to load calendar status:', error);
    }
}

/**
 * Start periodic presence refresh
 */
function startPresenceRefresh() {
    // Refresh presence every 60 seconds
    setInterval(async () => {
        if (connection && connection.state === signalR.HubConnectionState.Connected) {
            // Report our presence
            await connection.invoke('ReportPresence', 'Outlook', 'Available');
            
            // Refresh calendar status for visible users
            const visibleEmails = directoryUsers.slice(0, 20).map(u => u.email).filter(e => e);
            if (visibleEmails.length > 0 && accessToken) {
                await loadCalendarStatus(visibleEmails);
            }
        }
    }, 60000);
}

/**
 * Render user list
 */
function renderUserList() {
    const container = document.getElementById('userList');
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    
    // Filter users
    let filtered = directoryUsers.filter(u => 
        u.username.toLowerCase() !== currentUser.username.toLowerCase()
    );
    
    if (searchTerm) {
        filtered = filtered.filter(u =>
            u.displayName?.toLowerCase().includes(searchTerm) ||
            u.email?.toLowerCase().includes(searchTerm) ||
            u.department?.toLowerCase().includes(searchTerm)
        );
    }
    
    // Sort: online first, then alphabetically
    filtered.sort((a, b) => {
        const aOnline = onlineUsers.has(a.username.toLowerCase()) ? 0 : 1;
        const bOnline = onlineUsers.has(b.username.toLowerCase()) ? 0 : 1;
        if (aOnline !== bOnline) return aOnline - bOnline;
        return (a.displayName || '').localeCompare(b.displayName || '');
    });
    
    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-search"></i>
                <div>No results found</div>
            </div>
        `;
        return;
    }
    
    // Separate online/offline
    const online = filtered.filter(u => onlineUsers.has(u.username.toLowerCase()));
    const offline = filtered.filter(u => !onlineUsers.has(u.username.toLowerCase()));
    
    let html = '';
    
    if (online.length > 0) {
        html += '<div class="section-header">Online Now</div>';
        html += online.map(u => renderUserItem(u, true)).join('');
    }
    
    if (offline.length > 0) {
        html += '<div class="section-header">All People</div>';
        html += offline.map(u => renderUserItem(u, false)).join('');
    }
    
    container.innerHTML = html;
    
    // Add click handlers
    container.querySelectorAll('.user-item').forEach(item => {
        item.addEventListener('click', () => {
            const username = item.dataset.username;
            const user = directoryUsers.find(u => u.username === username);
            if (user) openChat(user);
        });
    });
}

/**
 * Render a single user item
 */
function renderUserItem(user, isOnline) {
    const presence = userPresence[user.email?.toLowerCase()] || {};
    const calStatus = presence.calendarStatus;
    
    let statusClass = isOnline ? 'available' : 'offline';
    let statusText = isOnline ? 'Online' : 'Offline';
    
    // Override with calendar status if busy
    if (isOnline && calStatus === 'busy') {
        statusClass = 'busy';
        statusText = 'In a meeting';
    } else if (isOnline && calStatus === 'tentative') {
        statusClass = 'away';
        statusText = 'Tentative meeting';
    }
    
    const convo = conversations[user.username.toLowerCase()];
    const unread = convo?.unreadCount || 0;
    
    return `
        <div class="user-item" data-username="${user.username}">
            <div class="user-avatar ${statusClass}">
                ${user.initials || '??'}
            </div>
            <div class="user-info">
                <div class="user-name">${user.displayName || user.username}</div>
                <div class="user-status">
                    <i class="fas fa-circle status-icon ${statusClass}"></i>
                    ${statusText}${user.department ? ' · ' + user.department : ''}
                </div>
            </div>
            ${unread > 0 ? `<div class="user-unread">${unread}</div>` : ''}
        </div>
    `;
}

/**
 * Render conversation list
 */
function renderConversationList() {
    const container = document.getElementById('conversationList');
    
    const convos = Object.entries(conversations)
        .filter(([_, c]) => c.lastMessage)
        .sort((a, b) => new Date(b[1].lastMessageTime) - new Date(a[1].lastMessageTime));
    
    if (convos.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-comment-slash"></i>
                <div>No conversations yet</div>
                <div style="font-size: 11px; margin-top: 4px;">Start chatting from the People tab</div>
            </div>
        `;
        return;
    }
    
    container.innerHTML = convos.map(([username, convo]) => {
        const user = directoryUsers.find(u => u.username.toLowerCase() === username.toLowerCase()) || { username, displayName: username };
        const isOnline = onlineUsers.has(username.toLowerCase());
        
        return `
            <div class="user-item" data-username="${username}">
                <div class="user-avatar ${isOnline ? 'available' : 'offline'}">
                    ${user.initials || '??'}
                </div>
                <div class="user-info">
                    <div class="user-name">${user.displayName || username}</div>
                    <div class="user-status" style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        ${convo.lastMessage || ''}
                    </div>
                </div>
                ${convo.unreadCount > 0 ? `<div class="user-unread">${convo.unreadCount}</div>` : ''}
            </div>
        `;
    }).join('');
    
    // Add click handlers
    container.querySelectorAll('.user-item').forEach(item => {
        item.addEventListener('click', () => {
            const username = item.dataset.username;
            const user = directoryUsers.find(u => u.username.toLowerCase() === username.toLowerCase()) || { username, displayName: username };
            openChat(user);
        });
    });
}

/**
 * Open chat with user
 */
async function openChat(user) {
    activeChatUser = user;
    
    // Update header
    document.getElementById('chatAvatar').textContent = user.initials || '??';
    document.getElementById('chatName').textContent = user.displayName || user.username;
    
    const isOnline = onlineUsers.has(user.username.toLowerCase());
    const presence = userPresence[user.email?.toLowerCase()] || {};
    let statusText = isOnline ? 'Online' : 'Offline';
    if (isOnline && presence.calendarStatus === 'busy') {
        statusText = 'In a meeting';
    }
    document.getElementById('chatStatus').textContent = statusText;
    
    // Show chat view
    document.getElementById('peoplePanel').classList.remove('active');
    document.getElementById('chatsPanel').classList.remove('active');
    document.getElementById('chatView').classList.add('active');
    
    // Load message history
    await loadMessageHistory(user.username);
    
    // Mark as read
    markConversationRead(user.username);
    
    // Focus input
    document.getElementById('messageInput').focus();
}

/**
 * Load message history
 */
async function loadMessageHistory(username) {
    const container = document.getElementById('chatMessages');
    container.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading messages...</div>';
    
    try {
        const response = await fetch(
            `${CONFIG.intranetUrl}${CONFIG.chatApi}/messages/${encodeURIComponent(username)}?limit=50`,
            { credentials: 'include' }
        );
        
        if (response.ok) {
            const messages = await response.json();
            
            if (messages.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <i class="fas fa-comment"></i>
                        <div>No messages yet</div>
                        <div style="font-size: 11px; margin-top: 4px;">Say hi!</div>
                    </div>
                `;
                return;
            }
            
            container.innerHTML = '';
            messages.forEach(msg => {
                const isSent = msg.senderUsername.toLowerCase() === currentUser.username.toLowerCase();
                appendMessage(msg, isSent);
            });
            
            // Scroll to bottom
            container.scrollTop = container.scrollHeight;
        }
    } catch (error) {
        console.error('Failed to load messages:', error);
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-exclamation-circle"></i>
                <div>Could not load messages</div>
            </div>
        `;
    }
}

/**
 * Append message to chat
 */
function appendMessage(message, isSent) {
    const container = document.getElementById('chatMessages');
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    
    const time = new Date(message.sentAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit'
    });
    
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.innerHTML = `
        <div class="message-content">${escapeHtml(message.content)}</div>
        <div class="message-time">${time}</div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

/**
 * Send message
 */
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const content = input.value.trim();
    
    if (!content || !activeChatUser || !connection) return;
    
    try {
        await connection.invoke('SendMessage', activeChatUser.username, content);
        input.value = '';
        input.style.height = 'auto';
        
        // Stop typing indicator
        if (isTyping) {
            await connection.invoke('StopTyping', activeChatUser.username);
            isTyping = false;
        }
    } catch (error) {
        console.error('Failed to send message:', error);
        alert('Failed to send message');
    }
}

/**
 * Handle incoming message
 */
function handleIncomingMessage(message) {
    const senderUsername = message.senderUsername.toLowerCase();
    
    // Initialize conversation if needed
    if (!conversations[senderUsername]) {
        conversations[senderUsername] = { messages: [], unreadCount: 0 };
    }
    
    // Add to conversation
    conversations[senderUsername].messages.push(message);
    conversations[senderUsername].lastMessage = message.content;
    conversations[senderUsername].lastMessageTime = message.sentAt;
    
    // If chat is open with this user, show message and mark as read
    if (activeChatUser && senderUsername === activeChatUser.username.toLowerCase()) {
        appendMessage(message, false);
        markConversationRead(senderUsername);
    } else {
        // Increment unread
        conversations[senderUsername].unreadCount++;
        updateUnreadBadge();
        
        // Show desktop notification if available
        showNotification(message);
    }
    
    // Update conversation list
    renderConversationList();
    renderUserList();
}

/**
 * Mark conversation as read
 */
async function markConversationRead(username) {
    const convo = conversations[username.toLowerCase()];
    if (convo) {
        convo.unreadCount = 0;
    }
    
    updateUnreadBadge();
    
    // Notify server
    if (connection) {
        try {
            await connection.invoke('MarkAsRead', username);
        } catch (e) {
            console.error('Failed to mark as read:', e);
        }
    }
}

/**
 * Update unread badge
 */
function updateUnreadBadge() {
    const total = Object.values(conversations).reduce((sum, c) => sum + (c.unreadCount || 0), 0);
    const badge = document.getElementById('unreadBadge');
    
    if (total > 0) {
        badge.textContent = total > 99 ? '99+' : total;
        badge.style.display = 'inline';
    } else {
        badge.style.display = 'none';
    }
}

/**
 * Show notification
 */
function showNotification(message) {
    // Try Office notification first
    if (Office.context.mailbox && Office.context.mailbox.displayNotificationMessage) {
        const user = directoryUsers.find(u => u.username.toLowerCase() === message.senderUsername.toLowerCase());
        const name = user?.displayName || message.senderUsername;
        
        Office.context.mailbox.item.notificationMessages.addAsync('chatMsg', {
            type: 'informationalMessage',
            message: `${name}: ${message.content.substring(0, 50)}${message.content.length > 50 ? '...' : ''}`,
            icon: 'icon-16',
            persistent: false
        });
    }
}

/**
 * Close chat and go back to list
 */
function closeChat() {
    activeChatUser = null;
    document.getElementById('chatView').classList.remove('active');
    document.getElementById('peoplePanel').classList.add('active');
    
    // Reset tabs to active state
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="people"]').classList.add('active');
}

/**
 * Switch tabs
 */
function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(tabName + 'Panel').classList.add('active');
    
    document.getElementById('chatView').classList.remove('active');
}

/**
 * Update connection status indicator
 */
function updateConnectionStatus(status) {
    const dot = document.getElementById('connectionStatus');
    const text = document.getElementById('connectionText');
    
    dot.className = 'status-dot ' + status;
    
    switch (status) {
        case 'connected':
            text.textContent = 'Connected';
            break;
        case 'connecting':
            text.textContent = 'Connecting...';
            break;
        case 'disconnected':
            text.textContent = 'Disconnected';
            break;
    }
}

/**
 * Update user presence in UI
 */
function updateUserPresenceUI(username, status, calendarStatus) {
    // Re-render lists to update presence
    renderUserList();
    renderConversationList();
    
    // Update chat header if viewing this user
    if (activeChatUser && activeChatUser.username.toLowerCase() === username.toLowerCase()) {
        const statusEl = document.getElementById('chatStatus');
        if (status === 'available' || onlineUsers.has(username.toLowerCase())) {
            if (calendarStatus === 'busy') {
                statusEl.textContent = 'In a meeting';
            } else {
                statusEl.textContent = 'Online';
            }
        } else {
            statusEl.textContent = 'Offline';
        }
    }
}

/**
 * Show typing indicator
 */
function showTypingIndicator(username) {
    const indicator = document.getElementById('typingIndicator');
    const text = document.getElementById('typingText');
    const user = directoryUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
    
    text.textContent = `${user?.displayName || username} is typing...`;
    indicator.style.display = 'block';
    
    // Auto-hide after 3 seconds
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(hideTypingIndicator, 3000);
}

/**
 * Hide typing indicator
 */
function hideTypingIndicator() {
    document.getElementById('typingIndicator').style.display = 'none';
}

/**
 * Show connection error
 */
function showConnectionError() {
    document.getElementById('connectionError').classList.add('show');
}

/**
 * Hide connection error
 */
function hideConnectionError() {
    document.getElementById('connectionError').classList.remove('show');
}

/**
 * Reconnect to SignalR
 */
async function reconnect() {
    hideConnectionError();
    try {
        if (connection) {
            await connection.stop();
        }
        await connectSignalR();
    } catch (e) {
        showConnectionError();
    }
}

/**
 * Setup event handlers
 */
function setupEventHandlers() {
    // Search input
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', () => {
        renderUserList();
    });
    
    // Message input
    const messageInput = document.getElementById('messageInput');
    
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    
    messageInput.addEventListener('input', async () => {
        // Auto-resize
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 100) + 'px';
        
        // Send typing indicator
        if (activeChatUser && connection && messageInput.value.trim()) {
            if (!isTyping) {
                isTyping = true;
                await connection.invoke('StartTyping', activeChatUser.username);
            }
            
            // Reset typing timeout
            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(async () => {
                if (isTyping && activeChatUser) {
                    await connection.invoke('StopTyping', activeChatUser.username);
                    isTyping = false;
                }
            }, 2000);
        }
    });
}

/**
 * Action buttons
 */
function callUser() {
    if (!activeChatUser) return;
    const user = directoryUsers.find(u => u.username === activeChatUser.username);
    if (user?.zoomPhone) {
        window.open(`zoomphonecall://${user.zoomPhone}`, '_blank');
    }
}

function videoUser() {
    if (!activeChatUser) return;
    window.open(`https://aamcompany.zoom.us/start/videomeeting`, '_blank');
}

function emailUser() {
    if (!activeChatUser?.email) return;
    window.open(`mailto:${activeChatUser.email}`, '_blank');
}

/**
 * Utility: Escape HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Show error message
 */
function showError(message) {
    console.error(message);
    // Could show in UI
}


